// F2 feedback / issue tracker: domain types (spec section 4.1).

export type PurposeId = 'bug' | 'feature' | 'question' | 'other';
export type AreaId = string; // 'general' | one of AREA_OPTIONS ids (legacy values are kept as-is)
export type IssueStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CLOSED';
export type PriorityId = 'P1' | 'P2' | 'P3' | 'P4';
export type SeverityId = 'Critical' | 'High' | 'Medium' | 'Low';

export interface IssueAttachment {
  name: string;
  path: string;
  type: string; // MIME
}

export interface TriageSuggestion {
  purpose: PurposeId;
  area: AreaId;
  priority: PriorityId;
  severity: SeverityId;
  reason: string;
}

export interface IssueResolution {
  summary: string;
  rootCauses: string[];
  checks: string[];
  fixPlan: string[];
  verification: string[];
  confidence: 'low' | 'medium' | 'high';
}

export interface Issue {
  id: string;
  issueKey: string;
  title: string;
  description: string;
  purpose: PurposeId;
  area: AreaId;
  status: IssueStatus;
  priority: PriorityId;
  severity: SeverityId;
  assigneeEmail: string | null;
  assigneeName: string | null;
  triageNote: string | null;
  /** Creation-time rule suggestion. Null when absent or not suggestion-shaped (F9 ops metadata). */
  aiSuggestion: TriageSuggestion | null;
  attachments: IssueAttachment[];
  resolution: IssueResolution | null;
  resolutionGeneratedAt: string | null;
  resolutionModel: string | null;
  authorEmail: string;
  authorName: string | null;
  /**
   * Microsoft object id of the author, stamped by the DB from the JWT `sub`. The ownership key
   * (delete, "is this mine"); authorEmail is display only. Null on rows filed before the
   * 2026-10-15 migration and not backfilled, and on F9 ops rows.
   */
  authorId: string | null;
  triagedAt: string | null;
  triagedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The triage panel edit state (draft). */
export interface TriagePatch {
  purpose: PurposeId;
  area: AreaId;
  status: IssueStatus;
  priority: PriorityId;
  assigneeEmail: string | null;
  assigneeName: string | null;
  triageNote: string;
}

/** One entry of the user directory (spec C3): app users with an email. */
export interface DirectoryUser {
  email: string;
  displayName: string | null;
  isAdmin: boolean;
}

export interface NotifyRecipient {
  email: string;
  addedBy: string | null;
  addedAt: string | null;
}
