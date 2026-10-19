import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREATED_NOTIFY_WINDOW_MS,
  LEGACY_NOTIFY_EMAIL,
  buildIssueMail,
  buildResolutionUserText,
  canIssue,
  decideNotify,
  escapeHtml,
  firstFrontendOrigin,
  imageAttachmentPaths,
  isSafeAttachmentPath,
  parseNotifyKind,
  parseResolutionRequest,
  resolveNotifyEmails,
  validateResolution,
  type IssueRow,
} from './issues.js';

const ADMIN = '31d79bfe-2488-47c2-aa45-949375e93bde';
const AUTHOR_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-10-14T12:00:00Z');

const row = (over: Partial<IssueRow> = {}): IssueRow => ({
  issue_key: 'FB-20261014-AB12CD34',
  title: 'Save <fails>',
  description: 'line1\nline2 & <script>',
  purpose: 'bug',
  area: 'onedrive',
  status: 'OPEN',
  priority: 'P2',
  assignee_email: null,
  assignee_name: null,
  triage_note: null,
  resolution: null,
  attachments: [],
  author_email: 'author@tecace.com',
  author_name: 'Author',
  author_id: AUTHOR_ID,
  created_at: '2026-10-14T11:59:00Z',
  deleted_at: null,
  ...over,
});

test('canIssue: three levels on two roles (SEC-2)', () => {
  assert.equal(canIssue('anyone', 'issues'), true);
  assert.equal(canIssue('anyone', 'issues.triage'), false);
  assert.equal(canIssue('anyone', 'issues.notify'), false);
  assert.equal(canIssue(ADMIN, 'issues.triage'), true);
  assert.equal(canIssue(ADMIN, 'issues.notify'), true);
  assert.equal(canIssue(null, 'issues'), false);
});

test('parseNotifyKind accepts only the three events', () => {
  assert.equal(parseNotifyKind('created'), 'created');
  assert.equal(parseNotifyKind('resolved'), 'resolved');
  assert.equal(parseNotifyKind('other'), null);
});

test('resolveNotifyEmails: unreadable -> fallback, empty -> [] (RCPT-2)', () => {
  assert.deepEqual(resolveNotifyEmails({ status: 'missing_table' }), [LEGACY_NOTIFY_EMAIL]);
  assert.deepEqual(resolveNotifyEmails({ status: 'error' }), [LEGACY_NOTIFY_EMAIL]);
  assert.deepEqual(resolveNotifyEmails({ status: 'ok', emails: [] }), []);
});

test('created: only the author (by object id), only right after creation, recipients from the table', () => {
  const caller = { id: AUTHOR_ID.toUpperCase(), email: 'AUTHOR@tecace.com' };
  const ok = decideNotify({ kind: 'created', row: row(), caller, createdRecipients: ['A@tecace.com', 'a@tecace.com'], now: NOW });
  assert.deepEqual(ok, { ok: true, to: ['a@tecace.com'] });
  const stranger = decideNotify({ kind: 'created', row: row(), caller: { id: 'x', email: 'x@tecace.com' }, createdRecipients: ['a@tecace.com'], now: NOW });
  assert.equal(stranger.ok, false);
  const late = decideNotify({ kind: 'created', row: row(), caller, createdRecipients: ['a@tecace.com'], now: NOW + CREATED_NOTIFY_WINDOW_MS + 60_000 });
  assert.equal(late.ok, false);
  const deleted = decideNotify({ kind: 'created', row: row({ deleted_at: '2026-10-14T12:00:00Z' }), caller, createdRecipients: [], now: NOW });
  assert.equal(deleted.ok, false);
});

test('created: a matching email without the object id is not the author (nOAuth spoof)', () => {
  const spoofer = { id: 'ffffffff-0000-4000-8000-00000000000f', email: 'author@tecace.com' };
  const spoof = decideNotify({ kind: 'created', row: row(), caller: spoofer, createdRecipients: ['a@tecace.com'], now: NOW });
  assert.deepEqual(spoof, { ok: false, status: 403, error: '본인이 등록한 이슈만 알릴 수 있습니다.' });
  const legacy = decideNotify({ kind: 'created', row: row({ author_id: null }), caller: { id: AUTHOR_ID, email: 'author@tecace.com' }, createdRecipients: [], now: NOW });
  assert.equal(legacy.ok, false);
});

test('resolved: self-mail suppression uses the object id when the row has one', () => {
  const adminAuthor = { id: ADMIN, email: 'other@tecace.com' };
  const own = decideNotify({ kind: 'resolved', row: row({ status: 'DONE', author_id: ADMIN }), caller: adminAuthor, createdRecipients: [], now: NOW });
  assert.deepEqual(own, { ok: true, to: [] });
  const sameMailOtherId = decideNotify({ kind: 'resolved', row: row({ status: 'DONE', author_email: 'andrewyoo@tecace.com' }), caller: { id: ADMIN, email: 'andrewyoo@tecace.com' }, createdRecipients: [], now: NOW });
  assert.deepEqual(sameMailOtherId, { ok: true, to: ['andrewyoo@tecace.com'] });
});

test('assigned / resolved: admin only, recipient from the row, never the caller', () => {
  const admin = { id: ADMIN, email: 'andrewyoo@tecace.com' };
  const assigned = decideNotify({ kind: 'assigned', row: row({ assignee_email: 'b@tecace.com' }), caller: admin, createdRecipients: [], now: NOW });
  assert.deepEqual(assigned, { ok: true, to: ['b@tecace.com'] });
  const self = decideNotify({ kind: 'assigned', row: row({ assignee_email: 'AndrewYoo@tecace.com' }), caller: admin, createdRecipients: [], now: NOW });
  assert.deepEqual(self, { ok: true, to: [] });
  const nonAdmin = decideNotify({ kind: 'assigned', row: row({ assignee_email: 'b@tecace.com' }), caller: { id: 'u', email: 'u@tecace.com' }, createdRecipients: [], now: NOW });
  assert.equal(nonAdmin.ok, false);
  const done = decideNotify({ kind: 'resolved', row: row({ status: 'DONE' }), caller: admin, createdRecipients: [], now: NOW });
  assert.deepEqual(done, { ok: true, to: ['author@tecace.com'] });
  const stillOpen = decideNotify({ kind: 'resolved', row: row(), caller: admin, createdRecipients: [], now: NOW });
  assert.deepEqual(stillOpen, { ok: true, to: [] });
  const ops = decideNotify({ kind: 'resolved', row: row({ status: 'CLOSED', author_email: 'ops-agent@tecace.com' }), caller: admin, createdRecipients: [], now: NOW });
  assert.deepEqual(ops, { ok: true, to: [] });
});

test('N1 template: subject, escaping, description line breaks, screenshots', () => {
  const mail = buildIssueMail({
    kind: 'created',
    row: row({ attachments: [{ name: 's.png', path: 'screenshots/1.png', type: 'image/png' }] }),
    actor: { name: 'Author', email: 'author@tecace.com' },
    imageUrls: ['https://x.test/1.png?sig="a"'],
    deepLink: 'https://app.test/issues?issue=FB-20261014-AB12CD34',
  });
  assert.equal(mail.subject, '[Issue] FB-20261014-AB12CD34 — Save <fails>');
  assert.match(mail.html, /새 이슈가 등록되었습니다/);
  assert.match(mail.html, /#0284c7/);
  assert.match(mail.html, /Save &lt;fails&gt;/);
  assert.match(mail.html, /line1<br\/>line2 &amp; &lt;script&gt;/);
  assert.match(mail.html, /버그 · OneDrive/);
  assert.match(mail.html, /높음/);
  assert.match(mail.html, /스크린샷/);
  assert.match(mail.html, /sig=&quot;a&quot;/);
  assert.match(mail.html, /피드백\/이슈 바로가기 →/);
  assert.doesNotMatch(mail.html, /<script>/);
});

test('N2 / N3 templates', () => {
  const resolution = { summary: 'S', rootCauses: ['r1'], checks: [], fixPlan: ['f1'], verification: [] };
  const n2 = buildIssueMail({
    kind: 'assigned', row: row({ status: 'IN_PROGRESS', triage_note: 'note', resolution }),
    actor: { name: 'Admin', email: 'andrewyoo@tecace.com' }, imageUrls: [], deepLink: '/issues',
  });
  assert.equal(n2.subject, '[Issue Assigned] FB-20261014-AB12CD34 — Save <fails>');
  assert.match(n2.html, /이슈가 배정되었습니다/);
  assert.match(n2.html, /진행 중/);
  assert.match(n2.html, /이슈 해결책/);
  assert.match(n2.html, /원인 가설/);
  assert.doesNotMatch(n2.html, /확인 절차/); // empty lists are omitted
  assert.match(n2.html, /<p>설명: /);
  const n3done = buildIssueMail({ kind: 'resolved', row: row({ status: 'DONE', triage_note: 'fixed' }), actor: { name: 'Admin', email: 'a@t.com' }, imageUrls: [], deepLink: '/issues' });
  assert.equal(n3done.subject, '[Issue Done] FB-20261014-AB12CD34 — Save <fails>');
  assert.match(n3done.html, /올리신 이슈가 처리되었습니다/);
  assert.match(n3done.html, /<strong>완료<\/strong>\(으\)로 바꿨습니다/);
  assert.match(n3done.html, /fixed/);
  const n3closed = buildIssueMail({ kind: 'resolved', row: row({ status: 'CLOSED' }), actor: { name: null, email: 'a@t.com' }, imageUrls: [], deepLink: '/issues' });
  assert.equal(n3closed.subject, '[Issue Closed] FB-20261014-AB12CD34 — Save <fails>');
  assert.match(n3closed.html, /#475569/);
  assert.match(n3closed.html, /처리 메모<\/td><td style="padding:4px 12px;">-/);
});

test('escapeHtml and image paths', () => {
  assert.equal(escapeHtml('<a & b>'), '&lt;a &amp; b&gt;');
  assert.deepEqual(imageAttachmentPaths([
    { path: 'screenshots/1-a.png', type: 'image/png' }, { path: 'screenshots/2-b.pdf', type: 'application/pdf' }, null,
    { path: '../meeting-note-images/victim/x.png', type: 'image/png' },
  ]), ['screenshots/1-a.png']);
});

test('attachment path whitelist (security review item 2)', () => {
  assert.equal(isSafeAttachmentPath('screenshots/1760000000000-11111111-2222-4333-8444-555555555555.png'), true);
  assert.equal(isSafeAttachmentPath('31d79bfe-2488-47c2-aa45-949375e93bde/0b6f1d2e-aaaa-4bbb-8ccc-123456789abc.jpeg'), true);
  for (const bad of ['../x.png', 'screenshots/../x.png', 'screenshots/a%2e.png', 'screenshots/a.png?x', 'screenshots/a#b',
    'screenshots\\a.png', 'other/a.png', 'screenshots/sub/a.png', '/screenshots/a.png', '', 42]) {
    assert.equal(isSafeAttachmentPath(bad), false, String(bad));
  }
});

test('firstFrontendOrigin (security review item 10)', () => {
  assert.equal(firstFrontendOrigin('https://a.test/, https://b.test'), 'https://a.test');
  assert.equal(firstFrontendOrigin('*'), '');
  assert.equal(firstFrontendOrigin(''), '');
  assert.equal(firstFrontendOrigin(undefined), '');
});

test('resolution request: defaults, required fields, user text', () => {
  assert.deepEqual(parseResolutionRequest({ title: 't' }), { ok: false, error: '제목과 설명이 필요합니다.' });
  // attachmentPaths in the body are ignored: the server reads attachments from the issue row.
  const r = parseResolutionRequest({ title: ' t ', description: 'd', attachmentPaths: ['../victim.png'] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.value, {
    issueKey: '-', title: 't', description: 'd', purpose: 'other', area: 'general', priority: 'P3', severity: 'Medium',
  });
  assert.equal(buildResolutionUserText(r.value), '이슈 번호: -\n제목: t\n목적/영역: other / general\n우선순위/심각도: P3 / Medium\n\n설명:\nd');
});

test('validateResolution is strict (AI-2)', () => {
  const good = { summary: 's', rootCauses: ['a'], checks: [], fixPlan: ['b'], verification: ['c'], confidence: 'high' };
  assert.deepEqual(validateResolution(JSON.stringify(good)), good);
  assert.equal(validateResolution(JSON.stringify({ ...good, confidence: 'certain' })), null);
  assert.equal(validateResolution(JSON.stringify({ ...good, checks: 'x' })), null);
  assert.equal(validateResolution('```json\n{}\n```'), null);
});
