// Offline drift test for Gemini model-name strings. No network, no API key.
// It scans backend + edge-function source for quoted gemini-* string literals
// and fails if any literal is a retired model or is absent from the central
// registry (gemini-models.ts). This is the guard that stops a dead id (such as
// the retired gemini-2.0 family) from re-appearing and forces a new model to be
// registered consciously.
//
// Modeled on the AXBilling stripe-api-version.test.ts pattern: a bounded file
// walk, CRLF-normalized reads, and skipped build/vendor dirs.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_MODELS,
  LIVE_MODELS,
  liteModelFromEnv,
  isLiteModel,
  isRetiredModel,
  assertLiveModel,
  SUMMARY_MODEL,
  REGENERATE_SUMMARY_MODEL,
  MEMORY_MODEL,
  PROJECT_CHAT_MODEL,
  TRANSCRIPTION_TEST_MODEL,
  STANDARD_FALLBACK_CHAIN,
  MEMORY_FALLBACK_CHAIN,
  ISSUE_RESOLUTION_FALLBACK_CHAIN,
  ISSUE_RESOLUTION_MODEL,
} from './gemini-models.js';
import { calculateGeminiUsageCost } from './costs.js';

// This file lives at <repo>/workflow-server/src/gemini-models.test.ts.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'workflow-server', 'src'),
  path.join(REPO_ROOT, 'supabase', 'functions'),
];

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'coverage', '.git']);
// The registry legitimately names retired ids and the full known list, so it is
// excluded. Test files (*.test.ts) are also excluded: they carry synthetic
// fixtures (for example a deliberately fake modelVersion alias) that are not
// real model ids and never reach the API. Production model usage, the surface
// that caused the real 404, lives in non-test source and is fully scanned.
const SELF_FILES = new Set(['gemini-models.ts']);

// DEC-0005: production may use only lite-tier Gemini models.
const LITE_ONLY = /^gemini-\d[\d.]*-flash-lite$/;

const MAX_FILES = 20000;
const MAX_DEPTH = 20;

// Matches a quoted Gemini model-id string literal: an opening quote (single,
// double, or backtick), then gemini-, a numeric version, a dash, and at least
// one letter. The trailing-letter requirement means prose wildcards like
// gemini-2.0-* do NOT match. Requiring a quote means bare mentions in comments
// (for example gemini-3.5-flash-lite named in a caution comment) are ignored;
// only real string literals are checked.
const MODEL_LITERAL = /['"`](gemini-\d[\d.]*-[a-z][a-z-]*)/g;

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a scan root that does not exist is not a failure
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    if (SELF_FILES.has(entry.name)) continue;
    out.push(full);
  }
}

function listTsFiles(): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, 0, found);
  return found;
}

function literalsIn(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const ids: string[] = [];
  MODEL_LITERAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = MODEL_LITERAL.exec(normalized)) !== null) {
    ids.push(match[1]);
    if (++guard > 100000) break; // bounded against a pathological input
  }
  return ids;
}

test('no scanned source literal is a retired or unregistered Gemini model', () => {
  const files = listTsFiles();
  assert.ok(files.length > 0, 'drift scan found no .ts files; SCAN_ROOTS may be wrong');

  const retired: string[] = [];
  const unknown: string[] = [];
  const nonLite: string[] = [];
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    for (const id of literalsIn(fs.readFileSync(file, 'utf8'))) {
      if (!LITE_ONLY.test(id)) nonLite.push(`${rel}: "${id}"`);
      if (isRetiredModel(id)) retired.push(`${rel}: "${id}"`);
      else if (!KNOWN_MODELS.has(id)) unknown.push(`${rel}: "${id}"`);
    }
  }

  assert.deepEqual(
    nonLite,
    [],
    `Non-lite Gemini model id(s) in production source. DEC-0005 allows only flash-lite models: ${nonLite.join(', ')}`,
  );
  assert.deepEqual(
    retired,
    [],
    `Retired Gemini model id(s) found in source (the gemini-2.0 family is dead, 404). Remove them:\n${retired.join('\n')}`,
  );
  assert.deepEqual(
    unknown,
    [],
    `Gemini model id(s) not in the registry. Add to workflow-server/src/gemini-models.ts if real and live:\n${unknown.join('\n')}`,
  );
});

test('literal regex matches real ids but not the gemini-2.0-* wildcard or bare comment mentions', () => {
  assert.deepEqual(literalsIn(`const a = 'gemini-2.5-flash-lite';`), ['gemini-2.5-flash-lite']);
  assert.deepEqual(literalsIn(`["gemini-2.5-flash", 'gemini-3.1-flash-lite']`), ['gemini-2.5-flash', 'gemini-3.1-flash-lite']);
  assert.deepEqual(literalsIn(`// both gemini-2.0-* were retired`), []); // the * has no trailing letter
  assert.deepEqual(literalsIn(`"gemini-2.0-*"`), []);
  assert.deepEqual(literalsIn(`// e.g. gemini-3.5-flash-lite rejects thinkingBudget:0`), []); // bare mention, not a literal
});

test('every role default is live and not retired', () => {
  const roles: Array<[string, string]> = [
    ['SUMMARY_MODEL', SUMMARY_MODEL],
    ['REGENERATE_SUMMARY_MODEL', REGENERATE_SUMMARY_MODEL],
    ['MEMORY_MODEL', MEMORY_MODEL],
    ['PROJECT_CHAT_MODEL', PROJECT_CHAT_MODEL],
    ['TRANSCRIPTION_TEST_MODEL', TRANSCRIPTION_TEST_MODEL],
  ];
  for (const [name, id] of roles) {
    assert.ok(KNOWN_MODELS.has(id), `${name} (${id}) is not in LIVE_MODELS`);
    assert.equal(isRetiredModel(id), false, `${name} (${id}) is retired`);
  }
});

test('every fallback chain entry is live and not retired', () => {
  const chains: Array<[string, readonly string[]]> = [
    ['STANDARD_FALLBACK_CHAIN', STANDARD_FALLBACK_CHAIN],
    ['MEMORY_FALLBACK_CHAIN', MEMORY_FALLBACK_CHAIN],
    ['ISSUE_RESOLUTION_FALLBACK_CHAIN', ISSUE_RESOLUTION_FALLBACK_CHAIN],
    ['ISSUE_RESOLUTION_MODEL', [ISSUE_RESOLUTION_MODEL]],
  ];
  for (const [name, chain] of chains) {
    assert.ok(chain.length > 0, `${name} is empty`);
    for (const id of chain) {
      assert.ok(KNOWN_MODELS.has(id), `${name}: ${id} is not in LIVE_MODELS`);
      assert.equal(isRetiredModel(id), false, `${name}: ${id} is retired`);
    }
  }
});

test('isRetiredModel catches the whole gemini-2.0 family and clears live ids', () => {
  for (const id of ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-pro', 'gemini-2.0-flash-001']) {
    assert.equal(isRetiredModel(id), true, `${id} should be retired`);
  }
  assert.equal(isRetiredModel('gemini-2.5-flash-lite'), false);
  assert.equal(isRetiredModel('gemini-3.1-flash-lite'), false);
});

test('assertLiveModel throws on retired/empty/unknown and returns live ids', () => {
  assert.throws(() => assertLiveModel('gemini-2.0-flash'), /retired/);
  assert.throws(() => assertLiveModel(''), /non-empty/);
  assert.throws(() => assertLiveModel('gemini-9.9-imaginary'), /not in the registry/);
  assert.equal(assertLiveModel('gemini-2.5-flash-lite'), 'gemini-2.5-flash-lite');
});

test('DEC-0005: registry, role defaults and every chain are lite-only and chains end in a lite model', () => {
  for (const id of LIVE_MODELS) assert.match(id, LITE_ONLY, `LIVE_MODELS entry ${id} is not flash-lite`);
  const singles: Array<[string, string]> = [
    ['SUMMARY_MODEL', SUMMARY_MODEL],
    ['REGENERATE_SUMMARY_MODEL', REGENERATE_SUMMARY_MODEL],
    ['MEMORY_MODEL', MEMORY_MODEL],
    ['PROJECT_CHAT_MODEL', PROJECT_CHAT_MODEL],
    ['TRANSCRIPTION_TEST_MODEL', TRANSCRIPTION_TEST_MODEL],
    ['ISSUE_RESOLUTION_MODEL', ISSUE_RESOLUTION_MODEL],
  ];
  for (const [name, id] of singles) assert.match(id, LITE_ONLY, `${name} (${id}) is not flash-lite`);
  const chains: Array<[string, readonly string[]]> = [
    ['STANDARD_FALLBACK_CHAIN', STANDARD_FALLBACK_CHAIN],
    ['MEMORY_FALLBACK_CHAIN', MEMORY_FALLBACK_CHAIN],
    ['ISSUE_RESOLUTION_FALLBACK_CHAIN', ISSUE_RESOLUTION_FALLBACK_CHAIN],
  ];
  for (const [name, chain] of chains) {
    for (const id of chain) assert.match(id, LITE_ONLY, `${name}: ${id} is not flash-lite`);
    const last = chain[chain.length - 1];
    assert.ok(KNOWN_MODELS.has(last) && !isRetiredModel(last), `${name} must end in a live lite model`);
  }
});

test('lite-only matcher rejects non-lite ids', () => {
  for (const id of ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro', 'gemini-2.5-flash-preview']) {
    assert.doesNotMatch(id, LITE_ONLY);
  }
  assert.match('gemini-3.1-flash-lite', LITE_ONLY);
  assert.match('gemini-2.5-flash-lite', LITE_ONLY);
});

test('liteModelFromEnv: unset or blank uses the default silently', () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  assert.equal(liteModelFromEnv('X_MODEL', undefined, SUMMARY_MODEL, warn), SUMMARY_MODEL);
  assert.equal(liteModelFromEnv('X_MODEL', '   ', SUMMARY_MODEL, warn), SUMMARY_MODEL);
  assert.deepEqual(warnings, []);
});

test('liteModelFromEnv: a valid lite model is used without a warning', () => {
  const warnings: string[] = [];
  const out = liteModelFromEnv('X_MODEL', ' gemini-3.1-flash-lite ', SUMMARY_MODEL, (m) => warnings.push(m));
  assert.equal(out, 'gemini-3.1-flash-lite');
  assert.deepEqual(warnings, []);
});

test('liteModelFromEnv: a non-lite model warns once naming the env var and uses the default', () => {
  const warnings: string[] = [];
  const out = liteModelFromEnv('GEMINI_SUMMARY_MODEL', 'gemini-2.5-flash', SUMMARY_MODEL, (m) => warnings.push(m));
  assert.equal(out, SUMMARY_MODEL);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GEMINI_SUMMARY_MODEL/);
});

test('liteModelFromEnv: an unknown or retired id warns once and uses the default', () => {
  for (const bad of ['gemini-9.9-flash-lite', 'gemini-2.0-flash-lite', 'not-a-model']) {
    const warnings: string[] = [];
    assert.equal(liteModelFromEnv('ISSUE_RESOLUTION_MODEL', bad, ISSUE_RESOLUTION_MODEL, (m) => warnings.push(m)), ISSUE_RESOLUTION_MODEL);
    assert.equal(warnings.length, 1, `expected one warning for ${bad}`);
    assert.match(warnings[0], /ISSUE_RESOLUTION_MODEL/);
  }
  assert.equal(isLiteModel('gemini-2.5-flash'), false);
});

test('every LIVE_MODELS entry has a nonzero price in costs.ts', () => {
  for (const model of LIVE_MODELS) {
    for (const inputType of ['audio', 'text'] as const) {
      const cost = calculateGeminiUsageCost({
        model,
        inputType,
        usageMetadata: { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000, totalTokenCount: 2_000_000 },
      });
      assert.ok(cost.estimatedCostUsd > 0, `${model} (${inputType}) has no price in costs.ts`);
    }
  }
});
