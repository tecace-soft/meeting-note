import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildStructureRegion, readTrackedFiles } from './generate.mjs';

const FILES = [
  'src/App.tsx',
  'src/components/a.tsx',
  'src/components/deep/b.tsx',
  'workflow-server/src/index.ts',
  'node_modules/x/y.js',
  'dist/out.js',
  '.github/workflows/ci.yml',
  'README.md',
];

test('structure region lists tracked directories only, pruned and depth-bounded', () => {
  const out = buildStructureRegion(FILES).split('```text')[1].split('```')[0];
  assert.match(out, /├── src\//);
  assert.match(out, /workflow-server\//);
  assert.doesNotMatch(out, /node_modules|dist|\.github/);
  assert.doesNotMatch(out, /deep\//);
});

test('an untracked folder (absent from the file list) never appears', () => {
  const out = buildStructureRegion(FILES);
  assert.doesNotMatch(out, /public\//);
  assert.doesNotMatch(out, /\| `product-page\/`/);
});

test('output is deterministic regardless of file order', () => {
  assert.equal(buildStructureRegion(FILES), buildStructureRegion([...FILES].reverse()));
});

test('generator writes no history region and history.md has no markers', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(dir, 'generate.mjs'), 'utf8');
  assert.doesNotMatch(src, /buildHistoryRegion|readGitSubjects|section=history\s*-->'/);
  const history = readFileSync(join(dir, '..', '..', 'docs', 'ai-native', 'history.md'), 'utf8');
  assert.doesNotMatch(history, /ai-native:auto/);
});

test('sibling order is plain code-point order (uppercase, underscore, dash)', () => {
  const out = buildStructureRegion(['b/x', 'a_b/x', 'a-b/x', 'B/x', 'a/x', 'A/x', '_z/x']);
  const names = out.split('```text')[1].split('```')[0].split('\n').filter((l) => l.includes('/')).map((l) => l.replace(/^[^a-zA-Z_-]*/, ''));
  assert.deepEqual(names, ['A/', 'B/', '_z/', 'a/', 'a-b/', 'a_b/', 'b/']);
});

test('readTrackedFiles lists tracked files only, in a real repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-native-git-'));
  try {
    const run = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
    run('init', '-q');
    mkdirSync(join(dir, 'tracked'));
    mkdirSync(join(dir, 'untracked'));
    writeFileSync(join(dir, 'tracked', 'a.txt'), '1');
    writeFileSync(join(dir, 'untracked', 'b.txt'), '2');
    run('add', 'tracked/a.txt');
    run('commit', '-q', '-m', 'init');
    assert.deepEqual(readTrackedFiles(dir), ['tracked/a.txt']);
    assert.doesNotMatch(buildStructureRegion(readTrackedFiles(dir)), /untracked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
