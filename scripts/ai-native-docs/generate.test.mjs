import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildStructureRegion } from './generate.mjs';

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
