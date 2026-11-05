import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimeline, containsPattern, formatDecision, STATUS_LABELS, type DecisionRow } from './decisionRead.js';
import { DECISION_STATUSES } from '../../decisions/schema.js';

test('containsPattern escapes LIKE wildcards and trims', () => {
  assert.equal(containsPattern('  Repler '), '%Repler%');
  assert.equal(containsPattern('50%_off\\x'), '%50\\%\\_off\\\\x%');
  assert.equal(containsPattern('  '), null);
  assert.equal(containsPattern(undefined), null);
});

test('every status has a label; only decided/customer_decided are final; long text is clipped', () => {
  for (const s of DECISION_STATUSES) assert.ok(STATUS_LABELS[s], s);
  const row = (status: DecisionRow['status']): DecisionRow => ({
    id: 'D:1', note_id: 'n1', seq: 1, text: 'x'.repeat(400), status, side: 'tecace', decided_by: '이한수', participants: [], why: null, trigger: null,
    alternatives_rejected: [], assumptions: [], effective_date: null, project: null, evidence_quote: 'q', evidence_segment_ids: ['s1'], evidence_match: true,
    valid_from: '2026-11-04', invalid_at: null, human_verified: false, meeting_title: 'M', meeting_kind: 'internal', sensitivity: 'normal', total_count: 1,
  });
  assert.equal(formatDecision(row('decided')).isFinal, true);
  assert.equal(formatDecision(row('customer_decided')).isFinal, true);
  for (const s of ['direction', 'proposed', 'deferred', 'status_report', 'info', 'customer_stated'] as const) assert.equal(formatDecision(row(s)).isFinal, false, s);
  assert.match(formatDecision(row('proposed')).statusLabel, /확정 아님/);
  assert.equal(formatDecision(row('decided')).text?.length, 301);
  assert.equal(formatDecision(row('decided'), true).text?.length, 400);
  assert.match(formatDecision(row('decided')).noteUrl, /history\?note=n1$/);
});

test('buildTimeline: chronological, links both ways, current excludes superseded, stale open actions', () => {
  const row = (id: string, date: string, status: DecisionRow['status'], invalid: string | null = null): DecisionRow => ({
    id, note_id: `n-${id}`, seq: 1, text: id, status, side: 'tecace', decided_by: null, participants: [], why: null, trigger: null,
    alternatives_rejected: [], assumptions: [], effective_date: null, project: 'P', evidence_quote: 'q', evidence_segment_ids: [], evidence_match: true,
    valid_from: date, invalid_at: invalid, human_verified: false, meeting_title: id, meeting_kind: 'internal', sensitivity: 'normal', total_count: 3,
  });
  const out = buildTimeline(
    [row('C', '2026-11-01', 'decided'), row('A', '2026-09-01', 'decided', '2026-11-01'), row('B', '2026-10-01', 'proposed')],
    [
      { new_decision: 'C', old_decision: 'A', rel: 'supersedes', confidence: 0.9, reason: '번복', reviewed: false },
      { new_decision: 'C', old_decision: 'B', rel: 'conflicts_with', confidence: 0.8, reason: '충돌', reviewed: false },
    ],
    [
      { id: 'a1', text: 'old plan task', owner: 'x', due: null, from_decision: 'A', status: 'open' },
      { id: 'a2', text: 'done task', owner: 'x', due: null, from_decision: 'A', status: 'done' },
      { id: 'c1', text: 'new task', owner: 'x', due: null, from_decision: 'C', status: 'open' },
    ],
  );
  assert.deepEqual(out.timeline.map((t) => t.id), ['A', 'B', 'C']);
  assert.deepEqual(out.timeline[0].links.map((l) => l.direction), ['later → this']);
  assert.equal(out.timeline[2].links.length, 2);
  assert.deepEqual(out.current.map((c) => c.id), ['C']);
  assert.deepEqual(out.openConflicts.map((c) => `${c.newer}>${c.older}`), ['C>B']);
  assert.deepEqual(out.staleOpenActions.map((a) => a.id), ['a1']);
});
