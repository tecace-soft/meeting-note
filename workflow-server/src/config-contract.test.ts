import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workflow = fileURLToPath(new URL('../', import.meta.url));
const loader = pathToFileURL(join(workflow, 'node_modules/tsx/dist/loader.mjs')).href;
const preload = join(workflow, 'src/test-setup.ts');
async function run(args: string[], cwd: string) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, output);
  } finally { clearTimeout(timer); }
}

test('T1-0b env contracts preserve absent, empty and explicitly configured values', async (t) => {
  const cases = [
    { label: 'absent', vars: {}, expected: { port: 8787, frontendOrigin: '*', assemblyAiPricePerHourUsd: 0.21, fetchHeadersTimeoutMs: 1200000, geminiApiKey: '' } },
    { label: 'empty defaults and empty API key do not use the Google fallback', vars: { PORT: '', APP_FRONTEND_ORIGIN: '', ASSEMBLYAI_TRANSCRIPTION_PRICE_PER_HOUR_USD: '', WORKFLOW_FETCH_HEADERS_TIMEOUT_MS: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: 'synthetic-google' }, expected: { port: 8787, frontendOrigin: '*', assemblyAiPricePerHourUsd: 0.21, fetchHeadersTimeoutMs: 1200000, geminiApiKey: '' } },
    { label: 'explicit zero and whitespace keep the existing Number semantics', vars: { PORT: '0', APP_FRONTEND_ORIGIN: ' https://app.invalid/ ', ASSEMBLYAI_TRANSCRIPTION_PRICE_PER_HOUR_USD: '0', WORKFLOW_FETCH_HEADERS_TIMEOUT_MS: ' ', GOOGLE_API_KEY: 'synthetic-google' }, expected: { port: 0, frontendOrigin: ' https://app.invalid/ ', assemblyAiPricePerHourUsd: 0, fetchHeadersTimeoutMs: 0, geminiApiKey: 'synthetic-google' } },
  ];
  for (const entry of cases) await t.test(entry.label, () => run(['--import', loader, '--import', preload, '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    delete process.env.GOOGLE_API_KEY;
    Object.assign(process.env, ${JSON.stringify(entry.vars)});
    const { env } = await import(${JSON.stringify(new URL('./index.ts', import.meta.url).href)});
    const expected = ${JSON.stringify(entry.expected)};
    for (const key of Object.keys(expected)) assert.equal(env[key], expected[key], key);
  `], workflow));
});

test('T1-0b dotenv path is the server directory for root/server and tsx/build execution', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'meeting-note-env-contract-'));
  const serverDir = join(scratch, 'workflow-server');
  try {
    // Copy source only. Real repository .env files are never copied or opened.
    await cp(join(workflow, 'src'), join(serverDir, 'src'), { recursive: true });
    await writeFile(join(serverDir, 'package.json'), '{"type":"module"}');
    await symlink(join(workflow, 'node_modules'), join(serverDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(scratch, '.env'), 'CONFIG_CONTRACT_SOURCE=wrong-root\nPORT=9462\n');
    await writeFile(join(serverDir, '.env'), 'CONFIG_CONTRACT_SOURCE=synthetic-server\nPORT=9461\n');
    await run([join(workflow, 'node_modules/typescript/bin/tsc'), '--outDir', join(serverDir, 'build')], workflow);
    for (const skip of [false, true]) {
      const stub = join(serverDir, `probe-${skip}.mjs`);
      await writeFile(stub, `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { Server } from 'node:http';
        const read = fs.readFileSync;
        fs.readFileSync = function(path, ...args) {
          if (String(path).endsWith('.env')) {
            assert.equal(${skip}, false, 'skip flag must prevent every dotenv read');
            assert.equal(String(path), ${JSON.stringify(join(serverDir, '.env'))});
          }
          return read.call(this, path, ...args);
        };
        if (!${skip}) delete process.env.MEETING_NOTE_SKIP_DOTENV;
        let starts = 0;
        Server.prototype.listen = function(port) {
          starts++;
          assert.equal(port, ${skip ? 8787 : 9461});
          setImmediate(() => this.emit('close'));
          return this;
        };
        process.on('beforeExit', () => {
          assert.equal(starts, 1);
          assert.equal(process.env.CONFIG_CONTRACT_SOURCE, ${skip ? 'undefined' : "'synthetic-server'"});
        });
      `);
      for (const [mode, entry] of [['tsx', join(serverDir, 'src/index.ts')], ['build', join(serverDir, 'build/index.js')]]) {
        for (const [cwdLabel, cwd] of [['root', scratch], ['server', serverDir]]) {
          await t.test(`${mode} from ${cwdLabel}, skip=${skip}`, () => run(['--import', loader, '--import', preload, '--import', stub, entry], cwd));
        }
      }
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
