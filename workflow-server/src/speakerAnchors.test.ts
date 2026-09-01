import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchToken, sameName, parseTurns, extractAnchors, applyAnchors, gateSuggestionsWithAnchors,
  discoverBootstrapNames,
  type Anchor,
} from './speakerAnchors.js';
import type { SpeakerSuggestion, SpeakerRosterEntry } from './memory.js';

const ROSTER: SpeakerRosterEntry[] = [
  { speakerId: 'h1', name: 'Hansoo Lee (이한수)', summary: 'backend lead' },
  { speakerId: 'e1', name: 'Eunseok Lee (이은석)', summary: 'designer' },
];
const SELF = 'Andrew Yoo (유영준)';
const KNOWN = [...ROSTER.map((r) => r.name), SELF];

function sug(label: string, name: string | null, confidence: number, opts: Partial<SpeakerSuggestion> = {}): SpeakerSuggestion {
  return {
    label, name, confidence,
    speakerId: opts.speakerId ?? (name ? (ROSTER.find((r) => r.name === name)?.speakerId ?? null) : null),
    isSelf: opts.isSelf ?? false,
    rationale: opts.rationale ?? '',
  };
}

// ---- matchToken (cross-script resolution) ----

test('matchToken resolves a Korean vocative token nested in the roster name', () => {
  assert.equal(matchToken('한수', KNOWN), 'Hansoo Lee (이한수)');
  assert.equal(matchToken('유영준', KNOWN), 'Andrew Yoo (유영준)');
});

test('matchToken resolves a Latin given name as a name part', () => {
  assert.equal(matchToken('hansoo', KNOWN), 'Hansoo Lee (이한수)');
  assert.equal(matchToken('Andrew', KNOWN), 'Andrew Yoo (유영준)');
});

test('matchToken rejects a common noun / non-name and too-short tokens', () => {
  assert.equal(matchToken('선생', KNOWN), null);
  assert.equal(matchToken('the', KNOWN), null);
  assert.equal(matchToken('a', KNOWN), null);
});

// ---- sameName ----

test('sameName matches across script variants and parentheticals', () => {
  assert.equal(sameName('Hansoo Lee (이한수)', '이한수'), true);
  assert.equal(sameName('Andrew Yoo (유영준)', 'Andrew Yoo'), true);
  assert.equal(sameName('Hansoo Lee (이한수)', 'Eunseok Lee (이은석)'), false);
  assert.equal(sameName(null, 'x'), false);
});

// ---- parseTurns ----

test('parseTurns splits labelled lines and folds continuations into the current turn', () => {
  const t = 'Speaker A: hello there\nsecond line\nSpeaker B: hi';
  assert.deepEqual(parseTurns(t, ['Speaker A', 'Speaker B']), [
    { label: 'Speaker A', text: 'hello there\nsecond line' },
    { label: 'Speaker B', text: 'hi' },
  ]);
});

// ---- extractAnchors ----

test('extractAnchors finds a Korean self-introduction as a positive anchor', () => {
  const turns = [{ label: 'Speaker A', text: '저는 유영준입니다. 시작할게요.' }];
  assert.deepEqual(extractAnchors(turns, KNOWN), [{ kind: 'self-intro', label: 'Speaker A', name: SELF }]);
});

test('extractAnchors finds an English self-introduction', () => {
  const turns = [{ label: 'Speaker C', text: "Hi, I'm Hansoo, backend." }];
  assert.deepEqual(extractAnchors(turns, KNOWN), [{ kind: 'self-intro', label: 'Speaker C', name: 'Hansoo Lee (이한수)' }]);
});

test('extractAnchors finds a Korean honorific address as a negative anchor', () => {
  const turns = [{ label: 'Speaker A', text: '한수님, 백엔드 업데이트 좀 주세요.' }];
  assert.deepEqual(extractAnchors(turns, KNOWN), [{ kind: 'address', label: 'Speaker A', name: 'Hansoo Lee (이한수)' }]);
});

test('extractAnchors ignores an honorific on a non-name common noun', () => {
  const turns = [{ label: 'Speaker A', text: '선생님 안녕하세요. 고객님도요.' }];
  assert.deepEqual(extractAnchors(turns, KNOWN), []);
});

// ---- applyAnchors ----

test('VETO: a non-self pick contradicted by an address anchor is dropped and capped', () => {
  const anchors: Anchor[] = [{ kind: 'address', label: 'Speaker A', name: 'Hansoo Lee (이한수)' }];
  const out = applyAnchors([sug('Speaker A', 'Hansoo Lee (이한수)', 0.9)], anchors, ROSTER, SELF);
  assert.equal(out[0].name, null);
  assert.equal(out[0].speakerId, null);
  assert.ok(out[0].confidence <= 0.35);
});

test('OVERRIDE: a self-introduction corrects a wrong non-self pick', () => {
  const anchors: Anchor[] = [{ kind: 'self-intro', label: 'Speaker C', name: 'Hansoo Lee (이한수)' }];
  const out = applyAnchors([sug('Speaker C', 'Eunseok Lee (이은석)', 0.85)], anchors, ROSTER, SELF);
  assert.equal(out[0].name, 'Hansoo Lee (이한수)');
  assert.equal(out[0].speakerId, 'h1');
  assert.equal(out[0].confidence, 0.9);
  assert.equal(out[0].isSelf, false);
});

test('BOOST: a self-introduction confirming the same non-self pick raises confidence', () => {
  const anchors: Anchor[] = [{ kind: 'self-intro', label: 'Speaker C', name: 'Hansoo Lee (이한수)' }];
  const out = applyAnchors([sug('Speaker C', 'Hansoo Lee (이한수)', 0.5)], anchors, ROSTER, SELF);
  assert.equal(out[0].name, 'Hansoo Lee (이한수)');
  assert.equal(out[0].confidence, 0.9);
});

test('CAP: a non-self pick with no anchor is capped to 0.6', () => {
  const out = applyAnchors([sug('Speaker D', 'Eunseok Lee (이은석)', 0.95)], [], ROSTER, SELF);
  assert.equal(out[0].name, 'Eunseok Lee (이은석)');
  assert.equal(out[0].confidence, 0.6);
});

test('CAP does not RAISE an already-low non-self confidence', () => {
  const out = applyAnchors([sug('Speaker D', 'Eunseok Lee (이은석)', 0.3)], [], ROSTER, SELF);
  assert.equal(out[0].confidence, 0.3);
});

test('SELF path is untouched: a self suggestion is neither capped nor vetoed', () => {
  const selfSug = sug('Speaker B', SELF, 0.75, { isSelf: true, speakerId: null });
  const out = applyAnchors([selfSug], [], ROSTER, SELF);
  assert.deepEqual(out[0], selfSug);
});

test('a self-introduction of the SELF only boosts an already-self label (never flips)', () => {
  const anchors: Anchor[] = [{ kind: 'self-intro', label: 'Speaker B', name: SELF }];
  // already self -> boosted
  const boosted = applyAnchors([sug('Speaker B', SELF, 0.6, { isSelf: true })], anchors, ROSTER, SELF);
  assert.equal(boosted[0].confidence, 0.9);
  assert.equal(boosted[0].isSelf, true);
  // non-self label with a self anchor -> left alone (only capped as a normal non-self), never flipped to self
  const nonSelf = applyAnchors([sug('Speaker B', 'Eunseok Lee (이은석)', 0.9)], anchors, ROSTER, SELF);
  assert.equal(nonSelf[0].isSelf, false);
  assert.equal(nonSelf[0].confidence, 0.6);
});

// ---- gateSuggestionsWithAnchors (end to end over a transcript) ----

test('gate end-to-end: vetoes the addressed speaker and caps an unanchored guess', () => {
  const transcript = [
    'Speaker A: 자 시작하죠. 한수님, 백엔드 업데이트 주세요.',
    'Speaker B: 네, 어제 다이어리제이션 캡 작업 끝냈습니다.',
    'Speaker C: 디자인 쪽은 제가 정리해서 공유할게요.',
  ].join('\n');
  const labels = ['Speaker A', 'Speaker B', 'Speaker C'];
  const suggestions = [
    sug('Speaker A', 'Hansoo Lee (이한수)', 0.9), // WRONG: A addressed Hansoo, so A is not Hansoo
    sug('Speaker B', 'Hansoo Lee (이한수)', 0.85), // plausible but unanchored -> capped
    sug('Speaker C', 'Eunseok Lee (이은석)', 0.92), // unanchored -> capped
  ];
  const out = gateSuggestionsWithAnchors(suggestions, transcript, labels, ROSTER, SELF);
  assert.equal(out[0].name, null); // A vetoed
  assert.ok(out[0].confidence <= 0.35);
  assert.ok(out[1].confidence <= 0.6); // B capped
  assert.ok(out[2].confidence <= 0.6); // C capped
});

test('gate returns suggestions unchanged when there is no roster and no self', () => {
  const suggestions = [sug('Speaker A', 'Hansoo Lee (이한수)', 0.9)];
  const out = gateSuggestionsWithAnchors(suggestions, 'Speaker A: hi', ['Speaker A'], [], null);
  assert.deepEqual(out, suggestions);
});

// ---- H7 cold-start anchor bootstrap ----

const LABELS3 = ['Speaker A', 'Speaker B', 'Speaker C'];
// A new person (Michael, not in ROSTER/SELF) introduces themselves AND is addressed = corroborated.
const NEW_INTRO = ['Speaker C: Hi everyone, this is Michael, nice to meet you.', 'Speaker A: Thanks, Michael. Let us start.'].join('\n');

test('discoverBootstrapNames surfaces a corroborated new name + assigns its self-intro label', () => {
  const { newNames, assignment } = discoverBootstrapNames(parseTurns(NEW_INTRO, LABELS3), KNOWN, {});
  assert.deepEqual(newNames, ['Michael']);
  assert.equal(assignment.get('Speaker C'), 'Michael'); // self-intro label
});

test('H7 bootstrap: corroborated self-intro of a new person is suggested (tentative, speakerId null, <=0.8)', () => {
  const out = gateSuggestionsWithAnchors([sug('Speaker C', null, 0)], NEW_INTRO, LABELS3, ROSTER, SELF, { bootstrap: true });
  const c = out.find((s) => s.label === 'Speaker C')!;
  assert.equal(c.name, 'Michael');
  assert.equal(c.speakerId, null); // not in roster yet — created on confirm
  assert.equal(c.isSelf, false);
  assert.ok(c.confidence <= 0.8 && c.confidence > 0);
});

test('H7 is OFF by default: the new name is NOT surfaced unless bootstrap is requested', () => {
  const out = gateSuggestionsWithAnchors([sug('Speaker C', null, 0)], NEW_INTRO, LABELS3, ROSTER, SELF);
  assert.equal(out.find((s) => s.label === 'Speaker C')!.name, null);
});

test('H7 requires CORROBORATION: a single uncorroborated self-intro is NOT bootstrapped', () => {
  const once = 'Speaker C: this is Michael.\nSpeaker A: okay, great.';
  const out = gateSuggestionsWithAnchors([sug('Speaker C', null, 0)], once, LABELS3, ROSTER, SELF, { bootstrap: true });
  assert.equal(out.find((s) => s.label === 'Speaker C')!.name, null);
});

test('H7 stoplist decides a corroborated ROLE NOUN: dropped with stoplist, surfaced without', () => {
  const role = 'Speaker C: 저는 담당자입니다.\nSpeaker A: 담당자님 안녕하세요.'; // 담당자 = "person in charge", not a name
  const withStop = gateSuggestionsWithAnchors([sug('Speaker C', null, 0)], role, LABELS3, ROSTER, SELF, { bootstrap: true, stoplist: true });
  assert.equal(withStop.find((s) => s.label === 'Speaker C')!.name, null); // guarded
  const noStop = gateSuggestionsWithAnchors([sug('Speaker C', null, 0)], role, LABELS3, ROSTER, SELF, { bootstrap: true, stoplist: false });
  assert.equal(noStop.find((s) => s.label === 'Speaker C')!.name, '담당자'); // false-name leaks through
});

test('H7 never touches the self path', () => {
  const out = gateSuggestionsWithAnchors([sug('Speaker A', SELF, 0.9, { isSelf: true, speakerId: null })], NEW_INTRO, LABELS3, ROSTER, SELF, { bootstrap: true });
  const a = out.find((s) => s.label === 'Speaker A')!;
  assert.equal(a.isSelf, true);
  assert.ok(a.confidence >= 0.9);
});
