import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { getBearerToken, readBody, sendJson } from '../http/shared.js';
import { getMicrosoftProfile } from '../http/identity.js';
import { callGeminiWithFallback } from '../ai/geminiFallback.js';
import { ISSUE_RESOLUTION_MODEL, ISSUE_RESOLUTION_FALLBACK_CHAIN, liteModelFromEnv } from '../gemini-models.js';
import { CREATED_MAIL_LIMIT_PER_HOUR, ISSUE_KEY_PATTERN, ISSUE_RESOLUTION_SCHEMA, ISSUE_RESOLUTION_SYSTEM_PROMPT, buildIssueMail, buildResolutionUserText, canIssue, decideNotify, imageAttachmentPaths, parseNotifyKind, parseResolutionRequest, resolveNotifyEmails, validateResolution, type IssueRow, type NotifyKind, type RecipientsRead } from '../issues.js';
import { sendEmail } from '../alerts.js';
import { issueDeepLink } from '../issueLinks.js';

// ── F2: feedback / issue tracker: AI resolution + server-side notification mail ──────
// Rules (permissions, recipients, templates, schema) live in ./issues.ts; these handlers do
// the I/O. Spec: docs/feedback-issues-porting-prompt.md sections 3.7, 3.9, 7.1, 9.

const ISSUE_ATTACHMENT_BUCKET = 'feedback-attachments';

// Spec 1.4 says 30 days; shortened to 24 hours after the 2026-10-15 security review so a
// forwarded mail does not keep screenshots open for a month. The deep-link button (which
// re-signs on open) is the primary way back to the issue.
const ISSUE_MAIL_URL_TTL_SECONDS = 24 * 60 * 60;

// AI-4: up to 3 image attachments, read from the private bucket with the service role and
// handed to Gemini inline. The paths come from the issue ROW in the DB (looked up by
// issueKey), never from the request body, and must pass isSafeAttachmentPath, so a caller
// cannot point the service role at another object. The spec's 15-minute signed URL is the
// alternative; inline bytes need no URL at all.
async function issueAttachmentImageParts(issueKey: string): Promise<Array<{ inlineData: { mimeType: string; data: string } }>> {
  const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
  if (!ISSUE_KEY_PATTERN.test(issueKey)) return parts;
  const { data: row, error: rowError } = await supabase
    .from('feedback_issues')
    .select('attachments')
    .eq('issue_key', issueKey)
    .is('deleted_at', null)
    .maybeSingle();
  if (rowError) throw rowError;
  const paths = imageAttachmentPaths((row as { attachments?: unknown } | null)?.attachments, 3);
  for (const path of paths) {
    try {
      const { data, error } = await supabase.storage.from(ISSUE_ATTACHMENT_BUCKET).download(path);
      if (error || !data) continue;
      const mimeType = data.type || 'image/png';
      if (!mimeType.startsWith('image/')) continue;
      const buffer = Buffer.from(await data.arrayBuffer());
      if (buffer.length > 8 * 1024 * 1024) continue;
      parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } });
    } catch (error) {
      console.warn(`Issue attachment fetch failed (${path}):`, error);
    }
  }
  return parts;
}

// Section 7.1. Order: method, issues.triage, input, LLM, response. Always JSON.
// The endpoint never writes the DB (AI-3); the browser saves the result with triage rights.
async function issueResolution(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'POST 요청만 받습니다.' });
    return;
  }
  const caller = await getMicrosoftProfile(getBearerToken(req));
  if (!canIssue(caller.id, 'issues.triage')) {
    sendJson(res, 403, { error: '해결책 생성은 관리자 권한이 필요합니다.' });
    return;
  }
  const parsed = parseResolutionRequest(await readBody(req, 200_000));
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  if (!env.geminiApiKey) throw new Error('Gemini API key is missing.');
  const request = parsed.value;
  const imageParts = await issueAttachmentImageParts(request.issueKey);
  const result = await callGeminiWithFallback({
    stage: 'Issue resolution',
    model: liteModelFromEnv('ISSUE_RESOLUTION_MODEL', process.env.ISSUE_RESOLUTION_MODEL, ISSUE_RESOLUTION_MODEL),
    fallbackModels: [...ISSUE_RESOLUTION_FALLBACK_CHAIN],
    responseMimeType: 'application/json',
    responseSchema: ISSUE_RESOLUTION_SCHEMA,
    maxOutputTokens: 16000,
    // docs/API_LESSONS.md: thinking tokens eat the output budget and truncate JSON on lite models.
    thinkingBudget: 0,
    parts: [...imageParts, { text: `${ISSUE_RESOLUTION_SYSTEM_PROMPT}\n\n${buildResolutionUserText(request)}` }],
  });
  const resolution = validateResolution(result.text);
  if (!resolution) {
    sendJson(res, 502, { error: '해결책 응답이 지정한 형식과 맞지 않습니다. 다시 생성해 주세요.' });
    return;
  }
  sendJson(res, 200, { resolution, model: result.model });
}

async function readNotifyRecipients(): Promise<RecipientsRead> {
  const { data, error } = await supabase.from('issue_notify_recipients').select('email');
  if (error) {
    const missing = error.code === '42P01' || error.code === 'PGRST205' || /could not find|does not exist/i.test(error.message ?? '');
    console.warn(`Issue notify recipients unreadable (${missing ? 'missing table' : 'error'}): ${error.message}`);
    return missing ? { status: 'missing_table' } : { status: 'error' };
  }
  const emails = ((data as Array<{ email?: unknown }>) ?? [])
    .map((r) => (typeof r.email === 'string' ? r.email : ''))
    .filter(Boolean);
  return { status: 'ok', emails };
}

/** Issues the author filed in the last hour (soft-deleted ones count too). */
// Counted by author_id (the object id; an email can be shared by several accounts). Rows
// without author_id (filed before 20261015120000) fall back to the email count.
async function countAuthorIssuesLastHour(row: Pick<IssueRow, 'author_id' | 'author_email'>): Promise<number> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const authorId = row.author_id?.trim().toLowerCase();
  const query = supabase
    .from('feedback_issues')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', hourAgo);
  const pattern = row.author_email.replace(/[\\%_]/g, (c) => `\\${c}`); // exact, case-insensitive match
  const { count, error } = authorId
    ? await query.eq('author_id', authorId)
    : await query.ilike('author_email', pattern);
  if (error) throw error;
  return count ?? 0;
}

async function sendIssueMail(kind: NotifyKind, row: IssueRow, to: string[], actor: { name: string | null; email: string }): Promise<void> {
  try {
    const paths = imageAttachmentPaths(row.attachments);
    let imageUrls: string[] = [];
    if (paths.length > 0 && kind !== 'resolved') {
      const { data } = await supabase.storage.from(ISSUE_ATTACHMENT_BUCKET).createSignedUrls(paths, ISSUE_MAIL_URL_TTL_SECONDS);
      imageUrls = (data ?? []).map((d) => d.signedUrl).filter((u): u is string => Boolean(u));
    }
    const mail = buildIssueMail({ kind, row, actor, imageUrls, deepLink: issueDeepLink(row.issue_key) });
    const sent = await sendEmail({ to, subject: mail.subject, html: mail.html });
    if (!sent) console.warn(`Issue mail (${kind}) for ${row.issue_key} was not sent.`);
  } catch (error) {
    // NOTIFY-4: best effort, log only.
    console.warn(`Issue mail (${kind}) for ${row.issue_key} failed:`, error);
  }
}

// N1 / N2 / N3. The body names an event and an issue key only; recipients and content come
// from the DB row (the old endpoint mailed client-supplied text to client-supplied addresses).
// Mobile still posts { kind: 'created', issueKey, ...legacy fields }; the extra fields are ignored.
async function issueNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const caller = await getMicrosoftProfile(getBearerToken(req));
  const body = (await readBody(req, 200_000)) as Record<string, unknown> | null;
  const kind = parseNotifyKind(body?.kind);
  const issueKey = typeof body?.issueKey === 'string' ? body.issueKey.trim() : '';
  if (!kind || !ISSUE_KEY_PATTERN.test(issueKey)) {
    sendJson(res, 400, { error: 'kind 와 issueKey 가 필요합니다.' });
    return;
  }
  const { data, error } = await supabase
    .from('feedback_issues')
    .select('issue_key, title, description, purpose, area, status, priority, assignee_email, assignee_name, triage_note, resolution, attachments, author_email, author_name, author_id, created_at, deleted_at')
    .eq('issue_key', issueKey)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    sendJson(res, 404, { error: '이슈를 찾을 수 없습니다.' });
    return;
  }
  const row = data as IssueRow;
  const createdRecipients = kind === 'created' ? resolveNotifyEmails(await readNotifyRecipients()) : [];
  const decision = decideNotify({ kind, row, caller: { id: caller.id, email: caller.email }, createdRecipients, now: Date.now() });
  if (!decision.ok) {
    sendJson(res, decision.status, { error: decision.error });
    return;
  }
  if (kind === 'created') {
    const recent = await countAuthorIssuesLastHour(row);
    if (recent > CREATED_MAIL_LIMIT_PER_HOUR) {
      console.warn(`Issue mail (created) for ${row.issue_key} skipped: ${recent} issues by this author in the last hour (limit ${CREATED_MAIL_LIMIT_PER_HOUR}).`);
      sendJson(res, 429, { error: '최근 1시간 동안 등록이 많아 알림 메일을 보내지 않았습니다.' });
      return;
    }
  }
  // CREATE-11: answer with the confirmed recipients first, then send in the background.
  sendJson(res, 200, { ok: true, notifiedEmails: decision.to });
  // The new-issue mail goes out once per issue. NOTE: this dedupe is in-memory, so it resets
  // when the server restarts / redeploys; the 15-minute window and the hourly author cap
  // above bound what a retry can do across restarts.
  if (kind === 'created') {
    if (createdIssueMailSent.has(row.issue_key)) return;
    if (createdIssueMailSent.size >= CREATED_MAIL_DEDUPE_MAX) createdIssueMailSent.clear();
    createdIssueMailSent.add(row.issue_key);
  }
  if (decision.to.length > 0) void sendIssueMail(kind, row, decision.to, { name: caller.name, email: caller.email });
}

// Bounded (Power of Ten rule 8); entries only matter inside the 15-minute created window.
const CREATED_MAIL_DEDUPE_MAX = 1000;

const createdIssueMailSent = new Set<string>();

export async function handleIssuesRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/issue-resolution') { await issueResolution(req, res); return true; }
  if (req.method === 'POST' && req.url === '/issue-notify') { await issueNotify(req, res); return true; }
  return false;
}
