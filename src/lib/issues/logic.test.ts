// Spec 12.1 LOGIC acceptance tests (L1-L18) plus a few edge cases of the same functions.
// L1 / L5 area expectations are rewritten for this app's screen table (spec allows it).
import { describe, expect, it } from 'vitest';
import { readStatus, severityOf } from './constants';
import { buildIssueKey, buildPath, displayName, extractFiles } from './keys';
import { countByView, filterIssues, groupByPurpose } from './listFilter';
import { describeRecipients, mailAfterSave, savedText } from './mailDecision';
import { suggestTriage } from './triageRules';
import { EMPTY_DRAFT_STATE, applySuggestion, nextDraftState, suggestionApplied } from './triageDraft';
import type { Issue } from './types';

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: 'i1', issueKey: 'FB-20261014-00000001', title: 't', description: 'd',
  purpose: 'bug', area: 'general', status: 'OPEN', priority: 'P3', severity: 'Medium',
  assigneeEmail: null, assigneeName: null, triageNote: null, aiSuggestion: null, attachments: [],
  resolution: null, resolutionGeneratedAt: null, resolutionModel: null,
  authorEmail: 'author@tecace.com', authorName: 'Author', authorId: 'author-oid', triagedAt: null, triagedBy: null,
  createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', ...over,
});

describe('suggestTriage (L1-L7)', () => {
  it('L1: OneDrive 저장이 안 돼요 -> bug / onedrive / P2 / High', () => {
    expect(suggestTriage('OneDrive 저장이 안 돼요', '')).toMatchObject({ purpose: 'bug', area: 'onedrive', priority: 'P2', severity: 'High' });
  });
  it('L2: debug is not bug', () => {
    expect(suggestTriage('debug 로그 추가해주세요', '').purpose).toBe('feature');
  });
  it('L3: failed matches fail', () => {
    expect(suggestTriage('저장 failed', '').purpose).toBe('bug');
  });
  it('L4: 전체 does not escalate', () => {
    expect(suggestTriage('전체 목록 보기 추가', '')).toMatchObject({ purpose: 'feature', priority: 'P3' });
  });
  it('L5: 로그인이 전혀 안 돼요 -> bug / settings / P1 / Critical', () => {
    expect(suggestTriage('로그인이 전혀 안 돼요', '')).toMatchObject({ purpose: 'bug', area: 'settings', priority: 'P1', severity: 'Critical' });
  });
  it('L6: override sets purpose and priority', () => {
    const s = suggestTriage('OneDrive 저장이 안 돼요', '', 'question');
    expect(s).toMatchObject({ purpose: 'question', priority: 'P4' });
    expect(s.reason.startsWith('직접 고른 종류에 맞춰 긴급도를 정했습니다.')).toBe(true);
  });
  it('L7: empty -> other / general / P4 / Low', () => {
    expect(suggestTriage('', '')).toMatchObject({ purpose: 'other', area: 'general', priority: 'P4', severity: 'Low' });
  });
  it('fallback reason uses 분류 (UI-9) and 노트북 does not hit 노트', () => {
    const s = suggestTriage('노트북 화면', '');
    expect(s.area).toBe('general');
    expect(s.reason).toBe('긴급 키워드는 없어 일반 피드백으로 분류했습니다. 분류에서 필요하면 조정하세요.');
  });
});

describe('keys and constants (L8, L9, L12)', () => {
  it('L8: issue key format', () => {
    expect(buildIssueKey(new Date(2026, 9, 8))).toMatch(/^FB-20261008-[0-9A-F]{8}$/);
  });
  it('L9: severityOf', () => {
    expect(severityOf('P1')).toBe('Critical');
    expect(severityOf('P4')).toBe('Low');
  });
  it('L12: readStatus(TRIAGE) = OPEN', () => {
    expect(readStatus('TRIAGE')).toBe('OPEN');
    expect(readStatus('DONE')).toBe('DONE');
  });
  it('attachment path and display name', () => {
    const safe = /^screenshots\/[A-Za-z0-9._-]+$/;
    expect(buildPath({ name: 'shot.jpeg' })).toMatch(/^screenshots\/\d+-[0-9a-f-]{36}\.jpeg$/);
    expect(buildPath({ name: 'noext' })).toMatch(/\.png$/);
    expect(buildPath({ name: '화면 캡처.P N/G' })).toMatch(safe);
    expect(buildPath({ name: '화면 캡처.P N/G' }).endsWith('.png')).toBe(true);
    expect(displayName({ name: 'image.png' }, 0)).toBe('스크린샷-1.png');
    expect(displayName({ name: 'a.pdf' }, 3)).toBe('a.pdf');
  });
  it('extractFiles falls back to items', () => {
    const f = new File(['x'], 'image.png', { type: 'image/png' });
    const data = { files: [], items: [{ kind: 'file', getAsFile: () => f }, { kind: 'string', getAsFile: () => null }] } as unknown as DataTransfer;
    expect(extractFiles(data)).toEqual([f]);
    expect(extractFiles(null)).toEqual([]);
  });
});

describe('list counts and filters (L10, L11)', () => {
  it('L10: done issue assigned to me is not in mine', () => {
    const list = [issue({ status: 'DONE', assigneeEmail: 'Me@tecace.com' })];
    expect(countByView(list, 'me@tecace.com')).toMatchObject({ mine: 0, all: 1 });
  });
  it('L11: untriaged counts only open', () => {
    const list = [issue({ id: 'a' }), issue({ id: 'b', status: 'DONE' })];
    expect(countByView(list, null).untriaged).toBe(1);
  });
  it('query, assignee filter and groups', () => {
    const list = [
      issue({ id: 'a', title: 'Alpha', purpose: 'feature', assigneeEmail: 'x@t.com' }),
      issue({ id: 'b', title: 'Beta', purpose: 'bug' }),
    ];
    expect(filterIssues(list, { view: 'all', query: 'alp', assignee: 'all' }, null).map((i) => i.id)).toEqual(['a']);
    expect(filterIssues(list, { view: 'all', query: '', assignee: 'none' }, null).map((i) => i.id)).toEqual(['b']);
    expect(groupByPurpose(list).map((g) => g.purpose)).toEqual(['bug', 'feature']);
  });
});

describe('triage draft (L13, L14)', () => {
  it('L13: user edit survives a same-issue refresh', () => {
    const s1 = nextDraftState(EMPTY_DRAFT_STATE, issue());
    const edited = { ...s1, draft: { ...s1.draft!, assigneeEmail: 'b@tecace.com', assigneeName: 'B' } };
    const s2 = nextDraftState(edited, issue({ updatedAt: '2026-10-14T01:00:00Z', triageNote: 'server' }));
    expect(s2.draft?.assigneeEmail).toBe('b@tecace.com');
  });
  it('L14: untouched draft takes the new server values', () => {
    const s1 = nextDraftState(EMPTY_DRAFT_STATE, issue());
    const s2 = nextDraftState(s1, issue({ updatedAt: '2026-10-14T01:00:00Z', triageNote: 'server' }));
    expect(s2.draft?.triageNote).toBe('server');
  });
  it('switching issue resets; apply suggestion', () => {
    const s1 = nextDraftState(EMPTY_DRAFT_STATE, issue());
    const edited = { ...s1, draft: { ...s1.draft!, triageNote: 'x' } };
    const other = issue({ id: 'i2', aiSuggestion: { purpose: 'feature', area: 'docs', priority: 'P3', severity: 'Medium', reason: 'r' } });
    const s2 = nextDraftState(edited, other);
    expect(s2.draft?.triageNote).toBe('');
    const applied = applySuggestion(s2.draft!, other);
    expect(suggestionApplied(applied, other)).toBe(true);
  });
});

describe('mail decision and wording (L15-L18)', () => {
  it('L15: null -> A by B mails A', () => {
    const r = mailAfterSave(issue(), issue({ assigneeEmail: 'a@tecace.com' }), { email: 'b@tecace.com' });
    expect(r.assigneeMailed).toBe('a@tecace.com');
  });
  it('L16: assigning myself mails nobody', () => {
    const r = mailAfterSave(issue(), issue({ assigneeEmail: 'Me@tecace.com' }), { email: 'me@tecace.com' });
    expect(r.assigneeMailed).toBeNull();
  });
  it('L17: OPEN -> DONE mails the author unless the author saved', () => {
    expect(mailAfterSave(issue(), issue({ status: 'DONE' }), { email: 'b@tecace.com' }).authorMailed).toBe(true);
    expect(mailAfterSave(issue(), issue({ status: 'DONE' }), { email: 'x@tecace.com', id: 'AUTHOR-OID' }).authorMailed).toBe(false);
    // The author is the object id; a matching email with another id still gets mailed.
    expect(mailAfterSave(issue(), issue({ status: 'DONE' }), { email: 'AUTHOR@tecace.com', id: 'other-oid' }).authorMailed).toBe(true);
    // Legacy rows without author id fall back to the email (self-mail suppression only).
    expect(mailAfterSave(issue({ authorId: null }), issue({ status: 'DONE', authorId: null }), { email: 'AUTHOR@tecace.com' }).authorMailed).toBe(false);
    expect(mailAfterSave(issue({ authorEmail: 'ops-agent@tecace.com' }), issue({ status: 'CLOSED', authorEmail: 'ops-agent@tecace.com' }), { email: 'b@tecace.com' }).authorMailed).toBe(false);
  });
  it('L18: describeRecipients', () => {
    const dir = [{ email: 'a@tecace.com', displayName: 'Hansoo Lee' }];
    expect(describeRecipients(['a@tecace.com', 'b@tecace.com'], dir)).toBe('Hansoo Lee 외 1명');
    expect(describeRecipients(['b@tecace.com'], dir)).toBe('b');
    expect(describeRecipients([], dir)).toBe('');
  });
  it('savedText', () => {
    const at = new Date(2026, 9, 14, 14, 2);
    expect(savedText(at, { assigneeMailed: 'h@tecace.com', authorMailed: true }, 'Hansoo Lee'))
      .toBe('저장됨 14:02 · Hansoo Lee에게 배정 메일 · 등록자에게 처리 알림');
    expect(savedText(at, { assigneeMailed: null, authorMailed: false }, null)).toBe('저장됨 14:02');
  });
});
