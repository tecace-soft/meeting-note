import assert from 'node:assert/strict';
import test from 'node:test';
import { applyStatusGuards, applyVerdicts, buildVerifyUserPrompt, evidenceWindow, parseVerdicts, refineDecisionStatuses, type RefinableDecision } from './verify.js';

const d = (o: Partial<RefinableDecision> & { local_id: string }): RefinableDecision => ({
  text: 'x', status: 'decided', side: 'tecace', evidence_quote: 'q', evidence_match: true, evidence_segment_ids: ['s1'], ...o,
});

test('guard: decided without a verbatim quote is lowered; side and status are made consistent', () => {
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
  assert.deepEqual(adj.map((a) => `${a.id}:${a.by}`), ['D-2:evidence-guard', 'D-3:evidence-guard', 'D-4:side-guard', 'D-5:side-guard', 'D-6:evidence-guard', 'D-7:side-guard']);
});

test('verdicts: only lower a status, only within the side, ignore unknown ids', () => {
  const items = [d({ local_id: 'D-1' }), d({ local_id: 'D-2' }), d({ local_id: 'D-3', side: 'partner', status: 'customer_decided' }), d({ local_id: 'D-4', status: 'direction' })];
  const adj = applyVerdicts(items, [
    { id: 'D-1', status: 'deferred', reason: '계속 논의하기로 함' },
    { id: 'D-2', status: 'decided', reason: '합의 있음' },
    { id: 'D-3', status: 'proposed', reason: 'wrong side ladder' }, // not allowed for partner side
    { id: 'D-4', status: 'decided', reason: 'no promotion' },
    { id: 'D-9', status: 'info', reason: 'unknown' },
  ]);
  assert.deepEqual(items.map((i) => i.status), ['deferred', 'decided', 'customer_decided', 'direction']);
  assert.deepEqual(adj, [{ id: 'D-1', from: 'decided', to: 'deferred', by: 'verifier', reason: '계속 논의하기로 함' }]);
});

test('parseVerdicts: strict enum, fences ok, invalid → null', () => {
  assert.deepEqual(parseVerdicts('```json\n{"verdicts":[{"id":"D-1","status":"Info","reason":"의견"}]}\n```'), [{ id: 'D-1', status: 'info', reason: '의견' }]);
  assert.equal(parseVerdicts('{"verdicts":[{"id":"D-1","status":"maybe","reason":""}]}'), null);
  assert.equal(parseVerdicts('not json'), null);
});

test('evidenceWindow / prompt: ±4 segments around the evidence, capped; ids in prompt', () => {
  const segs = Array.from({ length: 20 }, (_, i) => ({ speaker: `S${i}`, text: `line ${i}` }));
  const w = evidenceWindow(['s10'], segs);
  assert.ok(w.startsWith('S6: line 6') && w.endsWith('S14: line 14'));
  assert.equal(evidenceWindow([], segs), '');
  assert.equal(evidenceWindow(['s99'], segs), '');
  const p = buildVerifyUserPrompt([d({ local_id: 'D-7', evidence_segment_ids: ['s0'] })], segs);
  assert.match(p, /## D-7 \(side=tecace, 1차 status=decided\)/);
  assert.match(p, /S0: line 0/);
});

test('refine: no remaining decided items → no model call', async () => {
  const items = [d({ local_id: 'D-1', evidence_match: false }), d({ local_id: 'D-2', status: 'info' })];
  const r = await refineDecisionStatuses({ apiKey: 'unused', model: 'gemini-3.1-flash-lite', decisions: items, segments: [] });
  assert.equal(r.verifier.ran, false);
  assert.deepEqual(items.map((i) => i.status), ['direction', 'info']);
});
