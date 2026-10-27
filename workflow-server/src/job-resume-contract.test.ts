// S10 runner and orphan-sweep contracts (DEC-0022) with the S10 schema present: fenced
// stage writes, lease heartbeat, lease loss, the AssemblyAI submission marker and saved id,
// resubmission recording, resume of claimed orphans (checkpoint, saved id, unreachable
// audio, Android re-sign, unreadable request, SQL exhaustion, deferrals, persisted note) and the sweep's
// bounded loop and pre-S10 fallbacks. The pre-S10 runner and sweep stay pinned in
// job-runner-contract.test.ts; the SQL rules run on PGlite in job-lease-sql.test.ts.
// Offline only: fetch is faked, nothing reads .env.
import assert from 'node:assert/strict';
import test from 'node:test';
// Service config must exist before the server modules read env at import time. F9 is
// enabled so a raised incident is observable as a fake feedback_issues query (alerts stay
// disabled by the preload; no mail is ever sent).
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
process.env.GEMINI_API_KEY = 'synthetic-gemini';
process.env.ASSEMBLYAI_API_KEY = 'synthetic-assembly';
process.env.F9_OPS_AGENT_ENABLED = 'true';
const { audioUnavailableMessage } = await import('./pipeline/errors.js');
const { parseSummarizeInput } = await import('./pipeline/inputs.js');
const { workflowFixture, summarizeBody, USER, OTHER } = await import('./test-support/workflow.js');
const { processSummarizeJob, completedJobResults } = await import('./jobs/runner.js');
const {
  recoverClaimedJob, recoverOrphanedJobs, MAX_ACTIVE_RESUMES, activeResumeCount, RESUME_UNREADABLE_REQUEST_MESSAGE,
} = await import('./jobs/orphanSweep.js');
const { JOB_INSTANCE_ID, JOB_EXHAUSTED_ERROR } = await import('./jobs/lease.js');
type JobClaim = import('./jobs/lease.js').JobClaim;

type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
type FetchInput = Parameters<typeof fetch>[0];
type Override = (url: URL, method: string, body: any) => Promise<Response | undefined> | Response | undefined;

const toUrl = (input: FetchInput) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(condition: () => boolean, label: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(5);
  assert.ok(condition(), `timed out waiting for ${label}`);
}
const parseJson = (body: unknown) => {
  if (typeof body !== 'string') return null;
  try { return JSON.parse(body); } catch { return null; }
};
const isTable = (url: URL, table: string) => url.hostname === 'supabase.invalid' && url.pathname === `/rest/v1/${table}`;
const isRpc = (url: URL, name: string) => url.hostname === 'supabase.invalid' && url.pathname === `/rest/v1/rpc/${name}`;
const noCheckpoint: Override = (url, method) => (isTable(url, 'workflow_transcript_checkpoint') && method === 'GET' ? Response.json(null) : undefined);
const noNote: Override = (url, method) => (isTable(url, 'note') && method === 'GET' && url.searchParams.get('id')?.startsWith('eq.') ? Response.json(null) : undefined);

// The shared offline fixture with the S10 RPCs emulated (state.s10Schema), plus overrides.
async function fixture(t: test.TestContext, ...overrides: Override[]): Promise<Fixture> {
  const f = await workflowFixture();
  const fixtureFetch = globalThis.fetch;
  const intercept = t.mock.method(globalThis, 'fetch', async (input: FetchInput, init?: RequestInit) => {
    const url = toUrl(input);
    const method = init?.method ?? 'GET';
    const body = parseJson(init?.body);
    if (isTable(url, 'feedback_issues')) {
      f.state.calls.push({ url, method, body });
      if (method === 'HEAD') return new Response(null, { headers: { 'content-range': '0-0/0' } });
      return Response.json(method === 'GET' ? [] : null);
    }
    for (const override of overrides) {
      const replaced = await override(url, method, body);
      if (replaced) {
        f.state.calls.push({ url, method, body });
        return replaced;
      }
    }
    return fixtureFetch(input, init);
  });
  t.after(async () => { intercept.mock.restore(); await f.close(); });
  f.state.existingJob = false;
  return f;
}
const rpcCalls = (f: Fixture, name: string) => f.state.calls.filter((c) => isRpc(c.url, name));
const writes = (f: Fixture, jobId: string) => rpcCalls(f, 'workflow_job_write').filter((c) => c.body.p_job_id === jobId).map((c) => c.body.p_patch as Record<string, unknown>);
const assemblySubmits = (f: Fixture) => f.state.calls.filter((c) => c.url.hostname === 'api.assemblyai.com' && c.method === 'POST' && c.url.pathname === '/v2/transcript');
const indexOf = (f: Fixture, predicate: (c: Fixture['state']['calls'][number]) => boolean) => f.state.calls.findIndex(predicate);
const terminal = (f: Fixture, jobId: string) => writes(f, jobId).find((p) => p.status === 'completed' || p.status === 'failed');
const input = () => parseSummarizeInput({ ...summarizeBody });

// A claimed row plus the request workflow_job_load_request answers for it.
type ClaimFixture = Partial<JobClaim> & { request?: unknown };
function claimRow(overrides: ClaimFixture = {}): JobClaim & { request: unknown } {
  return {
    jobId: 'resumed-job', userId: USER, noteId: 'fixture-note', status: 'processing', stage: 'transcribing audio',
    request: { ...summarizeBody }, generation: 2, attempt: 1, claimCount: 2, transcriptId: null, submissionState: 'none', submissionCount: 0,
    ...overrides,
  };
}
async function recoverAndSettle(f: Fixture, row: JobClaim & { request: unknown }) {
  const { request, ...claim } = row;
  f.state.jobRequest = request;
  const outcome = await recoverClaimedJob(claim);
  if (outcome === 'resumed') await until(() => Boolean(terminal(f, claim.jobId)), `job ${claim.jobId} to finish`);
  await sleep(20);
  return outcome;
}

// ---------------------------------------------------------------------------
// Fresh jobs: claim, fenced writes, submission marker, saved id, heartbeat, lease loss
// ---------------------------------------------------------------------------

test('a fresh owned run: start claim, fenced stages, submission marker, id saved before the first poll, completed', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const f = await fixture(t, noCheckpoint);
  await processSummarizeJob('job-owned', input());
  const [claim] = rpcCalls(f, 'workflow_job_claim');
  assert.deepEqual(claim!.body, { p_job_id: 'job-owned', p_owner: JOB_INSTANCE_ID, p_mode: 'start', p_lease_seconds: 300, p_legacy_stale_seconds: 300,
    p_max_attempts: 3, p_max_claims: 10, p_exhausted_error_en: JOB_EXHAUSTED_ERROR.en, p_exhausted_error_ko: JOB_EXHAUSTED_ERROR.ko });
  const patches = writes(f, 'job-owned');
  assert.deepEqual(patches.slice(0, 2), [
    { status: 'processing', stage: 'loading inputs', progress: 10 },
    { stage: 'transcribing audio', progress: 25 },
  ]);
  assert.deepEqual(patches[2], { assembly_transcript_id: 'fixture-transcript', transcript_submission_state: 'submitted' });
  assert.deepEqual(patches.slice(3, -1), [{ stage: 'generating summary', progress: 75 }, { stage: 'saving note', progress: 92 }]);
  assert.deepEqual([patches.at(-1)!.status, patches.at(-1)!.error], ['completed', null]);
  assert.ok(rpcCalls(f, 'workflow_job_write').every((c) => c.body.p_generation === 1 && c.body.p_owner === JOB_INSTANCE_ID), 'every write is fenced by owner and generation');
  const order = [
    indexOf(f, (c) => isRpc(c.url, 'workflow_job_begin_transcript_submission')),
    indexOf(f, (c) => c.url.hostname === 'api.assemblyai.com' && c.method === 'POST'),
    indexOf(f, (c) => isRpc(c.url, 'workflow_job_write') && c.body.p_patch.assembly_transcript_id === 'fixture-transcript'),
    indexOf(f, (c) => c.url.pathname === '/v2/transcript/fixture-transcript'),
  ];
  assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `marker, submit, saved id, then poll: ${JSON.stringify(order)}`);
  assert.ok(!f.state.calls.some((c) => isTable(c.url, 'workflow_usage') && c.body?.stage === 'transcription-resubmission'), 'a first submission is not a resubmission');
  assert.ok(!f.state.calls.some((c) => isTable(c.url, 'workflow_job') && c.method === 'PATCH'), 'no unfenced job write');
  completedJobResults.delete('job-owned');
});

test('claim outcomes: an owned row is not started twice, and an unknown claim leaves the job to the sweep', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  let mode: 'empty' | 'error' = 'empty';
  const f = await fixture(t, (url) => (isRpc(url, 'workflow_job_claim')
    ? (mode === 'empty' ? Response.json([]) : Response.json({ message: 'claim timeout' }, { status: 500 })) : undefined));
  await processSummarizeJob('job-taken', input());
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'Workflow job job-taken is already owned by another execution; not starting it again.'), 'not-claimable is logged');
  mode = 'error';
  await processSummarizeJob('job-unknown', input());
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).startsWith('Could not claim workflow job job-unknown (claim timeout); the orphan sweep resumes it')), 'an unknown claim defers to the sweep');
  await sleep(20);
  assert.equal(rpcCalls(f, 'workflow_job_write').length, 0, 'no job write without ownership');
  assert.ok(!f.state.calls.some((c) => isTable(c.url, 'workflow_job') && c.method === 'PATCH'), 'never falls back to an unfenced run');
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'api.assemblyai.com'), 'no provider call');
});

test('a lost lease at a stage write stops the run without a failure write, incident or enrichment', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const log = t.mock.method(console, 'log', () => undefined);
  const error = t.mock.method(console, 'error', () => undefined);
  const f = await fixture(t, (url, _method, body) => (isRpc(url, 'workflow_job_write') && body.p_patch.stage === 'generating summary' ? Response.json(false) : undefined));
  await processSummarizeJob('job-lost-stage', input());
  await sleep(30);
  const patches = writes(f, 'job-lost-stage');
  assert.equal(patches.at(-1)!.stage, 'generating summary', 'nothing is written after the lost write');
  assert.ok(!patches.some((p) => p.status === 'failed' || p.status === 'completed'), 'no terminal write');
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'generativelanguage.googleapis.com' && c.url.pathname.includes('generateContent') && indexOf(f, (x) => x === c) > indexOf(f, (x) => isRpc(x.url, 'workflow_job_write') && x.body.p_patch.stage === 'generating summary')),
    'no summary call after losing the lease');
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).startsWith('Workflow job job-lost-stage lost its lease (generation 1) during the \'generating summary\' stage write.')), 'the loss is logged');
  assert.equal(error.mock.callCount(), 0, 'no failure log');
  assert.ok(!log.mock.calls.some((c) => String(c.arguments[0]).startsWith('Memory fold')), 'no enrichment');
  assert.ok(!f.state.calls.some((c) => isTable(c.url, 'feedback_issues')), 'no incident');
  assert.ok(!completedJobResults.has('job-lost-stage'), 'nothing cached');
});

test('a heartbeat that finds the lease taken stops the AssemblyAI poll at its next turn', { timeout: 30_000 }, async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const warn = t.mock.method(console, 'warn', () => undefined);
  let polls = 0;
  const f = await fixture(t, noCheckpoint,
    (url) => (isRpc(url, 'workflow_job_renew_lease') ? Response.json(false) : undefined),
    (url, method) => {
      if (url.hostname === 'api.assemblyai.com' && method === 'GET') { polls += 1; return Response.json({ id: 'fixture-transcript', status: 'processing' }); }
      return undefined;
    });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const run = processSummarizeJob('job-hb-lost', input());
  await until(() => polls >= 1, 'the first poll');
  t.mock.timers.tick(60_000);
  await until(() => rpcCalls(f, 'workflow_job_renew_lease').length === 1, 'the heartbeat renewal');
  await Promise.race([run, sleep(10_000).then(() => { throw new Error('the run did not stop after losing its lease'); })]);
  t.mock.timers.reset();
  assert.deepEqual(rpcCalls(f, 'workflow_job_renew_lease')[0]!.body, { p_job_id: 'job-hb-lost', p_owner: JOB_INSTANCE_ID, p_generation: 1, p_lease_seconds: 300 });
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('lost its lease (generation 1) at a heartbeat')), 'the heartbeat logs the loss');
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('during the AssemblyAI poll')), 'the poll stops on the loss');
  assert.ok(!writes(f, 'job-hb-lost').some((p) => p.status && p.status !== 'processing'), `no terminal write: ${JSON.stringify(writes(f, 'job-hb-lost'))}`);
  assert.ok(polls <= 2, `polling stopped (${polls} polls)`);
});

test('a lease lost right after AssemblyAI accepted the submission logs the paid id and stops', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const warn = t.mock.method(console, 'warn', () => undefined);
  const f = await fixture(t, noCheckpoint, (url, _method, body) => (isRpc(url, 'workflow_job_write') && body.p_patch.assembly_transcript_id ? Response.json(false) : undefined));
  await processSummarizeJob('job-lost-id', input());
  await sleep(20);
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('AssemblyAI had already accepted transcript fixture-transcript; this execution stops and the new owner resubmits.')), 'the paid id stays traceable');
  assert.ok(!f.state.calls.some((c) => c.url.pathname === '/v2/transcript/fixture-transcript'), 'no poll after losing the lease');
  assert.ok(!writes(f, 'job-lost-id').some((p) => p.status === 'failed'), 'no failure write');
});

test('a rejected AssemblyAI submit clears the in-flight marker before the job fails', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  const f = await fixture(t, noCheckpoint, (url, method) => (url.hostname === 'api.assemblyai.com' && method === 'POST' ? Response.json({ error: 'bad audio' }, { status: 400 }) : undefined));
  await processSummarizeJob('job-rejected', input());
  const patches = writes(f, 'job-rejected');
  const cleared = patches.findIndex((p) => p.transcript_submission_state === 'none');
  const failed = patches.findIndex((p) => p.status === 'failed');
  assert.ok(cleared >= 0 && cleared < failed, 'a provider rejection is not left looking like an unknown outcome');
  assert.match(String(patches[failed]!.error), /AssemblyAI transcript submit failed \(400\)/);
});

test('a completed write that finds the lease taken skips caching and enrichment', async (t) => {
  const log = t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const f = await fixture(t, (url, _method, body) => (isRpc(url, 'workflow_job_write') && body.p_patch.status === 'completed' ? Response.json(false) : undefined));
  await processSummarizeJob('job-lost-done', input());
  await sleep(20);
  assert.ok(!completedJobResults.has('job-lost-done'), 'no cached result');
  assert.ok(!log.mock.calls.some((c) => String(c.arguments[0]).startsWith('Memory fold')), 'no enrichment');
  assert.ok(!writes(f, 'job-lost-done').some((p) => p.status === 'failed'), 'completed work is never written as failed');
});

// ---------------------------------------------------------------------------
// Resume of a claimed orphan
// ---------------------------------------------------------------------------

test('resume with a saved transcript id polls it without a submission marker or resubmission', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const f = await fixture(t, noCheckpoint, noNote);
  assert.equal(await recoverAndSettle(f, claimRow({ transcriptId: 'saved-transcript', submissionState: 'submitted', submissionCount: 1 })), 'resumed');
  assert.equal(terminal(f, 'resumed-job')!.status, 'completed');
  assert.equal(assemblySubmits(f).length, 0, 'no resubmission');
  assert.equal(rpcCalls(f, 'workflow_job_begin_transcript_submission').length, 0, 'no new submission marker');
  assert.ok(f.state.calls.some((c) => c.url.pathname === '/v2/transcript/saved-transcript' && c.method === 'GET'), 'the saved id is polled');
  const usage = f.state.calls.find((c) => isTable(c.url, 'workflow_usage') && c.body?.provider === 'assemblyai')!;
  assert.deepEqual([usage.body.usage_metadata.transcriptId, usage.body.usage_metadata.resumedPoll], ['saved-transcript', true]);
  completedJobResults.delete('resumed-job');
});

test('resume after an unknown submission outcome resubmits and records it before submitting (DEC-0022)', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const warn = t.mock.method(console, 'warn', () => undefined);
  const f = await fixture(t, noCheckpoint, noNote, (url) => (isRpc(url, 'workflow_job_begin_transcript_submission') ? Response.json(2) : undefined));
  await recoverAndSettle(f, claimRow({ submissionState: 'submitting', submissionCount: 1 }));
  assert.equal(assemblySubmits(f).length, 1, 'the recording is resubmitted, never dropped');
  const recordAt = indexOf(f, (c) => isTable(c.url, 'workflow_usage') && c.body?.stage === 'transcription-resubmission');
  assert.ok(recordAt >= 0 && recordAt < indexOf(f, (c) => c.url.hostname === 'api.assemblyai.com' && c.method === 'POST'), 'the record lands before the new submission');
  const record = f.state.calls[recordAt]!.body;
  assert.deepEqual([record.provider, record.note_id, record.user_id, record.estimated_cost_usd], ['assemblyai', 'fixture-note', USER, 0]);
  assert.deepEqual(record.usage_metadata, { jobId: 'resumed-job', executionGeneration: 2, attempt: 2, submissionCount: 2, reason: 'submit-outcome-unknown', priorSubmissionOutcome: 'unknown' });
  const usage = f.state.calls.find((c) => isTable(c.url, 'workflow_usage') && c.body?.stage === 'transcription')!;
  assert.deepEqual([usage.body.usage_metadata.resubmission, usage.body.usage_metadata.resubmissionReason], [true, 'submit-outcome-unknown'], 'the paid transcription row is flagged');
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).startsWith('AssemblyAI resubmission for workflow job resumed-job')), 'the resubmission is logged even if the insert fails');
  assert.equal(terminal(f, 'resumed-job')!.status, 'completed');
  completedJobResults.delete('resumed-job');
});

test('resume of a pre-S10 row past input loading records a possible duplicate; a never-started row does not', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  const f = await fixture(t, noCheckpoint, noNote);
  await recoverAndSettle(f, claimRow({ jobId: 'legacy-job', generation: 1, attempt: 1, stage: 'transcribing audio' }));
  const records = () => f.state.calls.filter((c) => isTable(c.url, 'workflow_usage') && c.body?.stage === 'transcription-resubmission');
  assert.deepEqual(records().map((c) => c.body.usage_metadata.reason), ['pre-s10-run-outcome-unknown']);
  await recoverAndSettle(f, claimRow({ jobId: 'queued-job', generation: 1, attempt: 1, stage: 'queued' }));
  await recoverAndSettle(f, claimRow({ jobId: 's10-job', generation: 3, attempt: 2, stage: 'transcribing audio' }));
  assert.equal(records().length, 1, 'no record without a possible earlier charge');
  for (const id of ['legacy-job', 'queued-job', 's10-job']) completedJobResults.delete(id);
});

test('resume with a checkpoint skips AssemblyAI entirely', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const f = await fixture(t, noNote);
  await recoverAndSettle(f, claimRow({ submissionState: 'submitting' }));
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'api.assemblyai.com'), 'no provider call');
  assert.ok(!f.state.calls.some((c) => isTable(c.url, 'workflow_usage') && c.body?.stage === 'transcription-resubmission'), 'nothing resubmitted, nothing recorded');
  assert.equal(terminal(f, 'resumed-job')!.status, 'completed');
  completedJobResults.delete('resumed-job');
});

test('resume probes a storage link before resubmitting and fails clearly when it no longer answers', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  const storageUrl = 'https://supabase.invalid/storage/v1/object/sign/meeting-recordings/u/a.ogg?token=t';
  let probeStatus = 400;
  const f = await fixture(t, noCheckpoint, noNote, (url) => (url.pathname === '/storage/v1/object/sign/meeting-recordings/u/a.ogg'
    ? new Response('x', { status: probeStatus }) : undefined));
  const request = { ...summarizeBody, downloadUrl: storageUrl, language: 'ko' };
  await recoverAndSettle(f, claimRow({ request }));
  const failed = terminal(f, 'resumed-job')!;
  assert.deepEqual([failed.status, failed.error], ['failed', audioUnavailableMessage('ko')]);
  assert.equal(assemblySubmits(f).length, 0, 'no paid submission for an unreachable link');
  assert.equal(f.state.calls.filter((c) => c.url.pathname.endsWith('/a.ogg')).length, 1, 'a 4xx is not retried');
  const probe = f.state.calls.find((c) => c.url.pathname.endsWith('/a.ogg'))!;
  assert.equal(probe.method, 'GET');
  await sleep(30);
  assert.ok(!f.state.calls.some((c) => isTable(c.url, 'feedback_issues')), 'an expired link is a user outcome, not an ops incident');

  f.reset(); probeStatus = 206;
  await recoverAndSettle(f, claimRow({ jobId: 'reachable-job', request }));
  assert.equal(terminal(f, 'reachable-job')!.status, 'completed', 'a reachable link resumes');
  assert.equal(assemblySubmits(f)[0]!.body.audio_url, storageUrl);
  completedJobResults.delete('reachable-job');
});

test('the audio probe refuses redirects and treats a refused redirect as unreachable', async (t) => {
  const { assertAudioReachable } = await import('./pipeline/transcription.js');
  const inits: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: FetchInput, init?: RequestInit) => {
    inits.push(init ?? {});
    throw new TypeError('fetch failed: unexpected redirect');
  });
  await assert.rejects(assertAudioReachable('https://supabase.invalid/storage/v1/object/sign/a.ogg?token=t', 'en'),
    (error: Error & { detail?: string }) => error.name === 'AudioUnavailableError' && String(error.detail).includes('unexpected redirect'));
  assert.equal(inits.length, 2, 'a network-level failure is retried once');
  assert.ok(inits.every((init) => init.redirect === 'error'), 'never follow a redirect off the storage host');
});

test('resume never probes a link outside the project storage host', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const f = await fixture(t, noCheckpoint, noNote);
  await recoverAndSettle(f, claimRow());
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'audio.invalid'), 'the server does not fetch client-supplied hosts');
  assert.equal(assemblySubmits(f)[0]!.body.audio_url, summarizeBody.downloadUrl);
  completedJobResults.delete('resumed-job');
});

test('resume of an Android recording signs a fresh link from the stored object path', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const f = await fixture(t, noCheckpoint, noNote);
  const request = { ...summarizeBody, downloadUrl: 'https://supabase.invalid/storage/v1/object/sign/old?token=expired', source: 'android_recording', storagePath: `${USER}/fixture-note/a.ogg` };
  await recoverAndSettle(f, claimRow({ request }));
  const sign = f.state.calls.find((c) => c.url.pathname.includes('/storage/v1/object/sign/') && c.method === 'POST')!;
  assert.ok(sign.url.pathname.endsWith(`${USER}/fixture-note/a.ogg`), 'the stored path is signed again');
  assert.notEqual(assemblySubmits(f)[0]!.body.audio_url, request.downloadUrl, 'the expired link is not submitted');
  assert.equal(terminal(f, 'resumed-job')!.status, 'completed');
  completedJobResults.delete('resumed-job');
});

test('resume fails an unreadable or foreign stored request instead of running it', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const f = await fixture(t, noNote);
  for (const [jobId, request] of [['array-request', []], ['blank-request', { userId: USER }], ['foreign-request', { ...summarizeBody, userId: OTHER }],
    ['other-note', { ...summarizeBody, noteId: 'other-note' }]] as const) {
    assert.equal(await recoverAndSettle(f, claimRow({ jobId, request })), 'failed', jobId);
    assert.deepEqual([terminal(f, jobId)!.status, terminal(f, jobId)!.error], ['failed', RESUME_UNREADABLE_REQUEST_MESSAGE], jobId);
  }
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'api.assemblyai.com' || c.url.hostname === 'generativelanguage.googleapis.com'), 'nothing ran');
});

test('an exhausted claim (failed in SQL) is only reported: no request load, execution or write', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const warn = t.mock.method(console, 'warn', () => undefined);
  const f = await fixture(t,
    (url) => (isTable(url, 'workflow_job') && url.searchParams.has('or') ? Response.json([{ id: 'poison-job', lease_expires_at: null }]) : undefined),
    (url, _method, body) => (isRpc(url, 'workflow_job_claim') ? Response.json([{ id: body.p_job_id, user_id: USER, note_id: 'fixture-note', status: 'failed', stage: 'failed',
      execution_generation: 5, attempt_count: 3, claim_count: 5, assembly_transcript_id: null, transcript_submission_state: 'none', transcript_submission_count: 0,
      claim_outcome: 'exhausted' }]) : undefined));
  await recoverOrphanedJobs();
  const [claim] = rpcCalls(f, 'workflow_job_claim');
  assert.deepEqual([claim!.body.p_max_attempts, claim!.body.p_max_claims, claim!.body.p_exhausted_error_en, claim!.body.p_exhausted_error_ko],
    [3, 10, JOB_EXHAUSTED_ERROR.en, JOB_EXHAUSTED_ERROR.ko], 'the caps and the localized error travel to SQL');
  for (const name of ['workflow_job_load_request', 'workflow_job_begin_execution', 'workflow_job_write']) assert.equal(rpcCalls(f, name).length, 0, `${name} is not called`);
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'api.assemblyai.com' || isTable(c.url, 'note')), 'a poison job does not run again');
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'Workflow job poison-job stopped after 3 execution(s) and 5 claim(s); the claim marked it failed.'), 'the stop is logged');
  await until(() => f.state.calls.some((c) => isTable(c.url, 'feedback_issues')), 'the incident');
});

test('resume order: note check, then the request load, then the execution count; deferrals use no execution', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const warn = t.mock.method(console, 'warn', () => undefined);
  let load: 'ok' | 'timeout' | 'lost' = 'timeout';
  let begin: 'ok' | 'error' | 'lost' = 'ok';
  const f = await fixture(t, noCheckpoint, noNote,
    (url) => {
      if (!isRpc(url, 'workflow_job_load_request') || load === 'ok') return undefined;
      return load === 'lost' ? Response.json(null) : Response.json({ message: 'canceling statement due to statement timeout' }, { status: 500 });
    },
    (url) => {
      if (!isRpc(url, 'workflow_job_begin_execution') || begin === 'ok') return undefined;
      return begin === 'lost' ? Response.json(null) : Response.json({ message: 'begin blip' }, { status: 500 });
    });
  assert.equal(await recoverAndSettle(f, claimRow()), 'deferred', 'a request load timeout defers');
  assert.equal(rpcCalls(f, 'workflow_job_begin_execution').length, 0, 'a deferral before the run uses no execution attempt');
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).startsWith('Could not load the stored request of orphaned workflow job resumed-job (error)')), 'the deferral is logged');
  f.reset(); load = 'lost';
  assert.equal(await recoverAndSettle(f, claimRow()), 'lost', 'a lost lease at the load stops');
  f.reset(); load = 'ok'; begin = 'error';
  assert.equal(await recoverAndSettle(f, claimRow()), 'deferred', 'an uncounted execution does not run');
  f.reset(); begin = 'lost';
  assert.equal(await recoverAndSettle(f, claimRow()), 'lost');
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'api.assemblyai.com' || c.url.hostname === 'generativelanguage.googleapis.com'), 'nothing ran in any of these');
  assert.equal(rpcCalls(f, 'workflow_job_write').length, 0, 'and nothing was written');
  f.reset(); begin = 'ok';
  assert.equal(await recoverAndSettle(f, claimRow({ jobId: 'ordered-job' })), 'resumed');
  const order = [
    indexOf(f, (c) => isTable(c.url, 'note') && c.url.searchParams.get('id') === 'eq.fixture-note'),
    indexOf(f, (c) => isRpc(c.url, 'workflow_job_load_request')),
    indexOf(f, (c) => isRpc(c.url, 'workflow_job_begin_execution')),
    indexOf(f, (c) => isRpc(c.url, 'workflow_job_write')),
  ];
  assert.ok(order.every((at) => at >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `note, load, begin, then the run: ${JSON.stringify(order)}`);
  assert.deepEqual(rpcCalls(f, 'workflow_job_load_request')[0]!.body, { p_job_id: 'ordered-job', p_owner: JOB_INSTANCE_ID, p_generation: 2 }, 'the load is fenced');
  completedJobResults.delete('ordered-job');
});

test('resume converges to completed from a persisted note of the same user; a lookup error defers', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  let noteMode: 'mine' | 'foreign' | 'error' = 'mine';
  const note = { id: 'fixture-note', user_id: USER, summary: 'Saved summary', name: 'Saved', diarization: [], tags: [] };
  const f = await fixture(t, noCheckpoint, (url, method) => {
    if (!(isTable(url, 'note') && method === 'GET' && url.searchParams.get('id') === 'eq.fixture-note')) return undefined;
    if (noteMode === 'error') return Response.json({ message: 'note read timeout' }, { status: 500 });
    return Response.json(noteMode === 'mine' ? note : { ...note, user_id: OTHER });
  });
  assert.equal(await recoverAndSettle(f, claimRow()), 'completed');
  const done = terminal(f, 'resumed-job')!;
  assert.deepEqual([done.status, (done.result as { summary: string }).summary], ['completed', 'Saved summary']);
  assert.ok(!f.state.calls.some((c) => c.url.hostname === 'api.assemblyai.com' || c.url.hostname === 'generativelanguage.googleapis.com'), 'finished work is not rerun');
  assert.equal(rpcCalls(f, 'workflow_job_load_request').length, 0, 'finished work never loads the stored request');
  f.reset(); noteMode = 'error';
  assert.equal(await recoverAndSettle(f, claimRow()), 'deferred');
  assert.equal(rpcCalls(f, 'workflow_job_write').length, 0, 'unknown note state: neither rerun nor fail');
  assert.equal(rpcCalls(f, 'workflow_job_begin_execution').length, 0, 'a note lookup deferral uses no execution attempt');
  f.reset(); noteMode = 'foreign';
  assert.equal(await recoverAndSettle(f, claimRow({ jobId: 'foreign-note-job' })), 'resumed', 'another user\'s note never completes this job');
  completedJobResults.delete('foreign-note-job');
});

// ---------------------------------------------------------------------------
// Sweep loop
// ---------------------------------------------------------------------------

test('the sweep claims expired rows by database time and runs at most MAX_ACTIVE_RESUMES resumes at once', { timeout: 30_000 }, async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const ids = Array.from({ length: MAX_ACTIVE_RESUMES + 2 }, (_, i) => `orphan-${i}`);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(t, noCheckpoint, noNote,
    (url) => (isTable(url, 'workflow_job') && url.searchParams.has('or') ? Response.json(ids.map((id) => ({ id, lease_expires_at: null }))) : undefined),
    (url, _method, body) => (isRpc(url, 'workflow_job_claim') ? Response.json([{ id: body.p_job_id, user_id: USER, note_id: 'fixture-note', status: 'processing', stage: 'queued',
      execution_generation: 2, attempt_count: 1, claim_count: 2, assembly_transcript_id: null, transcript_submission_state: 'none', transcript_submission_count: 0,
      claim_outcome: 'claimed' }]) : undefined),
    // Hold every resumed run at its provider submit so the resumes stay active.
    async (url, method) => {
      if (url.hostname === 'api.assemblyai.com' && method === 'POST') await held;
      return undefined;
    });
  assert.equal(MAX_ACTIVE_RESUMES, 2);
  await recoverOrphanedJobs();
  const claimed = () => rpcCalls(f, 'workflow_job_claim').map((c) => c.body.p_job_id as string);
  assert.deepEqual(claimed(), ids.slice(0, MAX_ACTIVE_RESUMES), 'the rest wait unclaimed');
  assert.equal(activeResumeCount(), MAX_ACTIVE_RESUMES);
  await recoverOrphanedJobs();
  assert.deepEqual(claimed(), ids.slice(0, MAX_ACTIVE_RESUMES), 'a sweep at the cap claims nothing');
  release();
  await until(() => ids.slice(0, MAX_ACTIVE_RESUMES).every((id) => terminal(f, id)), 'the resumed runs');
  await until(() => activeResumeCount() === 0, 'the slots to free');
  await recoverOrphanedJobs();
  assert.deepEqual(claimed().slice(MAX_ACTIVE_RESUMES), ids.slice(0, MAX_ACTIVE_RESUMES), 'freed slots take the next candidates (the scan fixture lists the same rows)');
  await until(() => activeResumeCount() === 0, 'the second wave');
  for (const id of ids) completedJobResults.delete(id);
  const scan = f.state.calls.find((c) => isTable(c.url, 'workflow_job') && c.url.searchParams.has('or'))!;
  assert.equal(scan.url.searchParams.get('limit'), '200');
});

test('the sweep falls back to the pre-S10 behavior when the S10 columns or RPCs are missing', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const warn = t.mock.method(console, 'warn', () => undefined);
  let scanError: Record<string, string> | null = { code: '42703', message: 'column workflow_job.lease_expires_at does not exist' };
  const f = await fixture(t, (url) => {
    if (!(isTable(url, 'workflow_job'))) return undefined;
    if (url.searchParams.has('or')) return scanError ? Response.json(scanError, { status: 400 }) : Response.json([{ id: 'orphan', lease_expires_at: null }]);
    if (url.searchParams.has('updated_at')) return Response.json([]);
    return undefined;
  });
  await recoverOrphanedJobs();
  assert.ok(f.state.calls.some((c) => isTable(c.url, 'workflow_job') && c.url.searchParams.get('updated_at')?.startsWith('lt.')), 'missing columns: the pre-S10 stale scan runs');
  assert.equal(rpcCalls(f, 'workflow_job_claim').length, 0);

  f.reset(); scanError = null; f.state.s10Schema = false;
  await recoverOrphanedJobs();
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).startsWith('S10 claim RPC unavailable')), 'missing RPC is logged');
  assert.ok(f.state.calls.some((c) => isTable(c.url, 'workflow_job') && c.url.searchParams.get('updated_at')?.startsWith('lt.')), 'missing RPC: the pre-S10 stale scan runs');

  f.reset(); scanError = { code: 'FIXTURE', message: 'scan timeout' };
  await recoverOrphanedJobs();
  assert.ok(warn.mock.calls.some((c) => c.arguments[0] === 'Could not scan for orphaned workflow jobs: scan timeout'), 'other scan errors only warn');
  assert.ok(!f.state.calls.some((c) => c.url.searchParams.get('updated_at')?.startsWith('lt.')), 'no fallback that would fail live S10 jobs');
  await turn();
});
