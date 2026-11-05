import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyEvidenceGuard, applySideGuard, applyStatusGuards, applyVerdicts, bestMatchingSegment, buildVerifyUserPrompt,
  evidenceWindow, parseVerdicts, refineDecisionStatuses, type RefinableDecision,
} from './verify.js';
import { TranscriptIndex } from './evidence.js';

const d = (o: Partial<RefinableDecision> & { local_id: string }): RefinableDecision => ({
  text: 'x', status: 'decided', side: 'tecace', evidence_quote: 'q', evidence_match: true, evidence_segment_ids: ['s1'], ...o,
});

test('guards: side/status consistency, then decided without a verbatim quote is lowered', () => {
  const items = [
    d({ local_id: 'D-1' }), // stays
    d({ local_id: 'D-2', evidence_match: false }), // → direction
    d({ local_id: 'D-3', evidence_match: null, evidence_quote: 'summary' }), // → direction
    d({ local_id: 'D-4', side: 'partner' }), // decided on partner side → customer_decided
    d({ local_id: 'D-5', side: 'customer', status: 'proposed' }), // → customer_stated
    d({ local_id: 'D-6', side: 'customer', status: 'customer_decided', evidence_match: false }), // → customer_stated
    d({ local_id: 'D-7', side: 'tecace', status: 'customer_stated' }), // → info
    d({ local_id: 'D-8', status: 'proposed', evidence_match: false }), // untouched
  ];
  const adj = applyStatusGuards(items);
  assert.deepEqual(items.map((i) => i.status), ['decided', 'direction', 'direction', 'customer_decided', 'customer_stated', 'customer_stated', 'info', 'proposed']);
  assert.deepEqual(adj.map((a) => `${a.id}:${a.by}`).sort(), ['D-2:evidence-guard', 'D-3:evidence-guard', 'D-4:side-guard', 'D-5:side-guard', 'D-6:evidence-guard', 'D-7:side-guard'].sort());
  // The side guard alone never touches evidence.
  const only = [d({ local_id: 'X', evidence_match: false })];
  assert.deepEqual(applySideGuard(only), []);
  assert.equal(only[0].status, 'decided');
  assert.equal(applyEvidenceGuard(only)[0].to, 'direction');
});

test('verdicts: only lower a status, only within the side, ignore unknown ids', () => {
  const items = [d({ local_id: 'D-1' }), d({ local_id: 'D-2' }), d({ local_id: 'D-3', side: 'partner', status: 'customer_decided' }), d({ local_id: 'D-4', status: 'direction' })];
  const adj = applyVerdicts(items, [
    { id: 'D-1', status: 'deferred', quote: '', reason: '계속 논의하기로 함' },
    { id: 'D-2', status: 'decided', quote: '', reason: '합의 있음' },
    { id: 'D-3', status: 'proposed', quote: '', reason: 'wrong side ladder' },
    { id: 'D-4', status: 'decided', quote: '', reason: 'no promotion' },
    { id: 'D-9', status: 'info', quote: '', reason: 'unknown' },
  ]);
  assert.deepEqual(items.map((i) => i.status), ['deferred', 'decided', 'customer_decided', 'direction']);
  assert.deepEqual(adj, [{ id: 'D-1', from: 'decided', to: 'deferred', by: 'verifier', reason: '계속 논의하기로 함' }]);
});

test('v2 re-quote: a kept decided item with a non-verbatim quote takes the verifier quote only if it is verbatim', () => {
  const segs = [
    { speaker: 'A', text: '조건부를 항상 달았으면 좋겠어요.' },
    { speaker: 'B', text: '맞아요. 그렇게 쓰셔야겠네요.' },
  ];
  const index = new TranscriptIndex(segs);
  const good = d({ local_id: 'D-1', evidence_quote: '조건부로 쓰기로 합의함', evidence_match: false, evidence_segment_ids: [] });
  const bad = d({ local_id: 'D-2', evidence_quote: '지어낸 인용', evidence_match: false, evidence_segment_ids: [] });
  const adj = applyVerdicts([good, bad], [
    { id: 'D-1', status: 'decided', quote: '조건부를 항상 달았으면 좋겠어요. ... 맞아요. 그렇게 쓰셔야겠네요.', reason: '동의함' },
    { id: 'D-2', status: 'decided', quote: '이런 말은 없었다', reason: '?' },
  ], index);
  assert.equal(good.evidence_match, true);
  assert.deepEqual(good.evidence_segment_ids, ['s0', 's1']);
  assert.equal(bad.evidence_match, false);
  assert.deepEqual(adj.map((a) => `${a.id}:${a.by}`), ['D-1:requote']);
  // The evidence guard then keeps D-1 decided and lowers D-2.
  applyEvidenceGuard([good, bad]);
  assert.deepEqual([good.status, bad.status], ['decided', 'direction']);
});

test('parseVerdicts: strict enum, quote optional, fences ok, invalid → null', () => {
  assert.deepEqual(parseVerdicts('```json\n{"verdicts":[{"id":"D-1","status":"Info","reason":"의견"}]}\n```'), [{ id: 'D-1', status: 'info', quote: '', reason: '의견' }]);
  assert.equal(parseVerdicts('{"verdicts":[{"id":"D-1","status":"maybe","reason":""}]}'), null);
  assert.equal(parseVerdicts('not json'), null);
});

test('evidence window: around evidence segments, else around the best-matching segment', () => {
  const segs = Array.from({ length: 30 }, (_, i) => ({ speaker: `S${i}`, text: `line ${i} 일반 대화` }));
  segs[20] = { speaker: 'S20', text: '셰어드풀 운영을 계약상에 명시했고 그룹장님 동의를 받았습니다' };
  const w = evidenceWindow(['s10'], segs);
  assert.ok(w.startsWith('S6:') && w.trimEnd().endsWith('S14: line 14 일반 대화'));
  assert.equal(bestMatchingSegment('셰어드풀 운영을 계약에 명시하고 동의 받음', segs), 20);
  const searched = evidenceWindow([], segs, '셰어드풀 운영을 계약에 명시하고 동의 받음');
  assert.ok(searched.includes('S20: 셰어드풀') && searched.startsWith('S14:'));
  assert.equal(evidenceWindow([], segs, 'zzzz qqqq'), '');
  const p = buildVerifyUserPrompt([d({ local_id: 'D-7', evidence_segment_ids: [], evidence_match: false, evidence_quote: '셰어드풀 운영 계약 명시 동의' })], segs);
  assert.match(p, /## D-7 \(side=tecace, 1차 status=decided\)/);
  assert.match(p, /일치하지 않는다/);
  assert.match(p, /S20: 셰어드풀/);
});

test('refine: no final items → no model call, evidence guard still runs', async () => {
  const items = [d({ local_id: 'D-1', status: 'direction', evidence_match: false }), d({ local_id: 'D-2', status: 'info' })];
  const r = await refineDecisionStatuses({ apiKey: 'unused', model: 'gemini-3.1-flash-lite', decisions: items, segments: [] });
  assert.equal(r.verifier.ran, false);
  assert.deepEqual(items.map((i) => i.status), ['direction', 'info']);
});

test('v3 agreement guard: marker or two speakers keeps decided; single-speaker opinion/pitch/plan is lowered', async () => {
  const { applyAgreementGuard, hasAgreementMarker, evidenceSpeakerCount } = await import('./verify.js');
  const segs = [
    { speaker: 'A', text: '이번 구조는 직접 하는 게 훨씬 효과가 좋다고 생각합니다.' },
    { speaker: 'A', text: '7개월이라는 입장을 잡았고 이렇게 제안드립니다.' },
    { speaker: 'B', text: '기본으로 영어로 하세요.' },
    { speaker: 'A', text: '네 그렇게 할게요.' },
    { speaker: 'C', text: '계약상에 명시했고 그룹장님 동의를 받아서 운영합니다.' },
    { speaker: 'D', text: '운영계약은 월별이 아니면 안 되는 걸로 지원팀에서 결정을 냈다.' },
  ];
  const items = [
    d({ local_id: 'opinion', evidence_quote: segs[0].text, evidence_segment_ids: ['s0'] }),
    d({ local_id: 'pitch', evidence_quote: segs[1].text, evidence_segment_ids: ['s1'] }),
    d({ local_id: 'two-speakers', evidence_quote: '기본으로 영어로 하세요. 네 그렇게 할게요.', evidence_segment_ids: ['s2', 's3'] }),
    d({ local_id: 'reported-agreement', evidence_quote: segs[4].text, evidence_segment_ids: ['s4'] }),
    d({ local_id: 'customer-decided', side: 'customer', status: 'customer_decided', evidence_quote: segs[5].text, evidence_segment_ids: ['s5'] }),
    d({ local_id: 'not-final', status: 'proposed', evidence_quote: segs[0].text, evidence_segment_ids: ['s0'] }),
  ];
  const adj = applyAgreementGuard(items, segs);
  assert.deepEqual(items.map((i) => `${i.local_id}:${i.status}`), [
    'opinion:direction', 'pitch:direction', 'two-speakers:decided', 'reported-agreement:decided', 'customer-decided:customer_decided', 'not-final:proposed',
  ]);
  assert.deepEqual(adj.map((a) => a.by), ['agreement-guard', 'agreement-guard']);
  assert.equal(hasAgreementMarker('보완 버전을 월요일날 업데이트 하기로 했다'), true);
  assert.equal(hasAgreementMarker('88로 그럼 그렇게 하겠습니다'), true);
  assert.equal(hasAgreementMarker("Let's go with the OpenAI agent"), true);
  assert.equal(hasAgreementMarker('결정이 필요한 부분이라 오늘은 답을 드리기 힘들 것 같고'), false);
  assert.equal(evidenceSpeakerCount(['s2', 's3', 's99'], segs), 2);
});

test('v4 strict: hedged commitments are lowered; polite advice + acceptance stays decided', async () => {
  const { applyAgreementGuard, hasCommitmentHedge } = await import('./verify.js');
  const segs = [
    { speaker: 'A', text: '클라이언트 앱만 만들어주면 쉽지.' },
    { speaker: 'B', text: '맞아요. 클라이언트만 만드는 거예요. 저는 그렇게 보고 있어요.' },
    { speaker: 'C', text: '오케이, 그런 식으로 결정될 것 같아요.' },
    { speaker: 'D', text: '기술적인 리더십을 내세우면 문제가 생길 수 있을 것 같아요.' },
    { speaker: 'E', text: '알겠습니다.' },
  ];
  const items = [
    d({ local_id: 'view', evidence_quote: '클라이언트 앱만 만들어주면 쉽지. 맞아요. 클라이언트만 만드는 거예요. 저는 그렇게 보고 있어요.', evidence_segment_ids: ['s0', 's1'] }),
    d({ local_id: 'guess', evidence_quote: segs[2].text, evidence_segment_ids: ['s1', 's2'] }),
    d({ local_id: 'or-something', evidence_quote: 'there will be a commission, like 20 or something. I totally agree with that.', evidence_segment_ids: ['s0', 's1'] }),
    d({ local_id: 'advice-accepted', evidence_quote: '기술적인 리더십을 내세우면 문제가 생길 수 있을 것 같아요. 알겠습니다.', evidence_segment_ids: ['s3', 's4'] }),
  ];
  const adj = applyAgreementGuard(items, segs);
  assert.deepEqual(items.map((i) => `${i.local_id}:${i.status}`), ['view:direction', 'guess:direction', 'or-something:direction', 'advice-accepted:decided']);
  assert.ok(adj.every((a) => a.reason.includes('hedged')));
  assert.equal(hasCommitmentHedge('그 정도면 괜찮을 것 같아요'), false);
  assert.equal(hasCommitmentHedge('아마 그쪽으로 다 들어갈 것 같아요'), true);
});
