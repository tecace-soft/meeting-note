import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { getGlobalDispatcher } from 'undici';

process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role';
process.env.GEMINI_API_KEY = 'synthetic-gemini';
process.env.ASSEMBLYAI_API_KEY = 'synthetic-assembly';

interface JournalEvent { event: string; status?: string; postprocessingPending?: boolean; postprocessingStatus?: string; fenced?: boolean; durableLease?: boolean }
async function signalScenario(t: { after: (fn: () => void) => void }, mode: 'processing' | 'completed', signal: 'SIGTERM' | 'SIGKILL') {
  const workflow = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './src/test-setup.ts', 'src/test-support/signal-child.ts', mode], {
    cwd: workflow, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const journal: JournalEvent[] = [];
  let diagnostics = '';
  child.stderr!.on('data', (chunk) => { diagnostics += String(chunk); });
  child.stdout!.on('data', () => undefined);
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
  t.after(() => { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const ready = await new Promise<JournalEvent>((resolve, reject) => {
    child.on('message', (message: JournalEvent) => { journal.push(message); if (message.event === 'ready') resolve(message); });
    child.once('exit', () => reject(new Error('Signal fixture exited before ready: ' + diagnostics)));
    child.once('error', reject);
  });
  assert.equal(ready.status, mode === 'completed' ? 'completed' : 'processing');
  child.kill(signal);
  return { ready, journal, exit: await exited };
}

test('S12: startup installs a SIGTERM drain handler', { timeout: 20000 }, async (t) => {
  const { server, startServer } = await import('./index.js');
  const before = process.listenerCount('SIGTERM');
  const stop = startServer({ port: 0, host: '127.0.0.1', dispatcher: getGlobalDispatcher() });
  t.after(stop);
  await once(server, 'listening');
  assert.equal(process.listenerCount('SIGTERM'), before + 1);
});

test('S12: SIGTERM during processing exits cleanly after a fenced nonterminal handoff', { timeout: 20000 }, async (t) => {
  const result = await signalScenario(t, 'processing', 'SIGTERM');
  assert.equal(result.exit.code, 0, 'the existing process dies from SIGTERM without draining');
  assert.ok(result.journal.some((event) => event.status === 'queued' && event.fenced), 'shutdown hands off processing with the execution fence');
  assert.ok(!result.journal.some((event) => event.status === 'failed'), 'shutdown never fails the recording');
});

test('S12: SIGTERM after completed preserves success and records unfinished enrichment separately', { timeout: 20000 }, async (t) => {
  const result = await signalScenario(t, 'completed', 'SIGTERM');
  assert.equal(result.ready.postprocessingPending, true);
  assert.ok(result.journal.some((event) => event.status === 'completed'), 'completed was durable before shutdown');
  assert.ok(!result.journal.some((event) => event.status === 'failed'), 'shutdown never fails the recording');
  assert.ok(result.journal.some((event) => event.postprocessingStatus === 'pending'), 'in-memory enrichment has no durable pending marker yet');
  assert.equal(result.exit.code, 0);
});

test('S12: SIGKILL leaves a durable expiring lease and fenced generation for S10 recovery', { timeout: 20000 }, async (t) => {
  const result = await signalScenario(t, 'processing', 'SIGKILL');
  assert.equal(result.exit.signal, 'SIGKILL');
  assert.ok(result.journal.some((event) => event.fenced && event.durableLease), 'SIGKILL cannot execute a cleanup handler');
});

test('S12: drain rejects new submissions before stopping sweep, workers, heartbeat and provider calls', { timeout: 10000 }, async (t) => {
  const { workflowFixture } = await import('./test-support/workflow.js');
  const f = await workflowFixture();
  const { beginDrain, isDraining, resetDrain, registerExecution, executionFetch } = await import('./runtime/executionScope.js');
  const { createGracefulStop } = await import('./runtime/shutdown.js');
  const { jobLeases } = await import('./jobs/lease.js');
  resetDrain();
  t.after(() => resetDrain());
  t.after(() => f.close());
  const events: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const execution = { jobId: 'fixture-job', owner: 'owner', generation: 1, attempt: 1, resumed: false,
    unknownPriorSubmission: null, transcriptId: null, submissionState: 'none' as const, lost: false };
  t.mock.method(jobLeases, 'release', async () => { events.push('release'); await held; return 'ok' as const; });
  const previousFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== 'https://provider.invalid') return previousFetch(input, init);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { events.push('provider aborted'); reject(init.signal?.reason); }, { once: true });
    });
  });
  const registered = registerExecution(execution, () => events.push('heartbeat stopped'));
  t.after(() => registered.finish());
  const provider = registered.run(() => executionFetch('https://provider.invalid')).catch(() => undefined);
  assert.equal((await f.request('/ready', { method: 'GET' })).status, 200);
  const stop = createGracefulStop({ server: f.server,
    stopWorkers: () => { assert.equal(isDraining(), true); events.push('sweep and workers stopped'); },
    cleanup: () => events.push('cleanup'), closeDispatcher: async () => { events.push('dispatcher closed'); },
    destroyDispatcher: async () => { events.push('dispatcher destroyed'); },
  });
  const stopping = stop();
  assert.equal(stop(), stopping, 'repeated shutdown uses one promise');
  const expected = { error: 'Server is shutting down. Please retry.', code: 'SERVER_DRAINING', retryable: true };
  for (const [path, method] of [['/ready','GET'], ['/summarize-audio/jobs','POST'], ['/admin/backfill-insight','POST'], ['/mcp','DELETE']]) {
    const result = await f.request(path!, { method });
    assert.equal(result.status, 503, path);
    assert.equal(result.headers.get('retry-after'), '5');
    assert.deepEqual(result.body, expected);
  }
  assert.equal((await f.request('/health', { method: 'GET' })).status, 200);
  assert.equal((await f.request('/summarize-audio/jobs/fixture-job', { method: 'GET' })).status, 200);
  assert.equal((await f.request('/summarize-audio/jobs', { method: 'OPTIONS' })).status, 204);
  assert.deepEqual(events, ['sweep and workers stopped', 'heartbeat stopped', 'provider aborted', 'release']);
  assert.equal(execution.lost, true);
  release();
  await stopping;
  await provider;
  assert.equal(events.at(-1), 'cleanup');
  beginDrain();
});

test('S12: a stalled DB handoff cannot exceed the shutdown bound', { timeout: 5000 }, async (t) => {
  const { createServer } = await import('node:http');
  const { createGracefulStop, SHUTDOWN_DEADLINE_MS } = await import('./runtime/shutdown.js');
  const { resetDrain, registerExecution } = await import('./runtime/executionScope.js');
  const { jobLeases } = await import('./jobs/lease.js');
  assert.equal(SHUTDOWN_DEADLINE_MS, 20000);
  resetDrain();
  t.after(() => resetDrain());
  const http = createServer(() => undefined);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  const requested = once(http, 'request');
  const request = fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  await requested;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  t.mock.method(jobLeases, 'release', async () => { await held; return 'ok' as const; });
  const registered = registerExecution({ jobId: 'stalled', owner: 'worker', generation: 1, attempt: 1, resumed: false,
    unknownPriorSubmission: null, transcriptId: null, submissionState: 'none', lost: false }, () => undefined);
  t.after(() => registered.finish());
  let cleanupCount = 0;
  let destroyed = false;
  const stop = createGracefulStop({ server: http, deadlineMs: 30, stopWorkers: () => undefined,
    cleanup: () => { cleanupCount += 1; }, closeDispatcher: async () => undefined,
    destroyDispatcher: async () => { destroyed = true; },
  });
  const started = performance.now();
  await stop();
  assert.ok(performance.now() - started < 1000, 'shutdown does not wait for the stalled operation');
  assert.equal(destroyed, true);
  assert.equal(cleanupCount, 1);
  assert.equal(await request, null, 'the unfinished HTTP request is closed at the deadline');
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanupCount, 1, 'late cleanup is idempotent');
});
