// F2: UI-side permission rule (spec SEC-2, SEC-10). Hiding controls is convenience only;
// the real checks are server/DB side and MUST stay the same rule:
//   - DB:     public.feedback_issues_can(key) in
//             supabase/migrations/20261014120000_feedback_issues_parity.sql
//   - server: canIssue() in workflow-server/src/issues.ts
// Admin list: ADMIN_MICROSOFT_USER_IDS in src/lib/adminAccess.ts (same ids in all three).

import { isAdminMicrosoftUser } from '../adminAccess';

export type IssueFeature = 'issues' | 'issues.triage' | 'issues.notify';

/** userId = Microsoft object id (the Supabase JWT `sub`). */
export function canIssue(userId: string | null | undefined, feature: IssueFeature): boolean {
  if (!userId) return false;
  if (feature === 'issues') return true;
  return isAdminMicrosoftUser(userId);
}
