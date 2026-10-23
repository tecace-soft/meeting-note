import { firstFrontendOrigin } from './issues.js';

// APP_FRONTEND_ORIGIN may be a comma-separated CORS list: the first origin is the mail link
// base. With '*' or nothing set, links stay relative (they do not open from a mail client).
let warnedRelativeDeepLink = false;

export function issueDeepLink(issueKey: string): string {
  const origin = firstFrontendOrigin(process.env.APP_FRONTEND_ORIGIN);
  if (!origin && !warnedRelativeDeepLink) {
    warnedRelativeDeepLink = true;
    console.warn('APP_FRONTEND_ORIGIN is "*" or unset: issue mail deep links are relative and will not open from a mail client.');
  }
  return `${origin}/issues?issue=${encodeURIComponent(issueKey)}`;
}
