import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, cp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';

const workflowDir = fileURLToPath(new URL('../', import.meta.url));

test('preload clears inherited credentials and disables alerts and workers', () => {
  assert.equal(process.env.MEETING_NOTE_SKIP_DOTENV, '1');
  assert.equal(process.env.WORKFLOW_ALERTS_ENABLED, 'false');
  assert.equal(process.env.F9_OPS_AGENT_ENABLED, 'false');
  for (const key of ['SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY', 'ASSEMBLYAI_API_KEY', 'OPENAI_API_KEY', 'RESEND_API_KEY', 'MCP_API_KEY', 'MEETING_KNOWLEDGE_INGEST_KEY']) {
    assert.equal(process.env[key], undefined, key);
  }
});

test('index import preserves dispatcher and creates no listeners, intervals or socket', async (t) => {
  const dispatcher = getGlobalDispatcher();
  const events = ['unhandledRejection', 'uncaughtException', 'SIGTERM'] as const;
  const before = events.map((event) => process.listenerCount(event));
  const interval = t.mock.method(globalThis, 'setInterval');
  const { server } = await import('./index.js');
  assert.equal(server.listening, false);
  assert.equal(getGlobalDispatcher(), dispatcher);
  assert.deepEqual(events.map((event) => process.listenerCount(event)), before);
  assert.equal(interval.mock.callCount(), 0);
});

test('temporary sentinel .env is never read by index or MCP imports', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'meeting-note-isolation-'));
  try {
    // Copy source only, never the real workflow directory or its .env.
    await cp(join(workflowDir, 'src'), join(scratch, 'src'), { recursive: true });
    await symlink(join(workflowDir, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    await writeFile(join(scratch, 'package.json'), '{"type":"module"}');
    await writeFile(join(scratch, '.env'), 'ISOLATION_SENTINEL=dotenv-was-read\n');
    await writeFile(join(scratch, 'probe.ts'), `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      const read = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        assert.ok(!String(path).endsWith('.env'), 'dotenv attempted a file read');
        return read.call(this, path, ...args);
      };
      await import('./src/index.ts');
      assert.equal(process.env.ISOLATION_SENTINEL, undefined);
      assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
      assert.equal(process.env.GEMINI_API_KEY, undefined);
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', join(workflowDir, 'src/test-setup.ts'), join(scratch, 'probe.ts')], {
      cwd: workflowDir,
      env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-inherited-key', GEMINI_API_KEY: 'synthetic-inherited-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    child.stderr.on('data', (chunk) => { diagnostics += String(chunk); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, diagnostics);
    } finally { clearTimeout(timeout); }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('native fetch cannot reach an external host, including after loopback redirect', async () => {
  await assert.rejects(fetch('https://example.invalid/'));
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: 'https://example.invalid/redirect-target' });
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await assert.rejects(fetch(`http://127.0.0.1:${address.port}`), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.match(String(error.cause), /net\.connect.*disabled|not allowed/i);
      return true;
    });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('a temporary mock dispatcher is restored after use', async () => {
  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  try {
    setGlobalDispatcher(mock);
    await import('./index.js');
    assert.equal(getGlobalDispatcher(), mock);
    await assert.rejects(fetch('https://example.invalid/'));
  } finally {
    setGlobalDispatcher(previous);
    await mock.close();
  }
  assert.equal(getGlobalDispatcher(), previous);
});

test('startServer cleanup removes timers, handlers, worker hooks and restores dispatcher', async (t) => {
  const { server, startServer } = await import('./index.js');
  const previous = getGlobalDispatcher();
  const rejectionCount = process.listenerCount('unhandledRejection');
  const exceptionCount = process.listenerCount('uncaughtException');
  const interval = t.mock.method(globalThis, 'setInterval');
  const clear = t.mock.method(globalThis, 'clearInterval');
  const stop = startServer({ port: 0, host: '127.0.0.1', dispatcher: previous });
  await once(server, 'listening');
  assert.equal(process.listenerCount('unhandledRejection'), rejectionCount + 1);
  assert.equal(interval.mock.callCount(), 1);
  await stop();
  assert.equal(server.listening, false);
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(process.listenerCount('unhandledRejection'), rejectionCount);
  assert.equal(process.listenerCount('uncaughtException'), exceptionCount);
  assert.equal(server.listenerCount('close'), 0);
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(getGlobalDispatcher(), previous);
});
