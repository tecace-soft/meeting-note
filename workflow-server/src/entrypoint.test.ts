import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workflow = fileURLToPath(new URL('../', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
async function run(args: string[], cwd: string) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(code, 0, output);
    return output;
  } finally { clearTimeout(timer); }
}

test('entrypoint starts once from root/workflow with tsx and compiled node', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'meeting-note-entry-'));
  try {
    await writeFile(join(scratch, 'package.json'), '{"type":"module"}');
    await symlink(join(workflow, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    await writeFile(join(scratch, '.env'), 'ENTRY_SENTINEL=dotenv-was-read\n');
    const stub = join(scratch, 'listen.mjs');
    await writeFile(stub, `
      import assert from 'node:assert/strict';
      import { Server } from 'node:http';
      let starts = 0;
      Server.prototype.listen = function() {
        starts++;
        setImmediate(() => this.emit('close'));
        return this;
      };
      process.on('beforeExit', () => {
        assert.equal(starts, 1);
        assert.equal(process.env.ENTRY_SENTINEL, undefined);
      });
    `);
    await run([join(workflow, 'node_modules/typescript/bin/tsc'), '--outDir', join(scratch, 'build')], workflow);
    const preload = ['--import', pathToFileURL(join(workflow, 'node_modules/tsx/dist/loader.mjs')).href, '--import', join(workflow, 'src/test-setup.ts'), '--import', stub];
    for (const cwd of [root, workflow]) {
      await run([...preload, relative(cwd, join(workflow, 'src/index.ts'))], cwd);
      await run(['--import', join(scratch, 'build/test-setup.js'), '--import', stub, relative(cwd, join(scratch, 'build/index.js'))], cwd);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
