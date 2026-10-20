// F2 feedback / issue tracker: server-side rules (no I/O here, so it is unit-testable).
// Spec: docs/feedback-issues-porting-prompt.md sections 3.1 (SEC-8, SEC-10), 3.7 (NOTIFY),
// 7.1 / 7.3 / 7.4 (AI resolution) and 9 (mail templates).
// The HTTP handlers that call these live in index.ts (issueResolution, issueNotify).

// ---- permissions (SEC-2, SEC-10) -----------------------------------------------------
// SAME RULE AS public.feedback_issues_can() in
// supabase/migrations/20261014120000_feedback_issues_parity.sql and canIssue() in
// src/lib/issues/permissions.ts (ids = ADMIN_MICROSOFT_USER_IDS in src/lib/adminAccess.ts).
export const ISSUE_ADMIN_MICROSOFT_IDS: ReadonlySet<string> = new Set([
  'd84c9149-2261-4ced-b14c-01b1a377ba6b', // Hansoo Lee
  '31d79bfe-2488-47c2-aa45-949375e93bde', // Andrew Yoo
]);

export type IssueFeature = 'issues' | 'issues.triage' | 'issues.notify';

/** userId = verified Microsoft object id of the caller. */
export function canIssue(userId: string | null | undefined, feature: IssueFeature): boolean {
  if (!userId) return false;
  if (feature === 'issues') return true;
  return ISSUE_ADMIN_MICROSOFT_IDS.has(userId);
}

// ---- shared vocabulary (Korean, mirrors src/lib/issues/constants.ts) ----------------------
const PURPOSE_KO: Record<string, string> = { bug: '버그', feature: '개선 요청', question: '질문', other: '기타' };
const STATUS_KO: Record<string, string> = { OPEN: '접수', IN_PROGRESS: '진행 중', DONE: '완료', CLOSED: '닫힘' };
const PRIORITY_KO: Record<string, string> = { P1: '긴급', P2: '높음', P3: '보통', P4: '낮음' };
const AREA_KO: Record<string, string> = {
  general: '일반', 'meeting-note': '회의 노트', history: '히스토리', projects: '프로젝트', settings: '계정 설정',
  issues: '피드백 / 이슈', docs: '문서', onedrive: 'OneDrive', speaker: '화자', ops: '운영',
};
export const ISSUE_KEY_PATTERN = /^(FB|OPS)-\d{8}-[0-9A-F]{8}$/;
export const SYSTEM_AUTHOR_EMAILS: ReadonlySet<string> = new Set(['ops-agent@tecace.com']);
/** RCPT-2 fallback when the recipient table cannot be read (same as the migration seed). */
export const LEGACY_NOTIFY_EMAIL = 'andrewyoo@tecace.com';
/** How long after creation the author may trigger the new-issue mail (blocks re-sends). */
export const CREATED_NOTIFY_WINDOW_MS = 15 * 60 * 1000;

const isOpenStatus = (s: string): boolean => s !== 'DONE' && s !== 'CLOSED';
const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
/** Microsoft object ids; both must be present (null never matches null). */
const sameId = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a?.trim() && !!b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The subset of a feedback_issues row the mail and decision code reads. */
export interface IssueRow {
  issue_key: string;
  title: string;
  description: string;
  purpose: string;
  area: string;
  status: string;
  priority: string;
  assignee_email: string | null;
  assignee_name: string | null;
  triage_note: string | null;
  resolution: unknown;
  attachments: unknown;
  author_email: string;
  author_name: string | null;
  /** Microsoft object id stamped by the DB from the JWT `sub` (null on rows filed before it). */
  author_id?: string | null;
  created_at: string;
  deleted_at?: string | null;
}

export type NotifyKind = 'created' | 'assigned' | 'resolved';

export function parseNotifyKind(raw: unknown): NotifyKind | null {
  return raw === 'created' || raw === 'assigned' || raw === 'resolved' ? raw : null;
}

export type RecipientsRead = { status: 'ok'; emails: string[] } | { status: 'missing_table' } | { status: 'error' };

/** RCPT-2: unreadable -> fallback, readable but empty -> []. */
export function resolveNotifyEmails(read: RecipientsRead): string[] {
  return read.status === 'ok' ? read.emails : [LEGACY_NOTIFY_EMAIL];
}

export type NotifyDecision = { ok: true; to: string[] } | { ok: false; status: number; error: string };

/**
 * Who gets mail for this event. The recipients always come from the DB row / table, never
 * from the request body (that was an open relay before). `caller` is the verified identity.
 */
export function decideNotify(input: {
  kind: NotifyKind;
  row: IssueRow;
  caller: { id: string; email: string };
  createdRecipients: string[];
  now: number;
}): NotifyDecision {
  const { kind, row, caller } = input;
  if (row.deleted_at) return { ok: false, status: 409, error: '삭제된 이슈입니다.' };
  if (kind === 'created') {
    // Ownership is the object id, never the email (a Graph mail can be set by any tenant admin).
    if (!sameId(row.author_id, caller.id)) {
      return { ok: false, status: 403, error: '본인이 등록한 이슈만 알릴 수 있습니다.' };
    }
    const age = input.now - Date.parse(row.created_at);
    if (!(age >= 0 && age <= CREATED_NOTIFY_WINDOW_MS)) {
      return { ok: false, status: 409, error: '등록 직후에만 알림을 보낼 수 있습니다.' };
    }
    return { ok: true, to: dedupeEmails(input.createdRecipients) };
  }
  if (!canIssue(caller.id, 'issues.triage')) return { ok: false, status: 403, error: '처리 알림은 관리자 권한이 필요합니다.' };
  if (kind === 'assigned') {
    const to = row.assignee_email && !sameEmail(row.assignee_email, caller.email) ? [row.assignee_email] : [];
    return { ok: true, to: dedupeEmails(to) };
  }
  // Self-mail suppression only (not a permission): by id when the row has one.
  const callerIsAuthor = row.author_id ? sameId(row.author_id, caller.id) : sameEmail(row.author_email, caller.email);
  const resolved = !isOpenStatus(row.status)
    && !callerIsAuthor
    && !SYSTEM_AUTHOR_EMAILS.has(row.author_email.trim().toLowerCase());
  return { ok: true, to: resolved ? dedupeEmails([row.author_email]) : [] };
}

function dedupeEmails(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const email = raw.trim().toLowerCase();
    if (email.includes('@') && !seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

// ---- mail templates (section 9) -------------------------------------------------------------

/** Escapes & < > (spec) plus quotes, since values also land in attributes. */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const multiline = (v: unknown): string => escapeHtml(v).replace(/\r?\n/g, '<br/>');
const orDash = (v: string | null | undefined): string => (v && v.trim() ? v : '-');

interface MailResolution {
  summary?: unknown; rootCauses?: unknown; checks?: unknown; fixPlan?: unknown; verification?: unknown;
}

// Object path allowed in the feedback-attachments bucket: screenshots/<file> (new uploads)
// or <uuid>/<file> (legacy). SAME RULE AS public.feedback_attachment_path_ok() in
// supabase/migrations/20261014120000_feedback_issues_parity.sql.
const SAFE_ATTACHMENT_PATH = /^(screenshots|[0-9a-f-]{36})\/[A-Za-z0-9._-]+$/;

export function isSafeAttachmentPath(path: unknown): path is string {
  if (typeof path !== 'string' || !SAFE_ATTACHMENT_PATH.test(path)) return false;
  return !path.includes('..') && !/[%?#\\]/.test(path);
}

/** Image attachment paths of an issue row (DB value, never a request body), safe ones only. */
export function imageAttachmentPaths(attachments: unknown, max = 10): string[] {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((a): a is { path?: unknown; type?: unknown } => !!a && typeof a === 'object')
    .filter((a) => typeof a.type === 'string' && a.type.startsWith('image/') && isSafeAttachmentPath(a.path))
    .map((a) => a.path as string)
    .slice(0, max);
}

/** Per-author cap on new-issue mails in a rolling hour (item 8 of the 2026-10-15 review). */
export const CREATED_MAIL_LIMIT_PER_HOUR = 10;

/**
 * Deep-link origin from APP_FRONTEND_ORIGIN, which may be a comma-separated CORS list.
 * Returns the first concrete origin, or '' for '*' / empty (the caller logs a warning).
 */
export function firstFrontendOrigin(raw: string | undefined): string {
  const first = (raw ?? '').split(',').map((o) => o.trim()).find((o) => o.length > 0) ?? '';
  return first === '*' ? '' : first.replace(/\/+$/, '');
}

export interface IssueMail {
  subject: string;
  html: string;
}

export function buildIssueMail(input: {
  kind: NotifyKind;
  row: IssueRow;
  actor: { name: string | null; email: string };
  imageUrls: string[];
  deepLink: string;
  appName?: string;
  /** F9 ops tickets: also show the drafted RCA in the new-issue mail. */
  includeResolution?: boolean;
}): IssueMail {
  const { kind, row, actor } = input;
  const appName = input.appName ?? 'Meeting Note';
  const done = row.status === 'DONE';
  const spec = kind === 'created'
    ? { tag: 'Issue', h2: '새 이슈가 등록되었습니다', color: '#0284c7' }
    : kind === 'assigned'
      ? { tag: 'Issue Assigned', h2: '이슈가 배정되었습니다', color: '#059669' }
      : done
        ? { tag: 'Issue Done', h2: '올리신 이슈가 처리되었습니다', color: '#047857' }
        : { tag: 'Issue Closed', h2: '올리신 이슈가 닫혔습니다', color: '#475569' };
  const actorName = escapeHtml(actor.name?.trim() || actor.email);
  const lead = kind === 'created'
    ? `<strong>${escapeHtml(row.author_name?.trim() || row.author_email)}</strong>(${escapeHtml(row.author_email)}) 님이 새 이슈를 등록했습니다.`
    : kind === 'assigned'
      ? `<strong>${actorName}</strong> 님이 이 이슈를 회원님께 배정했습니다.`
      : `<strong>${actorName}</strong> 님이 이 이슈를 <strong>${done ? '완료' : '닫힘'}</strong>(으)로 바꿨습니다.`;

  const tr = (label: string, valueHtml: string) =>
    `<tr><td style="padding:4px 12px;color:#64748b;">${escapeHtml(label)}</td><td style="padding:4px 12px;">${valueHtml}</td></tr>`;
  const area = AREA_KO[row.area] ?? row.area;
  const rows = [
    tr('Issue', `<strong>${escapeHtml(row.issue_key)}</strong>`),
    tr('제목', escapeHtml(orDash(row.title))),
    tr('종류 / 화면', escapeHtml(`${PURPOSE_KO[row.purpose] ?? row.purpose} · ${orDash(area)}`)),
    tr('긴급도', escapeHtml(PRIORITY_KO[row.priority] ?? row.priority)),
    tr('등록자', escapeHtml(row.author_name?.trim() || row.author_email)),
  ];
  if (kind === 'created') rows.push(tr('설명', multiline(orDash(row.description))));
  if (kind === 'assigned') rows.push(tr('상태', escapeHtml(STATUS_KO[row.status] ?? row.status)));
  if (kind !== 'created') rows.push(tr('처리 메모', multiline(orDash(row.triage_note))));

  const screenshots = input.imageUrls.length
    ? `<h3 style="font-size:14px;margin:16px 0 8px;">스크린샷</h3><p>${input.imageUrls
        .map((u) => `<a href="${escapeHtml(u)}"><img src="${escapeHtml(u)}" alt="" style="max-width:260px;border:1px solid #e2e8f0;border-radius:6px;margin:0 8px 8px 0;" /></a>`)
        .join('')}</p>`
    : '';
  const extra = kind === 'created'
    ? `${screenshots}${input.includeResolution ? resolutionBlock(row.resolution, spec.color) : ''}`
    : kind === 'assigned'
      ? `${screenshots}${resolutionBlock(row.resolution, spec.color)}<p>설명: ${multiline(orDash(row.description))}</p>`
      : '';

  const html = `<div style="font-family: Arial, sans-serif; color: #1e293b;">
  <h2 style="color: ${spec.color};">${spec.h2}</h2>
  <p>${lead}</p>
  <table style="border-collapse: collapse; margin: 16px 0;">
    ${rows.join('\n    ')}
  </table>
  ${extra}
  <p><a href="${escapeHtml(input.deepLink)}" style="display:inline-block;padding:8px 16px;background-color:${spec.color};color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:bold;">피드백/이슈 바로가기 →</a></p>
  <p style="font-size:12px;color:#94a3b8;">${escapeHtml(appName)} 자동 알림</p>
</div>`;
  return { subject: `[${spec.tag}] ${row.issue_key} — ${row.title}`, html };
}

function resolutionBlock(raw: unknown, color: string): string {
  if (!raw || typeof raw !== 'object') return '';
  const r = raw as MailResolution;
  const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
  if (!summary) return '';
  const list = (label: string, v: unknown) => {
    const items = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
    return items.length
      ? `<p style="margin:10px 0 4px;font-weight:bold;">${escapeHtml(label)}</p><ul style="margin:0;padding-left:18px;">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
      : '';
  };
  return `<div style="border-left:3px solid ${color};padding:8px 12px;margin:16px 0;">
    <h3 style="font-size:14px;margin:0 0 8px;">이슈 해결책</h3>
    <p><strong>${escapeHtml(summary)}</strong></p>
    ${list('원인 가설', r.rootCauses)}${list('확인 절차', r.checks)}${list('수정 방향', r.fixPlan)}${list('검증 방법', r.verification)}
  </div>`;
}

// ---- AI resolution (sections 7.1, 7.3, 7.4) ------------------------------------------------

/** Gemini responseSchema (OpenAPI subset) for section 7.3. Also used by the F9 ops agent. */
export const ISSUE_RESOLUTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: '한 줄 요약' },
    rootCauses: { type: 'ARRAY', items: { type: 'STRING' }, description: '원인 가설 (가능성 높은 순)' },
    checks: { type: 'ARRAY', items: { type: 'STRING' }, description: '확인 절차' },
    fixPlan: { type: 'ARRAY', items: { type: 'STRING' }, description: '수정 방향 (순서대로)' },
    verification: { type: 'ARRAY', items: { type: 'STRING' }, description: '검증 방법' },
    confidence: { type: 'STRING', enum: ['low', 'medium', 'high'] },
  },
  required: ['summary', 'rootCauses', 'checks', 'fixPlan', 'verification', 'confidence'],
} as const;

export const ISSUE_RESOLUTION_SYSTEM_PROMPT = `너는 사내 Meeting Note("회의 녹음을 AI 로 전사·요약하고 메모리·검색으로 다시 찾게 해 주는 앱")을 유지보수하는 시니어 엔지니어다.
스택: React 18 + TypeScript + Vite 프론트엔드, Supabase(Postgres + RLS + Storage), Node workflow-server(Render, Gemini 호출), Azure MSAL SSO, AssemblyAI 전사 · OneDrive/Teams 연동 · Flutter 모바일 앱.
주요 화면: 회의 노트(녹음·업로드·전사·요약), 히스토리(검색·목록), 프로젝트, 계정 설정, 피드백 / 이슈, 문서, 화자 편집, OneDrive 저장.

접수된 이슈를 읽고 담당자가 바로 착수할 수 있는 해결책을 작성한다. 규칙:
- 한국어로, 각 항목은 한 문장씩. 군더더기 없이 실행 가능한 내용만 쓴다.
- rootCauses 는 확인되지 않은 가설임을 전제로 가능성이 높은 순서로 쓴다.
- checks 는 담당자가 실제로 눌러보거나 조회해 볼 수 있는 확인 절차로 쓴다.
- fixPlan 은 손대야 할 위치와 방향을 순서대로 쓴다. 확실하지 않은 파일명을 지어내지 않는다.
- verification 은 수정 후 무엇이 어떻게 보이면 해결로 볼 수 있는지 쓴다.
- 정보가 부족하면 추측을 늘리지 말고 confidence 를 low 로 두고 checks 에 무엇을 더 확인해야 하는지 적는다.`;

export interface ResolutionRequest {
  issueKey: string;
  title: string;
  description: string;
  purpose: string;
  area: string;
  priority: string;
  severity: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Section 7.1 input check with the spec defaults for missing fields. */
export function parseResolutionRequest(body: unknown): { ok: true; value: ResolutionRequest } | { ok: false; error: string } {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const title = text(o.title);
  const description = text(o.description);
  if (!title || !description) return { ok: false, error: '제목과 설명이 필요합니다.' };
  // Attachments are NOT taken from the body: the handler reads them from the issue row.
  return {
    ok: true,
    value: {
      issueKey: text(o.issueKey) || '-',
      title,
      description,
      purpose: text(o.purpose) || 'other',
      area: text(o.area) || 'general',
      priority: text(o.priority) || 'P3',
      severity: text(o.severity) || 'Medium',
    },
  };
}

export function buildResolutionUserText(r: ResolutionRequest): string {
  return `이슈 번호: ${r.issueKey}
제목: ${r.title}
목적/영역: ${r.purpose} / ${r.area}
우선순위/심각도: ${r.priority} / ${r.severity}

설명:
${r.description}`;
}

export interface IssueResolution {
  summary: string;
  rootCauses: string[];
  checks: string[];
  fixPlan: string[];
  verification: string[];
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Strict check of the structured output against section 7.3 (no repair, no retry loop:
 * the provider's schema mode is what guarantees the shape, AI-2). Null = reject.
 */
export function validateResolution(raw: string): IssueResolution | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const strings = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).map((x) => x.trim()).filter(Boolean) : null;
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  const rootCauses = strings(o.rootCauses);
  const checks = strings(o.checks);
  const fixPlan = strings(o.fixPlan);
  const verification = strings(o.verification);
  const confidence = o.confidence;
  if (!summary || !rootCauses || !checks || !fixPlan || !verification) return null;
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') return null;
  return { summary, rootCauses, checks, fixPlan, verification, confidence };
}
