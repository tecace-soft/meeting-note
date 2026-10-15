// F2: triage panel draft rules (spec section 6.6, TRIAGE-4).
// Switching to another issue resets the draft to server values. A refresh of the SAME
// issue replaces the draft only when the user has not touched it.

import type { Issue, TriagePatch } from './types';

export const toPatch = (i: Issue): TriagePatch => ({
  purpose: i.purpose,
  area: i.area,
  status: i.status,
  priority: i.priority,
  assigneeEmail: i.assigneeEmail,
  assigneeName: i.assigneeName,
  triageNote: i.triageNote ?? '',
});

export const samePatch = (a: TriagePatch | null, b: TriagePatch | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export interface DraftState {
  currentId: string | null;
  base: TriagePatch | null; // last server values the draft was aligned to
  draft: TriagePatch | null;
}

export const EMPTY_DRAFT_STATE: DraftState = { currentId: null, base: null, draft: null };

/** Pure transition run when the selected issue's (id, updatedAt) changes. */
export function nextDraftState(prev: DraftState, issue: Issue | null): DraftState {
  const next = issue ? toPatch(issue) : null;
  const switched = prev.currentId !== (issue?.id ?? null);
  const untouched = samePatch(prev.draft, prev.base);
  return {
    currentId: issue?.id ?? null,
    base: next,
    draft: switched || untouched ? next : prev.draft,
  };
}

/** [제안 적용]: purpose / area / priority from the creation-time suggestion (not saved). */
export function applySuggestion(draft: TriagePatch, issue: Issue): TriagePatch {
  const s = issue.aiSuggestion;
  if (!s) return draft;
  return { ...draft, purpose: s.purpose, area: s.area, priority: s.priority };
}

export function suggestionApplied(draft: TriagePatch | null, issue: Issue): boolean {
  const s = issue.aiSuggestion;
  if (!s || !draft) return false;
  return draft.purpose === s.purpose && draft.area === s.area && draft.priority === s.priority;
}
