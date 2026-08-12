// F2: in-app feedback / issue tracker — data + pure logic layer.
// Types, option/color constants, a deterministic rule-based auto-triage (no LLM), CRUD over
// the feedback_issues table, screenshot attachment upload/delete (private bucket + signed
// URLs), and the two workflow-server calls (LLM resolution + email notify).

import { supabase } from '../config/supabaseConfig';

const WORKFLOW_API_URL = ((import.meta.env.VITE_WORKFLOW_API_URL as string | undefined) ?? '').replace(/\/$/, '');
const ATTACHMENT_BUCKET = 'feedback-attachments';
const SIGNED_URL_TTL_SECONDS = 3600;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

// ---- types -----------------------------------------------------------------

export type IssuePurpose = 'bug' | 'feature' | 'question' | 'other';
export type IssueStatus = 'OPEN' | 'TRIAGE' | 'IN_PROGRESS' | 'DONE' | 'CLOSED';
export type IssuePriority = 'P1' | 'P2' | 'P3' | 'P4';
export type IssueSeverity = 'Low' | 'Medium' | 'High' | 'Critical';

export interface IssueAttachment {
  name: string; // display name, e.g. "스크린샷-1.png"
  path: string; // storage object path (canonical); signed URLs are derived on demand
  type: string; // mime
}

export interface IssueResolution {
  summary: string;
  rootCauses: string[];
  checks: string[];
  fixPlan: string[];
  verification: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface TriageSuggestion {
  purpose: IssuePurpose;
  area: string;
  priority: IssuePriority;
  severity: IssueSeverity;
  reason: string; // one Korean line, shown as-is
}

export interface FeedbackIssue {
  id: string;
  issueKey: string;
  title: string;
  description: string;
  purpose: IssuePurpose;
  area: string;
  status: IssueStatus;
  priority: IssuePriority;
  severity: IssueSeverity;
  assigneeEmail: string | null;
  assigneeName: string | null;
  triageNote: string | null;
  aiSuggestion: TriageSuggestion | null;
  attachments: IssueAttachment[];
  resolution: IssueResolution | null;
  resolutionGeneratedAt: string | null;
  resolutionModel: string | null;
  authorEmail: string;
  authorName: string | null;
  triagedAt: string | null;
  triagedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- options + colors (distinct from the app accent to avoid collisions) ----

export const PURPOSE_OPTIONS: ReadonlyArray<{ value: IssuePurpose; labelKo: string; color: string }> = [
  { value: 'bug', labelKo: '버그 신고', color: '#dc2626' },
  { value: 'feature', labelKo: '기능 추가/개선', color: '#2563eb' },
  { value: 'question', labelKo: '질문/문의', color: '#7c3aed' },
  { value: 'other', labelKo: '기타', color: '#6b7280' },
];

export const STATUS_OPTIONS: ReadonlyArray<{ value: IssueStatus; labelKo: string; color: string }> = [
  { value: 'OPEN', labelKo: 'Open', color: '#0ea5e9' },
  { value: 'TRIAGE', labelKo: 'Triage', color: '#f59e0b' },
  { value: 'IN_PROGRESS', labelKo: '진행 중', color: '#8b5cf6' },
  { value: 'DONE', labelKo: '완료', color: '#16a34a' },
  { value: 'CLOSED', labelKo: '종결', color: '#6b7280' },
];

export const PRIORITY_OPTIONS: ReadonlyArray<{ value: IssuePriority; color: string }> = [
  { value: 'P1', color: '#dc2626' },
  { value: 'P2', color: '#ea580c' },
  { value: 'P3', color: '#ca8a04' },
  { value: 'P4', color: '#6b7280' },
];

export const SEVERITY_OPTIONS: ReadonlyArray<{ value: IssueSeverity; color: string }> = [
  { value: 'Critical', color: '#dc2626' },
  { value: 'High', color: '#ea580c' },
  { value: 'Medium', color: '#ca8a04' },
  { value: 'Low', color: '#6b7280' },
];

// App screens → issue "area" options (from the router / sidebar).
export const AREA_OPTIONS: ReadonlyArray<{ value: string; labelKo: string; synonyms: string[] }> = [
  { value: 'meeting-note', labelKo: '회의 노트', synonyms: ['회의', '노트', '녹음', 'meeting', 'note', 'record', '전사', '요약', 'summary'] },
  { value: 'history', labelKo: '히스토리', synonyms: ['히스토리', '기록', '목록', 'history', '검색', 'search'] },
  { value: 'projects', labelKo: '프로젝트', synonyms: ['프로젝트', 'project'] },
  { value: 'onedrive', labelKo: 'OneDrive', synonyms: ['onedrive', '원드라이브', '저장', 'save', '내보내기', 'export'] },
  { value: 'settings', labelKo: '설정', synonyms: ['설정', '계정', 'settings', 'account', '프로필', 'profile'] },
  { value: 'speaker', labelKo: '화자', synonyms: ['화자', 'speaker', '다이어리제이션', 'diariz'] },
  { value: 'general', labelKo: '일반', synonyms: [] },
];

export function purposeColor(p: IssuePurpose): string { return PURPOSE_OPTIONS.find((o) => o.value === p)?.color ?? '#6b7280'; }
export function statusColor(s: IssueStatus): string { return STATUS_OPTIONS.find((o) => o.value === s)?.color ?? '#6b7280'; }
export function priorityColor(p: IssuePriority): string { return PRIORITY_OPTIONS.find((o) => o.value === p)?.color ?? '#6b7280'; }
export function severityColor(s: IssueSeverity): string { return SEVERITY_OPTIONS.find((o) => o.value === s)?.color ?? '#6b7280'; }

// ---- issue key -------------------------------------------------------------

export function generateIssueKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `FB-${y}${m}${d}-${rand}`;
}

// ---- rule-based auto-triage (deterministic, no external calls) --------------

const PURPOSE_RULES: ReadonlyArray<{ purpose: IssuePurpose; priority: IssuePriority; severity: IssueSeverity; kw: RegExp }> = [
  { purpose: 'bug', priority: 'P2', severity: 'High', kw: /안\s*됨|안돼|안된|에러|오류|크래시|crash|실패|fail|버그|bug|깨짐|튕김|먹통|안 나와|작동/i },
  { purpose: 'feature', priority: 'P3', severity: 'Medium', kw: /추가|개선|요청|주세요|했으면|기능|feature|지원|넣어|만들어/i },
  { purpose: 'question', priority: 'P4', severity: 'Low', kw: /\?|인가요|문의|어떻게|가능한가|질문|how|왜/i },
];
const ESCALATE_RE = /긴급|급함|전혀|아무도|안돼요|urgent|critical|심각|중요/i;

export function suggestTriage(title: string, description: string): TriageSuggestion {
  const text = `${title}\n${description}`;
  const rule = PURPOSE_RULES.find((r) => r.kw.test(text));
  const purpose: IssuePurpose = rule?.purpose ?? 'other';
  let priority: IssuePriority = rule?.priority ?? 'P4';
  let severity: IssueSeverity = rule?.severity ?? 'Low';
  const reasons: string[] = [];
  reasons.push(rule ? `키워드로 '${PURPOSE_OPTIONS.find((o) => o.value === purpose)?.labelKo}'로 분류` : '뚜렷한 키워드가 없어 기타로 분류');

  const areaMatch = AREA_OPTIONS.find((a) => a.synonyms.some((s) => text.toLowerCase().includes(s.toLowerCase())));
  const area = areaMatch?.value ?? 'general';
  if (areaMatch) reasons.push(`영역 '${areaMatch.labelKo}' 감지`);

  if (ESCALATE_RE.test(text)) {
    priority = escalatePriority(priority);
    severity = escalateSeverity(severity);
    reasons.push('긴급 표현으로 우선순위·심각도 상향');
  }
  return { purpose, area, priority, severity, reason: reasons.join(' · ') };
}

function escalatePriority(p: IssuePriority): IssuePriority {
  const order: IssuePriority[] = ['P4', 'P3', 'P2', 'P1'];
  return order[Math.min(order.indexOf(p) + 1, order.length - 1)];
}
function escalateSeverity(s: IssueSeverity): IssueSeverity {
  const order: IssueSeverity[] = ['Low', 'Medium', 'High', 'Critical'];
  return order[Math.min(order.indexOf(s) + 1, order.length - 1)];
}

// ---- row mapping -----------------------------------------------------------

type Row = Record<string, unknown>;
function s(v: unknown): string { return typeof v === 'string' ? v : ''; }
function sn(v: unknown): string | null { return typeof v === 'string' && v ? v : null; }

function mapRow(row: Row): FeedbackIssue {
  return {
    id: s(row.id),
    issueKey: s(row.issue_key),
    title: s(row.title),
    description: s(row.description),
    purpose: (s(row.purpose) || 'other') as IssuePurpose,
    area: s(row.area) || 'general',
    status: (s(row.status) || 'OPEN') as IssueStatus,
    priority: (s(row.priority) || 'P3') as IssuePriority,
    severity: (s(row.severity) || 'Medium') as IssueSeverity,
    assigneeEmail: sn(row.assignee_email),
    assigneeName: sn(row.assignee_name),
    triageNote: sn(row.triage_note),
    aiSuggestion: (row.ai_suggestion as TriageSuggestion | null) ?? null,
    attachments: Array.isArray(row.attachments) ? (row.attachments as IssueAttachment[]) : [],
    resolution: (row.resolution as IssueResolution | null) ?? null,
    resolutionGeneratedAt: sn(row.resolution_generated_at),
    resolutionModel: sn(row.resolution_model),
    authorEmail: s(row.author_email),
    authorName: sn(row.author_name),
    triagedAt: sn(row.triaged_at),
    triagedBy: sn(row.triaged_by),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

// ---- CRUD ------------------------------------------------------------------

export async function listIssues(): Promise<FeedbackIssue[]> {
  const { data, error } = await supabase
    .from('feedback_issues')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(friendlyDbError(error.message));
  return ((data ?? []) as Row[]).map(mapRow);
}

export interface NewIssueInput {
  title: string;
  description: string;
  purpose: IssuePurpose;
  area: string;
  priority: IssuePriority;
  severity: IssueSeverity;
  attachments: IssueAttachment[];
  aiSuggestion: TriageSuggestion | null;
  authorEmail: string;
  authorName: string | null;
}

export async function createIssue(input: NewIssueInput): Promise<FeedbackIssue> {
  const payload = {
    issue_key: generateIssueKey(),
    title: input.title.trim(),
    description: input.description.trim(),
    purpose: input.purpose,
    area: input.area,
    status: 'OPEN' as IssueStatus,
    priority: input.priority,
    severity: input.severity,
    attachments: input.attachments,
    ai_suggestion: input.aiSuggestion,
    author_email: input.authorEmail,
    author_name: input.authorName,
  };
  const { data, error } = await supabase.from('feedback_issues').insert(payload).select('*').single();
  if (error) throw new Error(friendlyDbError(error.message));
  return mapRow(data as Row);
}

export interface TriagePatch {
  status?: IssueStatus;
  priority?: IssuePriority;
  severity?: IssueSeverity;
  assigneeEmail?: string | null;
  assigneeName?: string | null;
  triageNote?: string | null;
  triagedBy?: string; // marks triaged_at = now
  resolution?: IssueResolution;
  resolutionModel?: string;
}

export async function updateIssue(id: string, patch: TriagePatch): Promise<FeedbackIssue> {
  const row: Row = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.priority !== undefined) row.priority = patch.priority;
  if (patch.severity !== undefined) row.severity = patch.severity;
  if (patch.assigneeEmail !== undefined) row.assignee_email = patch.assigneeEmail;
  if (patch.assigneeName !== undefined) row.assignee_name = patch.assigneeName;
  if (patch.triageNote !== undefined) row.triage_note = patch.triageNote;
  if (patch.triagedBy !== undefined) { row.triaged_by = patch.triagedBy; row.triaged_at = new Date().toISOString(); }
  if (patch.resolution !== undefined) {
    row.resolution = patch.resolution;
    row.resolution_generated_at = new Date().toISOString();
    if (patch.resolutionModel !== undefined) row.resolution_model = patch.resolutionModel;
  }
  const { data, error } = await supabase.from('feedback_issues').update(row).eq('id', id).select('*').single();
  if (error) throw new Error(friendlyDbError(error.message));
  return mapRow(data as Row);
}

/** Soft delete. Author-only is enforced here (the DB is open to authenticated). */
export async function softDeleteIssue(issue: FeedbackIssue, currentEmail: string): Promise<void> {
  if (issue.authorEmail.toLowerCase() !== currentEmail.toLowerCase()) {
    throw new Error('이슈는 작성자만 삭제할 수 있습니다.');
  }
  const { error } = await supabase
    .from('feedback_issues')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', issue.id);
  if (error) throw new Error(friendlyDbError(error.message));
}

// ---- attachments (private bucket + signed URLs) ----------------------------

export async function uploadIssueAttachment(file: File, userId: string, displayName: string): Promise<IssueAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${displayName}은(는) 10MB를 초과해 건너뜁니다.`);
  }
  const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const rand = crypto.randomUUID();
  const path = `${userId}/${rand}.${ext}`;
  const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).upload(path, file, {
    cacheControl: '3600',
    contentType: file.type || 'image/png',
    upsert: false,
  });
  if (error) throw new Error(friendlyDbError(error.message));
  return { name: displayName, path, type: file.type || 'image/png' };
}

export async function deleteIssueAttachment(path: string): Promise<void> {
  await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]);
}

/** Resolve signed URLs for a set of attachments (for display). Missing ones are dropped. */
export async function signAttachmentUrls(attachments: IssueAttachment[]): Promise<Record<string, string>> {
  if (attachments.length === 0) return {};
  const { data } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrls(attachments.map((a) => a.path), SIGNED_URL_TTL_SECONDS);
  const out: Record<string, string> = {};
  for (const item of data ?? []) {
    if (item.signedUrl && item.path) out[item.path] = item.signedUrl;
  }
  return out;
}

// ---- workflow-server calls (LLM resolution + email) ------------------------

export async function generateIssueResolution(
  issue: FeedbackIssue,
  getAccessToken: () => Promise<string | null>,
): Promise<{ resolution: IssueResolution; model: string }> {
  if (!WORKFLOW_API_URL) throw new Error('Workflow API URL이 설정되지 않았습니다.');
  const token = await getAccessToken();
  if (!token) throw new Error('Microsoft 액세스 토큰을 가져오지 못했습니다.');
  const res = await fetch(`${WORKFLOW_API_URL}/issue-resolution`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      issueKey: issue.issueKey,
      title: issue.title,
      description: issue.description,
      purpose: issue.purpose,
      area: issue.area,
      attachmentPaths: issue.attachments.map((a) => a.path).slice(0, 3),
    }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error || `해결책 생성 실패 (${res.status})`);
  }
  return (await res.json()) as { resolution: IssueResolution; model: string };
}

/** Fire-and-forget email notify. Never throws (best-effort, like the app's other notifies). */
export async function notifyIssue(
  kind: 'created' | 'assigned',
  issue: FeedbackIssue,
  getAccessToken: () => Promise<string | null>,
): Promise<void> {
  try {
    if (!WORKFLOW_API_URL) return;
    const token = await getAccessToken();
    if (!token) return;
    await fetch(`${WORKFLOW_API_URL}/issue-notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind,
        issueKey: issue.issueKey,
        title: issue.title,
        description: issue.description,
        purpose: issue.purpose,
        area: issue.area,
        priority: issue.priority,
        assigneeEmail: issue.assigneeEmail,
        assigneeName: issue.assigneeName,
        resolution: issue.resolution,
        attachmentPaths: issue.attachments.map((a) => a.path).slice(0, 3),
      }),
    });
  } catch {
    // best-effort: email failure must never block the issue save.
  }
}

// ---- error surfacing (spec §9-1: never swallow, add remedy for known causes) ----

function friendlyDbError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('column') && (m.includes('does not exist') || m.includes('not found'))) {
    return `${message} — feedback_issues 마이그레이션이 모두 적용됐는지 확인하세요.`;
  }
  if (m.includes('bucket') || m.includes('not_found') && m.includes('object')) {
    return `${message} — 'feedback-attachments' 스토리지 버킷/정책이 생성됐는지 확인하세요.`;
  }
  if (m.includes('row-level security') || m.includes('violates row-level')) {
    return `${message} — 스토리지/테이블 RLS 정책을 확인하세요.`;
  }
  return message;
}
