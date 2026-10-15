// F2: workflow-server calls. Mail is sent by the server from the DB row (NOTIFY-6); the
// browser only says which issue and which event. The LLM key never reaches the browser
// (SEC-8). Auth = the Microsoft Graph access token, like the other workflow routes.

import type { Issue, IssueResolution } from './types';

const WORKFLOW_API_URL = ((import.meta.env.VITE_WORKFLOW_API_URL as string | undefined) ?? '').replace(/\/$/, '');

export const RESOLUTION_PATH = '/issue-resolution';
const NOTIFY_PATH = '/issue-notify';

type TokenGetter = () => Promise<string | null>;

export class ResolutionServerError extends Error {
  constructor(message: string, readonly kind: 'unreachable' | 'server', readonly status: number) {
    super(message);
    this.name = 'ResolutionServerError';
  }
}

async function authHeaders(getAccessToken: TokenGetter): Promise<Record<string, string>> {
  const token = await getAccessToken();
  if (!token) throw new Error('Microsoft access token is unavailable.');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/**
 * New-issue mail (N1). The server resolves the recipients first, answers with them, then
 * sends in the background. Returns null when the request failed (unreachable, refused,
 * rate-limited), so the completion screen never claims a mail it did not hand off.
 */
export async function notifyCreated(issueKey: string, getAccessToken: TokenGetter): Promise<string[] | null> {
  try {
    if (!WORKFLOW_API_URL) return null;
    const res = await fetch(`${WORKFLOW_API_URL}${NOTIFY_PATH}`, {
      method: 'POST',
      headers: await authHeaders(getAccessToken),
      body: JSON.stringify({ kind: 'created', issueKey }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { notifiedEmails?: unknown } | null;
    return Array.isArray(body?.notifiedEmails) ? body.notifiedEmails.filter((e): e is string => typeof e === 'string') : null;
  } catch (error) {
    console.warn('Issue notify (created) failed:', error);
    return null;
  }
}

/** N2 / N3 after a triage save. Fire and forget, never throws (NOTIFY-4). */
export function notifyAfterTriage(kind: 'assigned' | 'resolved', issueKey: string, getAccessToken: TokenGetter): void {
  void (async () => {
    try {
      if (!WORKFLOW_API_URL) return;
      await fetch(`${WORKFLOW_API_URL}${NOTIFY_PATH}`, {
        method: 'POST',
        headers: await authHeaders(getAccessToken),
        body: JSON.stringify({ kind, issueKey }),
      });
    } catch (error) {
      console.warn(`Issue notify (${kind}) failed:`, error);
    }
  })();
}

/** Section 7.1. Throws ResolutionServerError('unreachable') when the answer is not JSON (AI-8). */
export async function generateResolution(issue: Issue, getAccessToken: TokenGetter): Promise<{ resolution: IssueResolution; model: string }> {
  const res = await fetch(`${WORKFLOW_API_URL}${RESOLUTION_PATH}`, {
    method: 'POST',
    headers: await authHeaders(getAccessToken),
    body: JSON.stringify({
      issueKey: issue.issueKey,
      title: issue.title,
      description: issue.description,
      purpose: issue.purpose,
      area: issue.area,
      priority: issue.priority,
      severity: issue.severity,
      // Screenshots are not sent: the server reads them from this issue's DB row (issueKey).
    }),
  });
  const text = await res.text();
  type Body = { resolution?: IssueResolution; model?: string; error?: string };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') throw new ResolutionServerError(text, 'unreachable', res.status);
  const body = parsed as Body;
  if (!res.ok || !body.resolution) throw new ResolutionServerError(body.error || `HTTP ${res.status}`, 'server', res.status);
  return { resolution: body.resolution, model: body.model ?? '' };
}
