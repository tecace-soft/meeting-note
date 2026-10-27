// S10 recovery through the real startup sweep, job routes and runner (DEC-0022). These
// were the five failing todo assertions of the S10 design PR; the assertions are kept and
// only the fixture plumbing follows the S10 seams (lease scan, claim RPC, fenced write
// RPC). The SQL claim and fencing rules themselves run on PGlite in job-lease-sql.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { getGlobalDispatcher } from 'undici';
import { workflowFixture, USER, summarizeBody } from './test-support/workflow.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(10);
}

// Run the real startup sweep against one stale job row. The scan may return a row whose
// lease is still live (instance overlap, DB delay, clock skew); the claim RPC answers by
// database time, so here it claims only when the lease is expired.
async function bootStaleJob(options: { leaseExpiresAt?: string; transcriptId?: string; checkpoint?: boolean } = {}) {
  const f = await workflowFixture();
  await new Promise<void>((resolve) => f.server.close(() => resolve()));
  const originalFetch = globalThis.fetch;
  const leaseExpiresAt = options.leaseExpiresAt ?? new Date(0).toISOString();
  const intercept = test.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    if (url.hostname === 'supabase.invalid' && url.pathname.endsWith('/workflow_job') && url.searchParams.has('or')) {
      return Response.json([{ id: 'fixture-job', lease_expires_at: leaseExpiresAt }]);
    }
    if (url.hostname === 'supabase.invalid' && url.pathname.endsWith('/rpc/workflow_job_claim')) {
      f.state.calls.push({ url, method, body: JSON.parse(String(init?.body ?? 'null')) });
      if (Date.parse(leaseExpiresAt) > Date.now()) return Response.json([]);
      return Response.json([{ id: 'fixture-job', user_id: USER, note_id: 'fixture-note', status: 'processing', stage: 'transcribing audio',
        execution_generation: 2, attempt_count: 1, claim_count: 2,
        assembly_transcript_id: options.transcriptId ?? null, transcript_submission_state: options.transcriptId ? 'submitted' : 'none',
        transcript_submission_count: options.transcriptId ? 1 : 0, claim_outcome: 'claimed' }]);
    }
    if (url.hostname === 'supabase.invalid' && url.pathname.endsWith('/workflow_transcript_checkpoint') && !options.checkpoint && method === 'GET') return Response.json(null);
    // No note was persisted before the restart.
    if (url.hostname === 'supabase.invalid' && url.pathname.endsWith('/note') && method === 'GET' && url.searchParams.get('id') === 'eq.fixture-note') return Response.json(null);
    return originalFetch(input, init);
  });
  const { server, startServer } = await import('./index.js');
  const stop = startServer({ port: 0, host: '127.0.0.1', dispatcher: getGlobalDispatcher() });
  await once(server, 'listening');
  return { f, async close() { await stop(); intercept.mock.restore(); await f.close(); } };
}

test('S10: boot reuses a durable checkpoint instead of terminally failing the stale job', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const b = await bootStaleJob({ checkpoint: true });
  t.after(() => b.close());
  await until(() => b.f.state.jobStatus === 'completed' || b.f.state.jobStatus === 'failed');
  assert.ok(!b.f.state.jobUpdates.some((patch) => patch.status === 'failed'), 'checkpoint-bearing work must remain resumable');
  assert.ok(b.f.state.calls.some((call) => call.url.hostname === 'generativelanguage.googleapis.com'), 'resume the summary from the saved checkpoint');
  assert.ok(!b.f.state.calls.some((call) => call.url.hostname === 'api.assemblyai.com'), 'do not pay for a second transcription');
  assert.equal(b.f.state.jobStatus, 'completed', 'the resumed job completes');
});

test('S10: boot polls an already-persisted AssemblyAI id without resubmitting', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const b = await bootStaleJob({ transcriptId: 'fixture-transcript' });
  t.after(() => b.close());
  await until(() => b.f.state.jobStatus === 'completed' || b.f.state.jobStatus === 'failed');
  assert.ok(b.f.state.calls.some((call) => call.url.pathname === '/v2/transcript/fixture-transcript' && call.method === 'GET'), 'the saved id is polled');
  assert.ok(!b.f.state.calls.some((call) => call.url.pathname === '/v2/transcript' && call.method === 'POST'), 'no second submission');
});

test('S10: a nonexpired lease protects a stale-heartbeat row during instance overlap and DB delay', async (t) => {
  const b = await bootStaleJob({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  t.after(() => b.close());
  await until(() => b.f.state.calls.some((call) => call.url.pathname.endsWith('/rpc/workflow_job_claim')));
  await sleep(50);
  assert.ok(b.f.state.calls.some((call) => call.url.pathname.endsWith('/rpc/workflow_job_claim')), 'the sweep asked the database');
  assert.deepEqual(b.f.state.jobUpdates, [], 'the new instance has no right to fail or reclaim this generation');
});

test('S10: every runner job write carries its execution generation', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const f = await workflowFixture();
  t.after(() => f.close());
  f.state.existingJob = false;
  assert.equal((await f.request('/summarize-audio/jobs', { body: summarizeBody })).status, 202);
  await until(() => f.state.jobStatus === 'completed');
  await sleep(20);
  const updates = f.state.calls.filter((call) => call.url.pathname.endsWith('/rpc/workflow_job_write'));
  assert.ok(updates.length > 0, 'the runner writes through the fenced RPC');
  assert.ok(updates.every((call) => call.body?.p_generation === 1 && typeof call.body?.p_owner === 'string' && call.body.p_owner.length > 0),
    'id-only updates let an old instance overwrite a new generation');
  assert.ok(!f.state.calls.some((call) => call.url.pathname.endsWith('/workflow_job') && call.method === 'PATCH'), 'no unfenced id-only job write remains');
});

test('S10: successful transcription submission persists its id before the first poll', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const f = await workflowFixture();
  t.after(() => f.close());
  const originalFetch = globalThis.fetch;
  const intercept = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input).includes('/rest/v1/workflow_transcript_checkpoint') && (init?.method ?? 'GET') === 'GET') return Response.json(null);
    return originalFetch(input, init);
  });
  t.after(() => intercept.mock.restore());
  f.state.existingJob = false;
  assert.equal((await f.request('/summarize-audio/jobs', { body: summarizeBody })).status, 202);
  await until(() => f.state.jobStatus === 'completed');
  assert.equal(f.state.jobStatus, 'completed');
  const poll = f.state.calls.findIndex((call) => call.url.pathname === '/v2/transcript/fixture-transcript');
  const saved = f.state.calls.findIndex((call) => call.url.pathname.endsWith('/rpc/workflow_job_write') && call.body?.p_patch?.assembly_transcript_id === 'fixture-transcript');
  assert.ok(saved >= 0 && saved < poll, 'a crash after submit currently discards the paid provider id');
});
