// A17 / S10 contention harness (DEC-0022): runs the real workflow_job migrations and the
// real jobs/lease.ts store against pinned PGlite (devDependency, exact version), so the
// claim, fencing and submission rules are checked as SQL, not as a fake that assumes
// atomicity. PGlite has one backend, so "concurrent" calls are queued and run in some
// serial order; the assertions hold for every order. On hosted Postgres each RPC is one
// UPDATE, whose row lock and WHERE re-check give the same single winner under true
// concurrency. Offline only: no network, no .env, no hosted database.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  createJobLeaseStore, executionFromClaim, JOB_EXHAUSTED_ERROR, JOB_LEASE_SECONDS, MAX_JOB_CLAIMS, MAX_JOB_EXECUTION_ATTEMPTS,
  type JobClaim, type JobLeaseRpc,
} from './jobs/lease.js';

const CHAIN = [
  'supabase/tests/workflow_job_fixture_schema.sql',
  'supabase/migrations/20260601120000_create_workflow_usage_table.sql',
  'supabase/migrations/20260601121000_add_latency_to_workflow_usage.sql',
  'supabase/migrations/20260601122000_create_workflow_job_table.sql',
  'supabase/migrations/20260602123000_enable_backend_table_rls.sql',
  'supabase/migrations/20261009120100_reliability_transcript_checkpoint_and_active_job_uniq.sql',
];
const S10 = 'supabase/migrations/20261026120000_workflow_job_s10_lease_and_resume.sql';
const TABLE_FUNCTIONS = new Set(['workflow_job_claim']);
const sql = (path: string) => readFile(new URL('../../' + path, import.meta.url), 'utf8');

async function database(options: { s10: boolean }) {
  const db = new PGlite();
  for (const path of CHAIN) await db.exec(await sql(path));
  if (options.s10) {
    await db.exec(await sql(S10));
    // Re-applying must be a no-op (the operator may run the file twice).
    await db.exec(await sql(S10));
  }
  return db;
}

// The PostgREST RPC contract the backend relies on: named arguments, a set-returning
// function answers an array, a scalar function answers the scalar, errors carry the code.
function pgliteRpc(db: PGlite): JobLeaseRpc {
  return async (name, args) => {
    const keys = Object.keys(args);
    const params = keys.map((key) => {
      const value = args[key];
      return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
    });
    const named = keys.map((key, index) => `${key} => $${index + 1}`).join(', ');
    try {
      if (TABLE_FUNCTIONS.has(name)) {
        return { data: (await db.query(`select * from public.${name}(${named})`, params)).rows, error: null };
      }
      const { rows } = await db.query<{ v: unknown }>(`select public.${name}(${named}) as v`, params);
      return { data: rows[0]?.v ?? null, error: null };
    } catch (error) {
      const e = error as { code?: string; message: string };
      return { data: null, error: { code: e.code, message: e.message } };
    }
  };
}

async function asRole<T>(db: PGlite, role: string, run: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try { return await run(); } finally { await db.exec('reset role'); }
}

async function insertJob(db: PGlite, fields: { status?: string; stage?: string; noteId?: string; updatedAgo?: string; language?: string } = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.workflow_job (user_id, note_id, type, status, stage, progress, request, updated_at)
     values ('fixture-user', $1, 'summarize_audio', $2, $3, 0, jsonb_build_object('noteId', 'fixture', 'language', $5::text), now() - $4::interval)
     returning id`,
    [fields.noteId ?? `note-${Math.random().toString(36).slice(2)}`, fields.status ?? 'queued', fields.stage ?? 'queued', fields.updatedAgo ?? '0 seconds', fields.language ?? 'en'],
  );
  return rows[0]!.id;
}

const row = async (db: PGlite, id: string) => (await db.query<Record<string, any>>('select * from public.workflow_job where id = $1', [id])).rows[0]!;
const expireLease = (db: PGlite, id: string) => db.query("update public.workflow_job set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [id]);

async function race(db: PGlite, id: string, mode: 'start' | 'recover', workers = 8) {
  const rpc = pgliteRpc(db);
  const outcomes = await asRole(db, 'service_role', () => Promise.all(
    Array.from({ length: workers }, (_, index) => createJobLeaseStore(rpc, `worker-${index}`).claim(id, mode)),
  ));
  const winners = outcomes.flatMap((outcome, index) => (outcome.kind === 'claimed' ? [{ owner: `worker-${index}`, claim: outcome.claim }] : []));
  for (const outcome of outcomes) assert.ok(outcome.kind === 'claimed' || outcome.kind === 'not-claimable', `unexpected claim outcome ${JSON.stringify(outcome)}`);
  assert.ok(winners.length <= 1, `at most one winner, got ${winners.length}`);
  return winners;
}

test('S10 lease SQL on an isolated PostgreSQL engine', async (t) => {
  const db = await database({ s10: true });
  t.after(() => db.close());
  const rpc = pgliteRpc(db);
  const store = (owner: string) => createJobLeaseStore(rpc, owner);
  const service = <T>(run: () => Promise<T>) => asRole(db, 'service_role', run);

  await t.test('pre-S10 inserts and id-only updates keep working with defaulted S10 columns', async () => {
    const id = await insertJob(db);
    await db.query("update public.workflow_job set status = 'failed', stage = 'failed', error = 'legacy', updated_at = now() where id = $1", [id]);
    const r = await row(db, id);
    assert.deepEqual(
      [r.status, r.lease_owner, r.lease_expires_at, r.execution_generation, r.attempt_count, r.assembly_transcript_id, r.transcript_submission_state, r.transcript_submission_count],
      ['failed', null, null, 0, 0, null, 'none', 0],
    );
  });

  await t.test('start: exactly one of eight concurrent workers claims a fresh row, with a database-time lease', async () => {
    const id = await insertJob(db);
    const winners = await race(db, id, 'start');
    assert.equal(winners.length, 1, 'one winner');
    const { claim, owner } = winners[0]!;
    assert.deepEqual([claim.generation, claim.attempt, claim.submissionState, claim.transcriptId], [1, 1, 'none', null]);
    const { rows } = await db.query<{ lease_owner: string; seconds: number }>(
      'select lease_owner, extract(epoch from lease_expires_at - clock_timestamp())::float8 as seconds from public.workflow_job where id = $1', [id]);
    assert.equal(rows[0]!.lease_owner, owner);
    assert.ok(rows[0]!.seconds > JOB_LEASE_SECONDS - 30 && rows[0]!.seconds <= JOB_LEASE_SECONDS, `lease is ${JOB_LEASE_SECONDS}s from database now, got ${rows[0]!.seconds}`);
    assert.equal((await race(db, id, 'start')).length, 0, 'a claimed row is never started again');
    await expireLease(db, id);
    assert.equal((await race(db, id, 'start')).length, 0, 'start ignores an expired lease; only recover may take over');
  });

  await t.test('recover: a live lease is protected; once expired exactly one worker takes over with the next generation', async () => {
    const id = await insertJob(db);
    const [first] = await race(db, id, 'start', 1);
    assert.equal((await race(db, id, 'recover')).length, 0, 'no takeover while the lease is live');
    await expireLease(db, id);
    const winners = await race(db, id, 'recover');
    assert.equal(winners.length, 1, 'one winner after expiry');
    assert.deepEqual([winners[0]!.claim.generation, winners[0]!.claim.attempt, winners[0]!.claim.claimCount], [first!.claim.generation + 1, 1, 2],
      'a recover claim counts a claim, not an execution');
    assert.equal((await race(db, id, 'recover')).length, 0, 'the new lease is live again');
  });

  await t.test('recover: a pre-S10 row without a lease is claimable only once its heartbeat is stale', async () => {
    const fresh = await insertJob(db, { status: 'processing', stage: 'transcribing audio' });
    assert.equal((await race(db, fresh, 'recover')).length, 0, 'a live pre-S10 instance keeps its job');
    const stale = await insertJob(db, { status: 'processing', stage: 'transcribing audio', updatedAgo: '6 minutes' });
    const winners = await race(db, stale, 'recover');
    assert.equal(winners.length, 1);
    const execution = executionFromClaim(winners[0]!.claim, { resumed: true, owner: winners[0]!.owner });
    assert.equal(execution.legacyUnknownSubmission, true, 'a pre-S10 run past input loading may have paid AssemblyAI');
    const queued = await insertJob(db, { updatedAgo: '6 minutes' });
    const [q] = await race(db, queued, 'recover', 1);
    assert.equal(executionFromClaim(q!.claim, { resumed: true }).legacyUnknownSubmission, false, 'a never-started row cannot have submitted');
  });

  await t.test('terminal rows are never claimed', async () => {
    for (const status of ['completed', 'failed']) {
      const id = await insertJob(db, { status, updatedAgo: '1 hour' });
      assert.equal((await race(db, id, 'recover')).length, 0, status);
      assert.equal((await race(db, id, 'start')).length, 0, status);
    }
  });

  await t.test('fencing: a worker that lost its lease cannot renew, write terminal status or begin a submission', async () => {
    const id = await insertJob(db);
    const [old] = await race(db, id, 'start', 1);
    await expireLease(db, id);
    const [current] = await race(db, id, 'recover', 1);
    const stale = executionFromClaim(old!.claim, { resumed: false, owner: old!.owner });
    const owner = executionFromClaim(current!.claim, { resumed: true, owner: current!.owner });
    await service(async () => {
      assert.equal(await store(old!.owner).renew(stale), 'lost');
      for (const patch of [{ status: 'completed' as const, stage: 'completed', progress: 100, result: { stale: true }, error: null },
        { status: 'failed' as const, stage: 'failed', progress: 100, error: 'stale failure' }, { stage: 'saving note' }]) {
        assert.equal(await store(old!.owner).write(stale, patch), 'lost', JSON.stringify(patch));
      }
      assert.deepEqual(await store(old!.owner).beginTranscriptSubmission(stale), { outcome: 'lost', count: null });
      // The same owner name with an old generation is still fenced out (instance restarted with a reused id).
      assert.equal(await store(current!.owner).write({ ...owner, generation: stale.generation }, { status: 'failed' }), 'lost');
    });
    let r = await row(db, id);
    assert.deepEqual([r.status, r.stage, r.result, r.error, r.transcript_submission_count], ['queued', 'queued', null, null, 0], 'nothing the stale worker sent was written');
    await service(async () => {
      assert.equal(await store(current!.owner).renew(owner), 'ok');
      assert.equal(await store(current!.owner).write(owner, { status: 'processing', stage: 'loading inputs', progress: 10 }), 'ok');
    });
    r = await row(db, id);
    assert.deepEqual([r.status, r.stage, r.progress], ['processing', 'loading inputs', 10]);
  });

  await t.test('completed and failed are final even for the owner; the owner may still heartbeat during enrichment', async () => {
    const id = await insertJob(db);
    const [w] = await race(db, id, 'start', 1);
    const execution = executionFromClaim(w!.claim, { resumed: false, owner: w!.owner });
    await service(async () => {
      const s = store(w!.owner);
      assert.equal(await s.write(execution, { status: 'completed', stage: 'completed', progress: 100, result: { ok: 1 }, error: null }), 'ok');
      assert.equal(await s.write(execution, { status: 'failed', stage: 'failed', error: 'late failure' }), 'lost', 'completed never turns into failed');
      assert.equal(await s.renew(execution), 'ok', 'post-completion heartbeat keeps updated_at fresh');
    });
    assert.deepEqual([(await row(db, id)).status, (await row(db, id)).result], ['completed', { ok: 1 }]);
    await expireLease(db, id);
    assert.equal((await race(db, id, 'recover')).length, 0, 'a completed job is never resumed');
  });

  await t.test('fenced write: present keys are written, JSON null clears, unknown keys and statuses are rejected', async () => {
    const id = await insertJob(db);
    const [w] = await race(db, id, 'start', 1);
    const execution = executionFromClaim(w!.claim, { resumed: false, owner: w!.owner });
    await service(async () => {
      const s = store(w!.owner);
      assert.equal(await s.write(execution, { stage: 'transcribing audio', progress: 25, error: 'transient', result: { partial: true } }), 'ok');
      assert.equal(await s.write(execution, { error: null, result: null }), 'ok');
      assert.equal(await s.write(execution, { lease_owner: 'thief' } as never), 'error', 'unknown keys raise instead of looking like a lost lease');
      assert.equal(await s.write(execution, { status: 'queued' } as never), 'error', 'a job never goes back to queued through a fenced write');
    });
    const r = await row(db, id);
    assert.deepEqual([r.stage, r.progress, r.error, r.result, r.lease_owner], ['transcribing audio', 25, null, null, w!.owner]);
  });

  await t.test('submission state survives a takeover: an in-flight marker without an id, then a saved id', async () => {
    const id = await insertJob(db);
    const [w] = await race(db, id, 'start', 1);
    const first = executionFromClaim(w!.claim, { resumed: false, owner: w!.owner });
    await service(async () => {
      assert.deepEqual(await store(w!.owner).beginTranscriptSubmission(first), { outcome: 'ok', count: 1 });
    });
    await expireLease(db, id);
    const [second] = await race(db, id, 'recover', 1);
    assert.deepEqual([second!.claim.submissionState, second!.claim.transcriptId, second!.claim.submissionCount], ['submitting', null, 1],
      'the recovering worker learns that a submission outcome is unknown');
    const resumed = executionFromClaim(second!.claim, { resumed: true, owner: second!.owner });
    await service(async () => {
      const s = store(second!.owner);
      assert.deepEqual(await s.beginTranscriptSubmission(resumed), { outcome: 'ok', count: 2 }, 'the resubmission is counted');
      assert.equal(await s.write(resumed, { assembly_transcript_id: 'provider-id', transcript_submission_state: 'submitted' }), 'ok');
    });
    await expireLease(db, id);
    const [third] = await race(db, id, 'recover', 1);
    assert.deepEqual([third!.claim.submissionState, third!.claim.transcriptId, third!.claim.submissionCount, third!.claim.claimCount], ['submitted', 'provider-id', 2, 3]);
  });

  await t.test('the claim never returns the stored request; the fenced load does, only to the current owner', async () => {
    const id = await insertJob(db);
    const { rows } = await asRole(db, 'service_role', () => db.query<Record<string, unknown>>(
      `select * from public.workflow_job_claim($1, 'raw-worker', 'start', 300, 300, 3, 10, 'en', 'ko')`, [id]));
    assert.equal(rows.length, 1, 'claimed');
    assert.ok(!('request' in rows[0]!), `no request column in the claim result: ${Object.keys(rows[0]!).join(',')}`);
    const owner = executionFromClaim({ jobId: id, userId: 'fixture-user', noteId: null, status: 'queued', stage: 'queued', generation: 1, attempt: 1, claimCount: 1,
      transcriptId: null, submissionState: 'none', submissionCount: 0 }, { resumed: true, owner: 'raw-worker' });
    await service(async () => {
      assert.deepEqual(await store('raw-worker').loadRequest(owner), { outcome: 'ok', request: { noteId: 'fixture', language: 'en' } });
      assert.deepEqual(await store('other').loadRequest({ ...owner, owner: 'other' }), { outcome: 'lost', request: null }, 'another owner reads nothing');
      assert.deepEqual(await store('raw-worker').loadRequest({ ...owner, generation: 0 }), { outcome: 'lost', request: null }, 'a stale generation reads nothing');
    });
  });

  await t.test('begin execution counts started runs, is fenced, and stops at the cap', async () => {
    const id = await insertJob(db);
    const [w] = await race(db, id, 'start', 1);
    const execution = executionFromClaim(w!.claim, { resumed: true, owner: w!.owner });
    await service(async () => {
      const s = store(w!.owner);
      assert.deepEqual(await s.beginExecution(execution), { outcome: 'ok', attempt: 2 });
      assert.deepEqual(await s.beginExecution(execution), { outcome: 'ok', attempt: 3 });
      assert.deepEqual(await s.beginExecution(execution), { outcome: 'lost', attempt: null }, `never past ${MAX_JOB_EXECUTION_ATTEMPTS}`);
      assert.deepEqual(await store('other').beginExecution({ ...execution, owner: 'other' }), { outcome: 'lost', attempt: null }, 'fenced');
    });
    assert.equal((await row(db, id)).attempt_count, MAX_JOB_EXECUTION_ATTEMPTS);
  });

  await t.test('SQL cap: a recover claim after the last execution fails the row atomically with the localized error', async () => {
    const id = await insertJob(db, { language: 'ko', stage: 'transcribing audio' });
    const [w] = await race(db, id, 'start', 1);
    let execution = executionFromClaim(w!.claim, { resumed: false, owner: w!.owner });
    for (let run = 2; run <= MAX_JOB_EXECUTION_ATTEMPTS; run += 1) {
      await expireLease(db, id);
      const [r] = await race(db, id, 'recover', 1);
      execution = executionFromClaim(r!.claim, { resumed: true, owner: r!.owner });
      await service(async () => assert.deepEqual(await store(r!.owner).beginExecution(execution), { outcome: 'ok', attempt: run }));
    }
    await expireLease(db, id);
    const outcome = await service(() => store('next-worker').claim(id, 'recover'));
    assert.equal(outcome.kind, 'exhausted', JSON.stringify(outcome));
    const r = await row(db, id);
    assert.deepEqual([r.status, r.stage, r.progress, r.error, r.lease_owner], ['failed', 'failed', 100, JOB_EXHAUSTED_ERROR.ko, 'next-worker']);
    await service(async () => {
      assert.equal(await store(execution.owner).write(execution, { status: 'completed', stage: 'completed' }), 'lost', 'the previous owner is fenced out');
    });
    await expireLease(db, id);
    assert.equal((await race(db, id, 'recover')).length, 0, 'a terminated row is never claimed again');
  });

  await t.test('claim committed but response lost, repeated: the job still terminates, bounded by the claim cap', async () => {
    const id = await insertJob(db, { status: 'processing', stage: 'transcribing audio', updatedAgo: '1 hour' });
    // The RPC runs and commits, then the client times out (large row, slow instance).
    const lossy: JobLeaseRpc = async (name, args, timeoutMs) => {
      await pgliteRpc(db)(name, args, timeoutMs);
      return { data: null, error: { message: 'This operation was aborted' } };
    };
    const s = createJobLeaseStore(lossy, 'unlucky-worker');
    let rounds = 0;
    while (rounds < MAX_JOB_CLAIMS + 5 && (await row(db, id)).status !== 'failed') {
      const outcome = await asRole(db, 'service_role', () => s.claim(id, 'recover'));
      assert.equal(outcome.kind, 'error', 'every response is lost');
      await expireLease(db, id);
      rounds += 1;
    }
    const r = await row(db, id);
    assert.deepEqual([r.status, r.error, r.attempt_count], ['failed', JOB_EXHAUSTED_ERROR.en, 0], 'terminated without ever running');
    assert.equal(rounds, MAX_JOB_CLAIMS + 1, `claims ${MAX_JOB_CLAIMS} times, the next one fails it (took ${rounds})`);
  });

  await t.test('the RPCs and the table stay closed to anon and authenticated', async () => {
    const id = await insertJob(db);
    for (const role of ['anon', 'authenticated']) {
      await asRole(db, role, async () => {
        for (const statement of [
          `select * from public.workflow_job_claim('${id}', 'x', 'start', 60, 60, 3, 10, 'en', 'ko')`,
          `select public.workflow_job_load_request('${id}', 'x', 1)`,
          `select public.workflow_job_begin_execution('${id}', 'x', 1, 3)`,
          `select public.workflow_job_renew_lease('${id}', 'x', 1, 60)`,
          `select public.workflow_job_write('${id}', 'x', 1, '{}'::jsonb)`,
          `select public.workflow_job_begin_transcript_submission('${id}', 'x', 1)`,
          'select id from public.workflow_job',
        ]) await assert.rejects(db.query(statement), /permission denied/, `${role}: ${statement}`);
      });
    }
    assert.equal((await row(db, id)).execution_generation, 0, 'denied calls changed nothing');
  });

  await t.test('the active-note unique index still allows one active job per note', async () => {
    await insertJob(db, { noteId: 'shared-note' });
    await assert.rejects(insertJob(db, { noteId: 'shared-note' }), (error: { code?: string }) => error.code === '23505');
  });
});

test('S10 lease store reports unsupported before the migration so callers keep pre-S10 behavior', async (t) => {
  const db = await database({ s10: false });
  t.after(() => db.close());
  const id = await insertJob(db);
  const s = createJobLeaseStore(pgliteRpc(db), 'worker');
  await asRole(db, 'service_role', async () => {
    const outcome = await s.claim(id, 'start');
    assert.equal(outcome.kind, 'unsupported', JSON.stringify(outcome));
    const execution = executionFromClaim({ jobId: id, userId: 'u', noteId: null, status: 'queued', stage: 'queued', generation: 1, attempt: 1, claimCount: 1,
      transcriptId: null, submissionState: 'none', submissionCount: 0 } satisfies JobClaim, { resumed: false, owner: 'worker' });
    assert.equal(await s.renew(execution), 'unsupported');
    assert.equal(await s.write(execution, { stage: 'x' }), 'unsupported');
  });
});
