import assert from 'node:assert/strict';
import test from 'node:test';
import { containsPattern, formatDecision, STATUS_LABELS, type DecisionRow } from './decisionRead.js';
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
