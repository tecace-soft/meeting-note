import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLinkUserPrompt, filterLinks, parseLinks, selectLinkCandidates, similarity, type LinkDecision } from './link.js';

const d = (o: Partial<LinkDecision> & { id: string }): LinkDecision => ({ note_id: 'n-old', text: '', status: 'decided', project: null, project_entity_id: null, valid_from: '2026-10-01', ...o });

test('similarity: text overlap plus a same-entity bonus', () => {
  const a = d({ id: 'a', text: '뉴스레터를 9월 1일에 발송한다', project: '뉴스레터' });
  const b = d({ id: 'b', text: '뉴스레터 발송을 11월 1일로 미룬다', project: '뉴스레터' });
  const c = d({ id: 'c', text: 'VPS 서버 CPU 스파이크 원인 제거', project: 'VPS' });
  assert.ok(similarity(a, b) > similarity(a, c));
  const e1 = { ...a, project_entity_id: 'E' };
  const e2 = { ...c, project_entity_id: 'E' };
  assert.ok(similarity(e1, e2) >= 0.3);
});

test('selectLinkCandidates: only earlier decisions from other notes, best first, threshold applied', () => {
  const n = d({ id: 'new', note_id: 'n-new', valid_from: '2026-11-01', text: '뉴스레터 발송을 11월 1일로 변경한다', project: '뉴스레터' });
  const older = [
    d({ id: 'o1', text: '뉴스레터를 9월 1일에 발송한다', project: '뉴스레터', valid_from: '2026-08-20' }),
    d({ id: 'o2', text: '빌링 포털 기본 언어를 영어로', project: 'Billing', valid_from: '2026-09-17' }),
    d({ id: 'later', text: '뉴스레터 발송 11월 1일 확정', project: '뉴스레터', valid_from: '2026-11-03' }),
    d({ id: 'same-note', note_id: 'n-new', text: '뉴스레터 발송 일정', project: '뉴스레터', valid_from: '2026-11-01' }),
  ];
  assert.deepEqual(selectLinkCandidates([n], older).map((c) => c.id), ['o1']);
  assert.deepEqual(selectLinkCandidates([n], []), []);
});

test('parseLinks / filterLinks: tolerant parse, strict filter', () => {
  assert.equal(parseLinks('not json'), null);
  const parsed = parseLinks('```json\n[{"new":"N","old":"O","rel":"Supersedes","confidence":"0.9","reason":"번복"}]\n```');
  assert.ok(parsed && parsed[0].rel === 'supersedes' && parsed[0].confidence === 0.9);
  const kept = filterLinks([
    { new: 'N', old: 'O', rel: 'supersedes', confidence: 0.9, reason: '' },
    { new: 'N', old: 'O', rel: 'supersedes', confidence: 0.95, reason: 'dup' },
    { new: 'N', old: 'O', rel: 'none', confidence: 0.9, reason: '' },
    { new: 'N', old: 'O', rel: 'refines', confidence: 0.6, reason: '' },
    { new: 'X', old: 'O', rel: 'refines', confidence: 0.9, reason: '' },
    { new: 'N', old: 'Y', rel: 'refines', confidence: 0.9, reason: '' },
    { new: 'N', old: 'O', rel: 'conflicts_with', confidence: 0.7, reason: '' },
  ], new Set(['N']), new Set(['O']));
  assert.deepEqual(kept.map((l) => `${l.rel}:${l.confidence}`), ['supersedes:0.9', 'conflicts_with:0.7']);
});

test('buildLinkUserPrompt lists new decisions, past references and candidates with ids', () => {
  const p = buildLinkUserPrompt([d({ id: 'N1', text: 'new one' })], [d({ id: 'O1', text: 'old one' })], [{ text: '지난번에 9/1 발송하기로 했던' }]);
  assert.match(p, /id=N1/);
  assert.match(p, /과거 결정 언급[\s\S]*9\/1 발송/);
  assert.match(p, /이전 결정 후보[\s\S]*id=O1/);
});
