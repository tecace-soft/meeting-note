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

test('entrypoint starts once from root/workflow with tsx and compiled node', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'meeting-note-entry-'));
  try {
    await writeFile(join(scratch, 'package.json'), '{"type":"module"}');
    await symlink(join(workflow, 'node_modules'), join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
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
        assert.equal(starts, globalThis.entryExpectedStarts ?? 1);
        assert.equal(process.env.ENTRY_SENTINEL, undefined);
      });
    `);
    await run([join(workflow, 'node_modules/typescript/bin/tsc'), '--outDir', join(scratch, 'build')], workflow);
    const sourceEntry = join(workflow, 'src/index.ts');
    const compiledEntry = join(scratch, 'build/index.js');
    const sourcePreload = ['--import', pathToFileURL(join(workflow, 'node_modules/tsx/dist/loader.mjs')).href, '--import', join(workflow, 'src/test-setup.ts'), '--import', stub];
    const compiledPreload = ['--import', join(scratch, 'build/test-setup.js'), '--import', stub];
    for (const [label, cwd] of [['root', root], ['workflow', workflow]]) {
      await t.test(`tsx from ${label}`, async () => { await run([...sourcePreload, relative(cwd, sourceEntry)], cwd); });
      await t.test(`compiled node from ${label}`, async () => { await run([...compiledPreload, relative(cwd, compiledEntry)], cwd); });
    }
    await t.test('symbolic-link entrypoints start once with tsx and compiled node', async (t) => {
      const sourceLink = join(scratch, 'linked-index.ts');
      const compiledLink = join(scratch, 'linked-index.js');
      try {
        await symlink(sourceEntry, sourceLink, 'file');
        await symlink(compiledEntry, compiledLink, 'file');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(code ?? '')) {
          t.skip(`Windows file symlinks unavailable: ${code}`);
          return;
        }
        throw error;
      }
      for (const cwd of [root, workflow]) {
        await run([...sourcePreload, relative(cwd, sourceLink)], cwd);
        await run([...compiledPreload, relative(cwd, compiledLink)], cwd);
      }
    });
    for (const [label, argv] of [
      ['missing argv', 'delete process.argv[1]'],
      ['different existing entrypoint', `process.argv[1] = ${JSON.stringify(stub)}`],
      ['unresolvable entrypoint', `process.argv[1] = ${JSON.stringify(join(scratch, 'missing-entry.js'))}`],
    ]) {
      await t.test(`${label} keeps imports inert`, async () => {
        for (const [preload, entry] of [[sourcePreload, sourceEntry], [compiledPreload, compiledEntry]] as const) {
          await run([...preload, '--input-type=module', '--eval', `
            globalThis.entryExpectedStarts = 0;
            ${argv};
            await import(${JSON.stringify(pathToFileURL(entry).href)});
          `], workflow);
        }
      });
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
