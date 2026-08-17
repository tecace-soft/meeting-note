import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeForFingerprint,
  incidentFingerprint,
  opsSeverityToPriority,
  matchOpsTicket,
  bumpOccurrence,
  makeOpsIssueKey,
  buildOpsTicketDescription,
  type OpsSuggestionMeta,
} from './opsAgent.js';

test('normalizeForFingerprint collapses uuids, numbers, hex, and paths', () => {
  const a = normalizeForFingerprint('job 7f20f70c-1234-4a2b-8c3d-abcdef012345 failed at /tmp/x/abc.wav (0xDEADBEEF) after 3 tries');
  const b = normalizeForFingerprint('job 11111111-2222-4333-8444-555566667777 failed at /var/y/def.wav (0xCAFEBABE) after 9 tries');
  assert.equal(a, b, 'volatile tokens must normalize to the same string');
  assert.match(a, /<uuid>/);
  assert.match(a, /<path>/);
  assert.match(a, /<n>/);
});

test('incidentFingerprint is stable across volatile ids but distinct across failure classes', () => {
  const jobA = incidentFingerprint('Summarize audio job failed', 'Error', 'timeout for note 7f20f70c-1111-4a2b-8c3d-abcdef012345 after 3 attempts');
  const jobB = incidentFingerprint('Summarize audio job failed', 'Error', 'timeout for note 22222222-3333-4a2b-8c3d-abcdef012345 after 9 attempts');
  assert.equal(jobA, jobB, 'same failure class (only ids differ) => same fingerprint');
  assert.equal(jobA.length, 16);

  const other = incidentFingerprint('Uncaught workflow exception', 'TypeError', 'Cannot read properties of undefined');
  assert.notEqual(jobA, other, 'different failure class => different fingerprint');
});

test('opsSeverityToPriority maps error high / warning medium', () => {
  assert.deepEqual(opsSeverityToPriority('error'), { priority: 'P2', severity: 'High' });
  assert.deepEqual(opsSeverityToPriority('warning'), { priority: 'P3', severity: 'Medium' });
});

function meta(fingerprint: string, occurrences = 1): OpsSuggestionMeta {
  return { source: 'f9-ops-agent', fingerprint, occurrences, firstSeen: 't0', lastSeen: 't0', environment: 'test', severity: 'error' };
}

test('matchOpsTicket finds only same-fingerprint f9 rows', () => {
  const rows = [
    { id: 'human', ai_suggestion: { source: 'auto-classify', fingerprint: 'deadbeefdeadbeef' } },
    { id: 'other', ai_suggestion: meta('0000000000000000') },
    { id: 'hit', ai_suggestion: meta('abcabcabcabcabca', 3) },
  ];
  const hit = matchOpsTicket(rows, 'abcabcabcabcabca');
  assert.equal(hit?.id, 'hit');
  assert.equal(hit?.meta.occurrences, 3);
  assert.equal(matchOpsTicket(rows, 'ffffffffffffffff'), null, 'no fingerprint match => null');
});

test('matchOpsTicket ignores non-f9 suggestions and null/garbage', () => {
  const rows = [
    { id: 'null', ai_suggestion: null },
    { id: 'string', ai_suggestion: 'not-an-object' },
    { id: 'wrong-source', ai_suggestion: { source: 'other', fingerprint: 'abcabcabcabcabca' } },
  ];
  assert.equal(matchOpsTicket(rows, 'abcabcabcabcabca'), null);
});

test('bumpOccurrence increments and advances lastSeen without mutating input', () => {
  const original = meta('abcabcabcabcabca', 2);
  const bumped = bumpOccurrence(original, 't5');
  assert.equal(bumped.occurrences, 3);
  assert.equal(bumped.lastSeen, 't5');
  assert.equal(bumped.firstSeen, 't0', 'firstSeen preserved');
  assert.equal(original.occurrences, 2, 'input not mutated');
});

test('bumpOccurrence defaults a missing/invalid counter to 1 -> 2', () => {
  const broken = { ...meta('abcabcabcabcabca'), occurrences: NaN };
  assert.equal(bumpOccurrence(broken, 't1').occurrences, 2);
});

test('makeOpsIssueKey formats UTC date + uppercased random', () => {
  const key = makeOpsIssueKey(new Date('2026-08-17T09:05:00Z'), 'a1b2c3d4');
  assert.equal(key, 'OPS-20260817-A1B2C3D4');
});

test('buildOpsTicketDescription bounds length', () => {
  const desc = buildOpsTicketDescription({
    title: 'x',
    err: { name: 'Error', message: 'y', stack: 'z'.repeat(50000) },
    contextText: '{}',
    maxLength: 8000,
  });
  assert.ok(desc.length <= 8000);
});
