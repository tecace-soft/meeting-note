// F2: data layer over Supabase (spec method A: client -> PostgREST, guarded by RLS +
// triggers in 20261014120000_feedback_issues_parity.sql). Row mapping, CRUD, attachments,
// recipients and the user directory. Errors keep the raw message (ERR-1); the UI adds the
// "{action} 실패:" prefix and the migration hint (ERR-2).

import { supabase } from '../../config/supabaseConfig';
import {
  ATTACHMENT_BUCKET, MAX_ATTACHMENT_BYTES, PRIORITY_ORDER, PURPOSE_ORDER, SCREEN_URL_TTL_SECONDS,
  readStatus, severityOf, LEGACY_NOTIFY_EMAIL,
} from './constants';
import { buildIssueKey, buildPath } from './keys';
import type {
  DirectoryUser, Issue, IssueAttachment, IssueResolution, NotifyRecipient, PriorityId, PurposeId,
  TriagePatch, TriageSuggestion,
} from './types';

export class IssueDataError extends Error {
  readonly code: string;
  constructor(message: string, code = '') {
    super(message);
    this.name = 'IssueDataError';
    this.code = code;
  }
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const isPurpose = (v: unknown): v is PurposeId => typeof v === 'string' && (PURPOSE_ORDER as readonly string[]).includes(v);
const isPriority = (v: unknown): v is PriorityId => typeof v === 'string' && (PRIORITY_ORDER as readonly string[]).includes(v);

/** Only a real rule suggestion is shown (F9 stores ops metadata in the same column). */
function readSuggestion(raw: unknown): TriageSuggestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Row;
  if (!isPurpose(o.purpose) || !isPriority(o.priority)) return null;
  return {
    purpose: o.purpose,
    area: str(o.area) || 'general',
    priority: o.priority,
    severity: severityOf(o.priority),
    reason: str(o.reason),
  };
}

function readResolution(raw: unknown): IssueResolution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Row;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);
  const summary = str(o.summary).trim();
  if (!summary) return null;
  const c = str(o.confidence).toLowerCase();
  return {
    summary,
    rootCauses: list(o.rootCauses),
    checks: list(o.checks),
    fixPlan: list(o.fixPlan),
    verification: list(o.verification),
    confidence: c === 'high' || c === 'medium' ? c : 'low',
  };
}

function readAttachments(raw: unknown): IssueAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Row => !!a && typeof a === 'object')
    .map((a) => ({ name: str(a.name) || str(a.path).split('/').pop() || '-', path: str(a.path), type: str(a.type) }))
    .filter((a) => !!a.path);
}

export function mapRow(row: Row): Issue {
  const priority = isPriority(row.priority) ? row.priority : 'P3';
  return {
    id: str(row.id),
    issueKey: str(row.issue_key),
    title: str(row.title),
    description: str(row.description),
    purpose: isPurpose(row.purpose) ? row.purpose : 'other',
    area: str(row.area) || 'general',
    status: readStatus(str(row.status)),
    priority,
    severity: severityOf(priority),
    assigneeEmail: strOrNull(row.assignee_email),
    assigneeName: strOrNull(row.assignee_name),
    triageNote: strOrNull(row.triage_note),
    aiSuggestion: readSuggestion(row.ai_suggestion),
    attachments: readAttachments(row.attachments),
    resolution: readResolution(row.resolution),
    resolutionGeneratedAt: strOrNull(row.resolution_generated_at),
    resolutionModel: strOrNull(row.resolution_model),
    authorEmail: str(row.author_email),
    authorName: strOrNull(row.author_name),
    triagedAt: strOrNull(row.triaged_at),
    triagedBy: strOrNull(row.triaged_by),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

const fail = (error: { message?: string; code?: string } | null | undefined): never => {
  throw new IssueDataError(error?.message || 'unknown error', error?.code ?? '');
};

/** "Function/table not found" family: the migration has not been applied yet. */
export const isMissingSchemaError = (code: string, message: string): boolean =>
  ['PGRST202', 'PGRST204', 'PGRST205', '42P01', '42883', '42703'].includes(code)
  || /could not find|does not exist|schema cache/i.test(message);

// ---- issues ---------------------------------------------------------------------

export async function listIssues(): Promise<Issue[]> {
  const { data, error } = await supabase
    .from('feedback_issues')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) fail(error);
  return ((data ?? []) as Row[]).map(mapRow);
}

export interface NewIssueInput {
  title: string;
  description: string;
  purpose: PurposeId;
  area: string;
  priority: PriorityId;
  aiSuggestion: TriageSuggestion;
  attachments: IssueAttachment[];
  /** Sent for the NOT NULL column; the DB replaces both with the JWT identity (SEC-4). */
  authorEmail: string;
  authorName: string | null;
}

const MAX_KEY_ATTEMPTS = 3;

export async function createIssue(input: NewIssueInput): Promise<Issue> {
  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt += 1) {
    const { data, error } = await supabase
      .from('feedback_issues')
      .insert({
        issue_key: buildIssueKey(),
        title: input.title,
        description: input.description,
        purpose: input.purpose,
        area: input.area,
        status: 'OPEN',
        priority: input.priority,
        severity: severityOf(input.priority),
        ai_suggestion: input.aiSuggestion,
        attachments: input.attachments,
        author_email: input.authorEmail,
        author_name: input.authorName,
      })
      .select('*')
      .single();
    if (!error) return mapRow(data as Row);
    const keyClash = error.code === '23505' && /issue_key/i.test(`${error.message} ${error.details ?? ''}`);
    if (!keyClash || attempt === MAX_KEY_ATTEMPTS) fail(error);
  }
  throw new IssueDataError('issue key generation failed');
}

/** Section 7.2 triage save. Returns the updated row (drives the mail decision). */
export async function saveTriage(id: string, patch: TriagePatch, actorEmail: string): Promise<Issue> {
  const { data, error } = await supabase
    .from('feedback_issues')
    .update({
      purpose: patch.purpose,
      area: patch.area,
      status: patch.status,
      priority: patch.priority,
      severity: severityOf(patch.priority),
      assignee_email: patch.assigneeEmail,
      assignee_name: patch.assigneeEmail ? patch.assigneeName : null,
      triage_note: patch.triageNote.trim() || null,
      triaged_at: new Date().toISOString(),
      triaged_by: actorEmail,
    })
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) fail(error);
  if (!data) throw new IssueDataError('no row was updated (no permission, or the issue was deleted)', 'NO_ROW');
  return mapRow(data as Row);
}

/** AI-3: only resolution, resolution_generated_at and resolution_model change. */
export async function saveResolution(id: string, resolution: IssueResolution, model: string): Promise<Issue> {
  const { data, error } = await supabase
    .from('feedback_issues')
    .update({ resolution, resolution_model: model, resolution_generated_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  if (error) fail(error);
  if (!data) throw new IssueDataError('no row was updated (no permission, or the issue was deleted)', 'NO_ROW');
  return mapRow(data as Row);
}

/** SEC-5 soft delete through the author-only RPC. Legacy fallback before the migration. */
export async function softDeleteIssue(issue: Issue, selfEmail: string): Promise<void> {
  const { error } = await supabase.rpc('soft_delete_feedback_issue', { p_id: issue.id });
  if (!error) return;
  if (!isMissingSchemaError(error.code ?? '', error.message ?? '')) fail(error);
  if (issue.authorEmail.toLowerCase() !== selfEmail.toLowerCase()) {
    throw new IssueDataError('본인이 등록한 이슈만 삭제할 수 있습니다.', '42501');
  }
  const { error: legacyError } = await supabase
    .from('feedback_issues')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', issue.id);
  if (legacyError) fail(legacyError);
}

// ---- attachments (private bucket, signed URLs) -----------------------------------------

export class AttachmentTooLargeError extends Error {
  constructor(readonly fileName: string) {
    super(fileName);
    this.name = 'AttachmentTooLargeError';
  }
}

export async function uploadAttachment(file: File, name: string): Promise<IssueAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(name);
  const path = buildPath(file);
  const type = file.type || 'image/png';
  const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).upload(path, file, {
    contentType: type,
    upsert: false,
  });
  if (error) fail({ message: error.message, code: (error as { statusCode?: string }).statusCode ?? '' });
  return { name, path, type };
}

/** Best effort: the storage policy refuses objects that an issue references. */
export async function deleteAttachment(path: string): Promise<void> {
  const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).remove([path]);
  if (error) console.warn('Issue attachment delete failed:', error.message);
}

export async function signAttachmentUrls(paths: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(paths.filter(Boolean)));
  if (unique.length === 0) return {};
  const { data, error } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrls(unique, SCREEN_URL_TTL_SECONDS);
  if (error) {
    console.warn('Issue attachment signing failed:', error.message);
    return {};
  }
  const out: Record<string, string> = {};
  for (const item of data ?? []) {
    if (item.signedUrl && item.path) out[item.path] = item.signedUrl;
  }
  return out;
}

// ---- notification recipients (RCPT) ------------------------------------------------

export type RecipientsResult =
  | { status: 'ok'; recipients: NotifyRecipient[] }
  | { status: 'missing_table' }
  | { status: 'error'; message: string };

export async function fetchRecipients(): Promise<RecipientsResult> {
  const { data, error } = await supabase
    .from('issue_notify_recipients')
    .select('email, added_by, added_at')
    .order('added_at', { ascending: true });
  if (error) {
    return isMissingSchemaError(error.code ?? '', error.message ?? '')
      ? { status: 'missing_table' }
      : { status: 'error', message: error.message };
  }
  return {
    status: 'ok',
    recipients: ((data ?? []) as Row[]).map((r) => ({ email: str(r.email), addedBy: strOrNull(r.added_by), addedAt: strOrNull(r.added_at) })),
  };
}

/** RCPT-2: unreadable -> the single fallback recipient; readable but empty -> []. */
export async function resolveNotifyEmails(): Promise<string[]> {
  const r = await fetchRecipients();
  return r.status === 'ok' ? r.recipients.map((x) => x.email) : [LEGACY_NOTIFY_EMAIL];
}

export async function saveRecipients(change: { added: string[]; removed: string[] }): Promise<void> {
  const added = Array.from(new Set(change.added.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  const removed = Array.from(new Set(change.removed.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  if (added.length > 0) {
    const { error } = await supabase.from('issue_notify_recipients').insert(added.map((email) => ({ email })));
    if (error) fail(error);
  }
  if (removed.length > 0) {
    const { error } = await supabase.from('issue_notify_recipients').delete().in('email', removed);
    if (error) fail(error);
  }
}

// ---- user directory (C3) --------------------------------------------------------------

export async function fetchDirectory(): Promise<DirectoryUser[]> {
  const { data, error } = await supabase.rpc('list_issue_directory');
  if (error) {
    console.warn('Issue directory unavailable:', error.message);
    return [];
  }
  return ((data ?? []) as Row[])
    .map((r) => ({ email: str(r.email).toLowerCase(), displayName: strOrNull(r.display_name), isAdmin: r.is_admin === true }))
    .filter((u) => u.email.includes('@'));
}
