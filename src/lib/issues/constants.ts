// F2 feedback / issue tracker: constants and tiny pure helpers (spec section 6.1).
// Korean labels are the spec's exact wording (section 8.4); English labels say the same.

import type { AppLanguage } from '../../context/LanguageContext';
import type { Issue, IssueStatus, PriorityId, PurposeId, SeverityId } from './types';

type Labels<K extends string> = Record<AppLanguage, Record<K, string>>;

export const PURPOSE_LABEL: Labels<PurposeId> = {
  ko: { bug: '버그', feature: '개선 요청', question: '질문', other: '기타' },
  en: { bug: 'Bug', feature: 'Improvement', question: 'Question', other: 'Other' },
};

export const STATUS_LABEL: Labels<IssueStatus> = {
  ko: { OPEN: '접수', IN_PROGRESS: '진행 중', DONE: '완료', CLOSED: '닫힘' },
  en: { OPEN: 'Received', IN_PROGRESS: 'In progress', DONE: 'Done', CLOSED: 'Closed' },
};

export const PRIORITY_LABEL: Labels<PriorityId> = {
  ko: { P1: '긴급', P2: '높음', P3: '보통', P4: '낮음' },
  en: { P1: 'Urgent', P2: 'High', P3: 'Normal', P4: 'Low' },
};

export const SEVERITY_BY_PRIORITY: Record<PriorityId, SeverityId> = {
  P1: 'Critical',
  P2: 'High',
  P3: 'Medium',
  P4: 'Low',
};

/** List group order and purpose button order. */
export const PURPOSE_ORDER: readonly PurposeId[] = ['bug', 'feature', 'question', 'other'];
export const STATUS_ORDER: readonly IssueStatus[] = ['OPEN', 'IN_PROGRESS', 'DONE', 'CLOSED'];
export const PRIORITY_ORDER: readonly PriorityId[] = ['P1', 'P2', 'P3', 'P4'];

export interface AreaOption {
  id: string;
  ko: string;
  en: string;
  /** False for display-only areas (legacy mobile values are selectable; F9 'ops' is not). */
  selectable: boolean;
}

// Screens of this app (sidebar menu) + general. 'onedrive' / 'speaker' are kept because
// existing rows and the mobile app use them; 'ops' is written only by the F9 ops agent.
export const AREA_OPTIONS: readonly AreaOption[] = [
  { id: 'general', ko: '일반', en: 'General', selectable: true },
  { id: 'meeting-note', ko: '회의 노트', en: 'Meeting note', selectable: true },
  { id: 'history', ko: '히스토리', en: 'History', selectable: true },
  { id: 'projects', ko: '프로젝트', en: 'Projects', selectable: true },
  { id: 'settings', ko: '계정 설정', en: 'Account settings', selectable: true },
  { id: 'issues', ko: '피드백 / 이슈', en: 'Feedback / Issues', selectable: true },
  { id: 'docs', ko: '문서', en: 'Docs', selectable: true },
  { id: 'onedrive', ko: 'OneDrive', en: 'OneDrive', selectable: true },
  { id: 'speaker', ko: '화자', en: 'Speakers', selectable: true },
  { id: 'ops', ko: '운영', en: 'Operations', selectable: false },
];

export const severityOf = (p: PriorityId): SeverityId => SEVERITY_BY_PRIORITY[p];

export const isOpenStatus = (s: IssueStatus): boolean => s !== 'DONE' && s !== 'CLOSED';

/** DATA-3: only four statuses exist; anything else (legacy TRIAGE) reads as OPEN. */
export const readStatus = (raw: string): IssueStatus =>
  ((STATUS_ORDER as readonly string[]).includes(raw) ? raw : 'OPEN') as IssueStatus;

export const purposeLabel = (p: PurposeId, lang: AppLanguage): string => PURPOSE_LABEL[lang][p] ?? p;
export const statusLabel = (s: IssueStatus, lang: AppLanguage): string => STATUS_LABEL[lang][s] ?? s;
export const priorityLabel = (p: PriorityId, lang: AppLanguage): string => PRIORITY_LABEL[lang][p] ?? p;

/** Area label; an unknown legacy value is shown as stored (never hidden). */
export const areaLabel = (area: string, lang: AppLanguage): string => {
  const found = AREA_OPTIONS.find((a) => a.id === area);
  return found ? found[lang] : area;
};

/** Person display: name when present, else the email's local part. */
export const personLabel = (name: string | null, email: string | null): string =>
  name?.trim() || email?.split('@')[0] || '-';

export const assigneeLabel = (i: Issue, unassigned: string): string =>
  i.assigneeEmail ? personLabel(i.assigneeName, i.assigneeEmail) : unassigned;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_BUCKET = 'feedback-attachments';
/** Signed URL lifetimes (seconds): screen 1h. Mail 30d and LLM are server-side. */
export const SCREEN_URL_TTL_SECONDS = 60 * 60;
export const NOTIFY_RECIPIENTS_MIGRATION = '20261014120000_feedback_issues_parity.sql';
/** RCPT-2 fallback when the recipient table is unreadable (same as the migration seed). */
export const LEGACY_NOTIFY_EMAIL = 'andrewyoo@tecace.com';
