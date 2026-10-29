import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { getGlobalDispatcher } from 'undici';

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
  assert.ok(!result.journal.some((event) => event.status === 'failed')), 'shutdown never fails the recording';
});

test('S12: SIGTERM after completed preserves success and records unfinished enrichment separately', { timeout: 20000 }, async (t) => {
  const result = await signalScenario(t, 'completed', 'SIGTERM');
  assert.equal(result.ready.postprocessingPending, true);
  assert.ok(result.journal.some((event) => event.status === 'completed'), 'completed was durable before shutdown');
  assert.ok(!result.journal.some((event) => event.status === 'failed')), 'shutdown never fails the recording';
  assert.ok(result.journal.some((event) => event.postprocessingStatus === 'pending'), 'in-memory enrichment has no durable pending marker yet');
  assert.equal(result.exit.code, 0);
});

test('S12: SIGKILL leaves a durable expiring lease and fenced generation for S10 recovery', { timeout: 20000 }, async (t) => {
  const result = await signalScenario(t, 'processing', 'SIGKILL');
  assert.equal(result.exit.signal, 'SIGKILL');
  assert.ok(result.journal.some((event) => event.fenced && event.durableLease), 'SIGKILL cannot execute a cleanup handler');
});

test('S12: drain rejects new submissions before stopping sweep, workers, heartbeat and provider calls', {
  skip: 'Requires the T1-9b runner cancellation seam and S10 claims; assert ordered fake boundary events and HTTP 503 before normalizing this test',
});
