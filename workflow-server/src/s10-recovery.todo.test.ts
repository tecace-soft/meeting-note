import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { getGlobalDispatcher } from 'undici';
import { workflowFixture, USER, summarizeBody } from './test-support/workflow.js';

const TODO = 'S10 implementation waits for T1-9b; remove todo when atomic claims, fencing and persisted provider ids exist';

// Run the real startup sweep with a stale in-memory DB row, without changing index.ts.
async function bootStaleJob(options: { leaseExpiresAt?: string; transcriptId?: string; checkpoint?: boolean } = {}) {
  const f = await workflowFixture();
  await new Promise<void>((resolve) => f.server.close(() => resolve()));
  const originalFetch = globalThis.fetch;
  const intercept = test.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'supabase.invalid' && url.pathname.endsWith('/workflow_job') && url.searchParams.has('updated_at')) {
      return Response.json([{ id: 'fixture-job', user_id: USER, note_id: 'fixture-note', status: 'processing',
        lease_expires_at: options.leaseExpiresAt ?? new Date(0).toISOString(), execution_generation: 1,
        assembly_transcript_id: options.transcriptId ?? null }]);
    }
    if (url.hostname === 'supabase.invalid' && url.pathname.endsWith('/workflow_transcript_checkpoint') && !options.checkpoint && (init?.method ?? 'GET') === 'GET') return Response.json(null);
    if (url.hostname === 'supabase.invalid' && url.pathname.endsWith('/note') && url.searchParams.get('id')?.startsWith('in.')) return Response.json([]);
    return originalFetch(input, init);
  });
  const { server, startServer } = await import('./index.js');
  const stop = startServer({ port: 0, host: '127.0.0.1', dispatcher: getGlobalDispatcher() });
  await once(server, 'listening');
  for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  return { f, async close() { await stop(); intercept.mock.restore(); await f.close(); } };
}

test('S10: boot reuses a durable checkpoint instead of terminally failing the stale job', { todo: TODO }, async (t) => {
  const b = await bootStaleJob({ checkpoint: true });
  t.after(() => b.close());
  assert.ok(!b.f.state.jobUpdates.some((patch) => patch.status === 'failed'), 'checkpoint-bearing work must remain resumable');
  assert.ok(b.f.state.calls.some((call) => call.url.hostname === 'generativelanguage.googleapis.com'), 'resume the summary from the saved checkpoint');
  assert.ok(!b.f.state.calls.some((call) => call.url.hostname === 'api.assemblyai.com'), 'do not pay for a second transcription');
});

test('S10: boot polls an already-persisted AssemblyAI id without resubmitting', { todo: TODO }, async (t) => {
  const b = await bootStaleJob({ transcriptId: 'fixture-transcript' });
  t.after(() => b.close());
  assert.ok(b.f.state.calls.some((call) => call.url.pathname === '/v2/transcript/fixture-transcript' && call.method === 'GET'));
  assert.ok(!b.f.state.calls.some((call) => call.url.pathname === '/v2/transcript' && call.method === 'POST'));
});

test('S10: a nonexpired lease protects a stale-heartbeat row during instance overlap and DB delay', { todo: TODO }, async (t) => {
  const b = await bootStaleJob({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
  t.after(() => b.close());
  assert.deepEqual(b.f.state.jobUpdates, [], 'the new instance has no right to fail or reclaim this generation');
});

test('S10: every runner job write carries its execution generation', { todo: TODO }, async (t) => {
  const f = await workflowFixture();
  t.after(() => f.close());
  f.state.existingJob = false;
  assert.equal((await f.request('/summarize-audio/jobs', { body: summarizeBody })).status, 202);
  for (let turn = 0; turn < 50 && f.state.jobStatus !== 'completed'; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  const updates = f.state.calls.filter((call) => call.url.pathname.endsWith('/workflow_job') && call.method === 'PATCH');
  assert.ok(updates.length > 0);
  assert.ok(updates.every((call) => call.url.searchParams.has('execution_generation')), 'id-only updates let an old instance overwrite a new generation');
});

test('S10: successful transcription submission persists its id before the first poll', { todo: TODO }, async (t) => {
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
  const deadline = Date.now() + 5_000;
  while (f.state.jobStatus !== 'completed' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.state.jobStatus, 'completed');
  const poll = f.state.calls.findIndex((call) => call.url.pathname === '/v2/transcript/fixture-transcript');
  const saved = f.state.calls.findIndex((call) => call.url.pathname.endsWith('/workflow_job') && call.method === 'PATCH' && call.body?.assembly_transcript_id === 'fixture-transcript');
  assert.ok(saved >= 0 && saved < poll, 'a crash after submit currently discards the paid provider id');
});

test('S10: conditional SQL claim has exactly one winner for the same job row', {
  skip: 'Requires the T1-9b claim seam and approved S10 lease/generation SQL; use pinned PGlite transactions, not a fake that assumes atomicity',
});
test('S10: crash between provider submit and id persistence stays uncertain until an explicit retry policy resolves it', {
  skip: 'Requires the approved durable submission-attempt schema; do not implement or silently resubmit in this design-only PR',
});
