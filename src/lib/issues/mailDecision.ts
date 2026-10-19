// F2: post-save mail decision, recipient wording and the save-line text
// (spec sections 6.8, 6.9; TRIAGE-7, TRIAGE-8, NOTIFY-2, NOTIFY-3, CREATE-10).

import type { AppLanguage } from '../../context/LanguageContext';
import { isOpenStatus } from './constants';
import type { DirectoryUser, Issue } from './types';

// NOTE: sameEmail(null, null) = true, so "assignee changed?" treats null -> null as no
// change. Unlike `same` in listFilter.ts. Do not merge the two.
export const sameEmail = (a: string | null, b: string | null): boolean =>
  (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** System authors (F9 ops agent) have no inbox; they never get the N3 mail. */
export const SYSTEM_AUTHOR_EMAILS: readonly string[] = ['ops-agent@tecace.com'];

export interface MailDecision {
  assigneeMailed: string | null;
  authorMailed: boolean;
}

export function mailAfterSave(before: Issue, updated: Issue, actor: { email: string; id?: string | null }): MailDecision {
  const reassigned = !sameEmail(before.assigneeEmail, updated.assigneeEmail)
    && !!updated.assigneeEmail && !sameEmail(updated.assigneeEmail, actor.email);
  // Self-mail suppression (not a permission): by object id when the row has one, like the server.
  const actorIsAuthor = updated.authorId
    ? !!actor.id && updated.authorId === actor.id.trim().toLowerCase()
    : sameEmail(updated.authorEmail, actor.email);
  const resolved = isOpenStatus(before.status) && !isOpenStatus(updated.status)
    && !actorIsAuthor
    && !SYSTEM_AUTHOR_EMAILS.includes(updated.authorEmail.toLowerCase());
  return { assigneeMailed: reassigned ? updated.assigneeEmail : null, authorMailed: resolved };
}

/** "Hansoo Lee" / "Hansoo Lee 외 1명" (completion screen wording). */
export const describeRecipients = (
  emails: string[],
  directory: Pick<DirectoryUser, 'email' | 'displayName'>[],
  lang: AppLanguage = 'ko',
): string => {
  const nameOf = (e: string) =>
    directory.find((d) => d.email.toLowerCase() === e.toLowerCase())?.displayName?.trim() || e.split('@')[0];
  if (emails.length === 0) return '';
  if (emails.length === 1) return nameOf(emails[0]);
  return lang === 'ko'
    ? `${nameOf(emails[0])} 외 ${emails.length - 1}명`
    : `${nameOf(emails[0])} and ${emails.length - 1} more`;
};

/** 24-hour HH:mm. */
export const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** "저장됨 14:02 · Hansoo Lee에게 배정 메일 · 등록자에게 처리 알림" */
export const savedText = (at: Date, o: MailDecision, assigneeName: string | null, lang: AppLanguage = 'ko'): string => {
  const who = assigneeName ?? (o.assigneeMailed ? o.assigneeMailed.split('@')[0] : '');
  if (lang === 'ko') {
    return [`저장됨 ${hhmm(at)}`,
      ...(o.assigneeMailed ? [`${who}에게 배정 메일`] : []),
      ...(o.authorMailed ? ['등록자에게 처리 알림'] : [])].join(' · ');
  }
  return [`Saved ${hhmm(at)}`,
    ...(o.assigneeMailed ? [`assignment mail to ${who}`] : []),
    ...(o.authorMailed ? ['author notified'] : [])].join(' · ');
};

/** List meta date: "M. D. HH:mm" (24h, no year). */
export const listDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getMonth() + 1}. ${d.getDate()}. ${hhmm(d)}`;
};

/** Panel header date: locale medium date + short time. */
export const headerDate = (iso: string, lang: AppLanguage): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
};
