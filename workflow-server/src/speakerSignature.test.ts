import assert from 'node:assert/strict';
import test from 'node:test';
import {
  tokenize, canonName, buildCorpora, computeIdf, signatureFor, matchLabel, confidenceFrom, decideSuggestions,
  type LabeledUtterance, type RosterEntry,
} from './speakerSignature.js';

const SELF = 'Andrew Yoo (유영준)';
const ROSTER: RosterEntry[] = [
  { speakerId: 'h1', name: 'Hansoo Lee (이한수)' },
  { speakerId: 'e1', name: 'Eunseok Lee (이은석)' },
];
// Distinctive per-person history across two past notes (n1, n2); "update" is a shared common term.
const HISTORY: LabeledUtterance[] = [
  { noteId: 'n1', name: 'Hansoo Lee (이한수)', text: 'backend diarization deploy render update' },
  { noteId: 'n2', name: 'Hansoo Lee (이한수)', text: 'backend api latency polling fix' },
  { noteId: 'n1', name: 'Eunseok Lee (이은석)', text: 'design figma layout spacing update' },
  { noteId: 'n2', name: 'Eunseok Lee (이은석)', text: 'design tokens palette dark theme' },
  { noteId: 'n1', name: SELF, text: 'memory summary injection eval harness backtest' },
];

// ---- tokenize / canonName ----

test('tokenize keeps Korean runs and Latin words, drops 1-char noise and digits', () => {
  assert.deepEqual(tokenize('Backend 2h fix 우리 팀 a'), ['backend', 'fix', '우리']);
});

test('canonName strips a parenthetical script variant', () => {
  assert.equal(canonName('Andrew Yoo (유영준)'), 'andrew yoo');
  assert.equal(canonName('Hansoo Lee'), 'hansoo lee');
});

// ---- buildCorpora / computeIdf ----

test('buildCorpora groups utterances by canonical name across notes', () => {
  const c = buildCorpora(HISTORY);
  assert.equal(c.size, 3);
  assert.equal(c.get('hansoo lee')?.docs.length, 2);
  assert.equal(c.get('andrew yoo')?.docs.length, 1);
});

test('buildCorpora skips non-person names (echoed labels + product name)', () => {
  const c = buildCorpora([
    { noteId: 'n1', name: 'Hansoo Lee (이한수)', text: 'backend diarization deploy' },
    { noteId: 'n1', name: 'Speaker C', text: 'this is an echoed label from bad data' },
    { noteId: 'n1', name: 'meeting note', text: 'the product name is not a person' },
    { noteId: 'n1', name: 'Speaker 4', text: 'another echoed label' },
  ]);
  assert.deepEqual([...c.keys()], ['hansoo lee']);
});

test('computeIdf gives a shared term lower idf than a rare one', () => {
  const idf = computeIdf(buildCorpora(HISTORY));
  // "update" is in 2 people, "backend" in 1 → backend is more discriminative (higher idf).
  assert.ok((idf.get('backend') ?? 0) > (idf.get('update') ?? 0));
});

test('signatureFor excludes the target note (leave-one-meeting-out)', () => {
  const c = buildCorpora(HISTORY);
  const withN1 = signatureFor(c, 'hansoo lee', null);
  const withoutN1 = signatureFor(c, 'hansoo lee', 'n1');
  assert.ok(withN1.has('diarization')); // n1 term present when nothing excluded
  assert.ok(!withoutN1.has('diarization')); // gone once n1 is left out
  assert.ok(withoutN1.has('latency')); // n2 term still there
});

// ---- matchLabel ----

test('matchLabel ranks the person whose history matches the label first', () => {
  const c = buildCorpora(HISTORY);
  const idf = computeIdf(c);
  const ranked = matchLabel('backend diarization pipeline deploy', c, idf, 'nT');
  assert.equal(ranked[0].personKey, 'hansoo lee');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.equal(ranked[0].warm, true);
});

test('matchLabel returns empty for a label with no content tokens', () => {
  const c = buildCorpora(HISTORY);
  assert.deepEqual(matchLabel('a 1 !', c, computeIdf(c), null), []);
});

// ---- confidenceFrom ----

test('confidenceFrom maps a promoted pick into the honest high band, monotonic in top1 and margin', () => {
  const a = confidenceFrom(0.4, 0.1);
  const bHigherTop1 = confidenceFrom(0.6, 0.1);
  const cHigherMargin = confidenceFrom(0.4, 0.0);
  // Every promoted pick clears the 0.7 UI floor and stays honest (< 1).
  assert.ok(a >= 0.7 && a < 1);
  assert.ok(confidenceFrom(0.08, 0.02) >= 0.7); // the weakest promotable pick still clears the floor
  assert.ok(bHigherTop1 > a);
  assert.ok(cHigherMargin > a);
});

// ---- decideSuggestions ----

test('decideSuggestions promotes strong warm matches and resolves speakerId + isSelf', () => {
  const c = buildCorpora(HISTORY);
  const idf = computeIdf(c);
  const labels = [
    { label: 'Speaker A', text: 'backend diarization pipeline deploy render' }, // -> Hansoo
    { label: 'Speaker B', text: 'design figma palette tokens' }, // -> Eunseok
    { label: 'Speaker C', text: 'memory summary injection eval' }, // -> Andrew (self)
    { label: 'Speaker D', text: 'okay yeah sure thanks everyone' }, // -> no signal, fallback
  ];
  // Explicit loose thresholds so this tests the PROMOTION logic, not the shipped default tuning.
  const { signature, fallbackLabels } = decideSuggestions(labels, c, idf, 'nT', ROSTER, SELF, { minSigTokens: 4, tScore: 0.02, tMargin: 0 });

  const byLabel = new Map(signature.map((s) => [s.label, s]));
  assert.equal(byLabel.get('Speaker A')?.name, 'Hansoo Lee (이한수)');
  assert.equal(byLabel.get('Speaker A')?.speakerId, 'h1');
  assert.equal(byLabel.get('Speaker A')?.isSelf, false);
  assert.equal(byLabel.get('Speaker B')?.speakerId, 'e1');
  assert.equal(byLabel.get('Speaker C')?.isSelf, true);
  assert.equal(byLabel.get('Speaker C')?.speakerId, null); // self not a roster row here
  assert.ok((byLabel.get('Speaker A')?.confidence ?? 0) > 0);
  assert.deepEqual(fallbackLabels, ['Speaker D']);
});

test('decideSuggestions falls back a label whose true speaker has no history (cold-start)', () => {
  const c = buildCorpora(HISTORY);
  const idf = computeIdf(c);
  // A brand-new person's words match nobody's signature → fallback, never a wrong signature pick.
  const { signature, fallbackLabels } = decideSuggestions(
    [{ label: 'Speaker A', text: 'quarterly finance budget forecast revenue' }], c, idf, 'nT', ROSTER, SELF, { minSigTokens: 4 },
  );
  assert.equal(signature.length, 0);
  assert.deepEqual(fallbackLabels, ['Speaker A']);
});

test('decideSuggestions never emits two selves (keeps the strongest, demotes the rest)', () => {
  const c = buildCorpora(HISTORY);
  const idf = computeIdf(c);
  // Two labels both look like the self; only one may stay isSelf.
  const labels = [
    { label: 'Speaker A', text: 'memory summary injection eval harness backtest' },
    { label: 'Speaker B', text: 'memory summary injection eval' },
  ];
  const { signature, fallbackLabels } = decideSuggestions(labels, c, idf, 'nT', ROSTER, SELF, { minSigTokens: 4, tScore: 0.02, tMargin: 0 });
  assert.equal(signature.filter((s) => s.isSelf).length, 1);
  assert.equal(signature.length + fallbackLabels.length, 2);
});
