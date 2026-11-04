import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDecisionExtraction } from './schema.js';
import { EntityResolver, isSpeakerLabel } from './normalize.js';
import { TranscriptIndex } from './evidence.js';
import { buildExtractionPayload, idPrefix } from './store.js';
import { meetingDateOf, prepareInput } from './job.js';
import { DECISION_SYSTEM_PROMPT, buildDecisionUserPrompt } from './prompt.js';

// Synthetic fixture only (no real meeting content).
const segments = [
  { speaker: '이한수', text: '이번 분기에는 결정 기록 기능을 먼저 만들기로 합시다. 요약 포맷은 그대로 둡니다.' },
  { speaker: 'Andrew', text: '좋습니다. 제가 다음 주 금요일까지 마이그레이션 초안을 올리겠습니다.' },
  { speaker: 'Speaker C', text: '모델은 lite로 충분한지 아직 모르겠어요. 비교해 보면 좋겠습니다.' },
];

function validJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    meeting: {
      meeting_note_id: 'note-abc-123', date: '2026-11-04', title: '결정 기록 기능 착수', meeting_kind: 'internal-dev',
      participants: [{ name: '이한수', org: 'TecAce', role: 'owner' }, { name: 'Andrew', org: 'TecAce', role: '' }, { name: 'Speaker C' }],
      orgs: ['TecAce'], projects: ['Meeting Note'], purpose: '착수 범위 결정', sensitivity: 'normal', quality: 'ok',
      quality_notes: 'alias 후보: Mtg Note → Meeting Note',
    },
    decisions: [
      { id: 'D-1', text: '결정 기록 기능을 이번 분기에 먼저 만든다', status: 'decided', side: 'tecace', by: '이한수', with: ['Andrew'],
        why: null, trigger: null, alternatives_rejected: [], assumptions: [], effective_date: null, project: 'Meeting Note',
        evidence: '이번 분기에는 결정 기록 기능을 먼저 만들기로 합시다' },
      { id: 'D-2', text: 'lite 모델로 충분한지 비교한다', status: 'proposed', side: 'tecace', by: 'Speaker C (추정)', with: [],
        why: null, trigger: null, alternatives_rejected: [], assumptions: [], effective_date: null, project: 'Meeting Note',
        evidence: '모델은 lite로 충분한지 아직 모르겠어요' },
    ],
    actions: [{ id: 'A-1', text: '마이그레이션 초안', owner: 'Andrew', due: '다음 주 금요일', from_decision: 'D-1', evidence: 'Andrew: 제가 다음 주 금요일까지 마이그레이션 초안을 올리겠습니다' }],
    issues: [{ id: 'I-1', text: '모델 충분성 불명', type: 'open_question', raised_by: 'Speaker C', evidence: 'summary' }],
    references_to_past: [],
    ...overrides,
  });
}

test('schema: accepts a valid extraction and strips code fences', () => {
  const r = parseDecisionExtraction('```json\n' + validJson() + '\n```');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.decisions.length, 2);
});

test('schema: rejects a status outside the fixed 8-value taxonomy', () => {
  const json = JSON.parse(validJson());
  json.decisions[0].status = 'confirmed';
  const r = parseDecisionExtraction(JSON.stringify(json));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /decisions\.0\.status/);
});

test('schema: rejects invalid JSON, unknown meeting_kind, bad issue type and duplicate decision ids', () => {
  assert.equal(parseDecisionExtraction('{"meeting": ').ok, false);
  const kind = JSON.parse(validJson()); kind.meeting.meeting_kind = 'social';
  assert.equal(parseDecisionExtraction(JSON.stringify(kind)).ok, false);
  const issue = JSON.parse(validJson()); issue.issues[0].type = 'blocker';
  assert.equal(parseDecisionExtraction(JSON.stringify(issue)).ok, false);
  const dup = JSON.parse(validJson()); dup.decisions[1].id = 'D-1';
  assert.equal(parseDecisionExtraction(JSON.stringify(dup)).ok, false);
});

test('schema: tolerates shape noise without changing meaning', () => {
  const json = JSON.parse(validJson());
  delete json.decisions[0].alternatives_rejected;
  json.decisions[0].why = 'null';
  json.meeting.sensitivity = null;
  json.meeting.participants = ['이한수'];
  json.decisions[0].status = 'Decided';
  const r = parseDecisionExtraction(JSON.stringify(json));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value.decisions[0].alternatives_rejected, []);
    assert.equal(r.value.decisions[0].why, null);
    assert.equal(r.value.meeting.sensitivity, 'normal');
    assert.equal(r.value.decisions[0].status, 'decided');
  }
});

test('normalize: seed aliases resolve to canonical names; 강성원 and 강사장 stay distinct', () => {
  const r = new EntityResolver();
  assert.equal(r.resolve('project', 'Ripler'), 'Niffler');
  assert.equal(r.resolve('person', 'andrew'), 'Andrew Yoo');
  assert.equal(r.resolve('person', '김상훈'), '김성훈');
  assert.equal(r.resolve('person', 'Kotak'), '김교탁');
  assert.equal(r.resolve('person', '강성원'), '강성원');
  assert.equal(r.resolve('person', '강사장'), '강사장');
  assert.notEqual(r.resolve('person', '강성원(Samsung)'), r.resolve('person', '강사장(TecAce)'));
  assert.equal(r.resolve('person', 'Gene (추정)'), 'Gene Kim (추정)');
  assert.equal(r.candidates.length, 0);
});

test('normalize: unknown names are kept and logged; speaker labels are not', () => {
  const r = new EntityResolver();
  assert.equal(r.resolve('person', '홍길동'), '홍길동');
  assert.equal(r.resolve('person', '홍길동'), '홍길동');
  assert.equal(r.resolve('person', 'Speaker B'), 'Speaker B');
  assert.equal(isSpeakerLabel('화자 2'), true);
  assert.deepEqual(r.candidates, [{ type: 'person', raw: '홍길동', source: 'unknown_name' }]);
  r.collectQualityNoteHints('전사 오류 있음. alias 후보: Mtg Note → Meeting Note; alias 후보: 한창 -> 한창환');
  assert.deepEqual(r.candidates.slice(1).map((c) => [c.raw, c.suggested]), [['Mtg Note', 'Meeting Note'], ['한창', '한창환']]);
});

test('evidence: exact, normalized, speaker-prefixed, ellipsis and cross-segment quotes', () => {
  const idx = new TranscriptIndex(segments);
  assert.deepEqual(idx.check('결정 기록 기능을 먼저 만들기로 합시다'), { match: true, segmentIds: ['s0'] });
  assert.deepEqual(idx.check('  “결정   기록 기능을”  '), { match: true, segmentIds: ['s0'] });
  assert.deepEqual(idx.check('Andrew: 제가 다음 주 금요일까지'), { match: true, segmentIds: ['s1'] });
  assert.deepEqual(idx.check('이번 분기에는 ... 요약 포맷은 그대로 둡니다'), { match: true, segmentIds: ['s0'] });
  assert.deepEqual(idx.check('요약 포맷은 그대로 둡니다. andrew: 좋습니다.'), { match: true, segmentIds: ['s0', 's1'] });
  assert.deepEqual(idx.check('다음 달까지 올리겠습니다'), { match: false, segmentIds: [] });
  assert.deepEqual(idx.check('summary'), { match: null, segmentIds: [] });
  // Ellipsis parts must appear in order.
  assert.equal(idx.check('요약 포맷은 … 이번 분기에는').match, false);
});

test('payload: normalizes names, links actions to decisions, computes evidence metrics', () => {
  const parsed = parseDecisionExtraction(validJson());
  assert.ok(parsed.ok);
  const { payload, metrics, aliasCandidates } = buildExtractionPayload(parsed.value, {
    noteId: 'note-abc-123', meetingDate: '2026-11-04', promptVersion: 'v-test', runId: null, segments,
  });
  assert.equal(payload.id_prefix, '261104-noteab');
  assert.equal(payload.record.meeting_date, '2026-11-04');
  assert.deepEqual(payload.decisions[0].participants, ['Andrew Yoo']);
  assert.equal(payload.decisions[0].decided_by, '이한수');
  assert.equal(payload.decisions[1].decided_by, 'Speaker C (추정)');
  assert.equal(payload.actions[0].owner, 'Andrew Yoo');
  assert.equal(payload.actions[0].from_decision, 'D-1');
  assert.deepEqual(payload.decisions[0].evidence_segment_ids, ['s0']);
  assert.equal(payload.issues[0].evidence_quote, 'summary');
  assert.equal(payload.issues[0].evidence_match, null);
  assert.equal(metrics.status_counts.decided, 1);
  assert.equal(metrics.status_counts.proposed, 1);
  assert.equal(metrics.decided_ratio, 0.5);
  assert.equal(metrics.evidence_match_rate, 1);
  assert.equal(metrics.evidence_summary_rate, 0.25);
  // Speaker labels / guesses are not persisted as entities; Andrew is stored canonically.
  const names = payload.entities.map((e) => `${e.type}:${e.canonical_name}:${e.role}`).sort();
  assert.deepEqual(names, ['org:TecAce:involved_org', 'person:Andrew Yoo:participant', 'person:이한수:participant', 'project:Meeting Note:about_project']);
  assert.ok(payload.entities.find((e) => e.canonical_name === 'Andrew Yoo')?.aliases.includes('Andrew'));
  assert.ok(aliasCandidates.some((c) => c.source === 'quality_notes' && c.suggested === 'Meeting Note'));
});

test('payload: out-of-scope meetings store no decisions and drop dangling action links', () => {
  const json = JSON.parse(validJson());
  json.meeting.meeting_kind = 'out-of-scope';
  const parsed = parseDecisionExtraction(JSON.stringify(json));
  assert.ok(parsed.ok);
  const { payload, metrics } = buildExtractionPayload(parsed.value, {
    noteId: 'n1', meetingDate: '2026-11-04', promptVersion: 'v', runId: null, segments,
  });
  assert.equal(payload.decisions.length, 0);
  assert.equal(payload.actions[0].from_decision, null);
  assert.equal(metrics.decided_ratio, null);
});

test('prepareInput / meetingDateOf: date in the configured zone, full transcript, summary_edit preferred', () => {
  assert.equal(meetingDateOf('2026-11-03T20:00:00Z', 'Asia/Seoul'), '2026-11-04');
  assert.equal(meetingDateOf('2026-11-03T20:00:00Z', 'America/Los_Angeles'), '2026-11-03');
  assert.equal(meetingDateOf(null, 'Asia/Seoul'), null);
  const prepared = prepareInput({
    id: 'n1', user_id: 'u1', summary: 'orig', summary_edit: 'edited', diarization: segments,
    meeting_at: '2026-11-03T20:00:00Z', created_at: '2026-11-05T00:00:00Z',
  }, 'Asia/Seoul');
  assert.ok(!('error' in prepared));
  if (!('error' in prepared)) {
    assert.equal(prepared.meetingDate, '2026-11-04');
    assert.equal(prepared.summary, 'edited');
    assert.equal(prepared.segments.length, 3);
    assert.equal(prepared.truncated, false);
    assert.match(prepared.transcript, /^이한수: 이번 분기에는/);
  }
  assert.deepEqual(prepareInput({ id: 'n', user_id: 'u', diarization: [], created_at: '2026-11-04T00:00:00Z' }, 'UTC'), { error: 'empty transcript' });
});

test('prompt: keeps the fixed taxonomy and alias rules, and fences the transcript as data', () => {
  for (const s of ['decided', 'direction', 'proposed', 'deferred', 'status_report', 'info', 'customer_decided', 'customer_stated']) {
    assert.ok(DECISION_SYSTEM_PROMPT.includes(s), s);
  }
  assert.ok(DECISION_SYSTEM_PROMPT.includes('강성원(Samsung) ≠ 강사장(TecAce)'));
  const user = buildDecisionUserPrompt({ noteId: 'n1', meetingDate: '2026-11-04', transcript: 'A: hi', summary: 's', transcriptTruncated: true });
  assert.match(user, /TRANSCRIPT 전문[\s\S]*'''\nA: hi\n'''/);
  assert.match(user, /transcript 일부만 입력/);
});

test('idPrefix: stable, alphanumeric, 6-char note part', () => {
  assert.equal(idPrefix('8ebea35d-4125-4369', '2026-08-07'), '260807-8ebea3');
  assert.equal(idPrefix('---', '2026-08-07'), '260807-note00');
});
