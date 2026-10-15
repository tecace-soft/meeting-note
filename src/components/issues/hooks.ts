// F2: React hooks for the issues screen (draft, autosave, focus trap, paste, media query).

import { useCallback, useEffect, useRef, useState } from 'react';
import { extractFiles } from '../../lib/issues/keys';
import { EMPTY_DRAFT_STATE, nextDraftState, toPatch, type DraftState } from '../../lib/issues/triageDraft';
import type { Issue, IssueAttachment, PurposeId, TriagePatch } from '../../lib/issues/types';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Spec 6.10: focus the panel, trap Tab, Esc closes, focus returns on close. */
export function useDialogFocus<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const panelRef = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose; // never an effect dependency (would refocus every render)
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // A dialog stacked on top (e.g. delete confirm) owns the keyboard while focused.
      if (!panelRef.current?.contains(document.activeElement)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      returnTo?.focus();
    };
  }, [open]);
  return panelRef;
}

/**
 * TRIAGE-4 / TRIAGE-5: one draft for the board, shared by the fixed panel and the
 * slide-over. Re-aligned when the selected issue's (id, updatedAt) changes.
 */
export function useTriageDraft(issue: Issue | null): [TriagePatch | null, (next: TriagePatch) => void, (saved: Issue) => void] {
  const [state, setState] = useState<DraftState>(EMPTY_DRAFT_STATE);
  const issueRef = useRef(issue);
  issueRef.current = issue;
  const id = issue?.id ?? null;
  const updatedAt = issue?.updatedAt ?? null;
  useEffect(() => {
    // The functional update reads the latest previous state even if React batches.
    setState((prev) => nextDraftState(prev, issueRef.current));
  }, [id, updatedAt]);
  const setDraft = useCallback((next: TriagePatch) => setState((prev) => ({ ...prev, draft: next })), []);
  /** After a successful save the saved row is the new baseline (draft counts as untouched). */
  const resetTo = useCallback((saved: Issue) => {
    const patch = toPatch(saved);
    setState({ currentId: saved.id, base: patch, draft: patch });
  }, []);
  return [state.currentId === id ? state.draft : null, setDraft, resetTo];
}

export interface FormDraft {
  title: string;
  description: string;
  purposeOverride: PurposeId | null;
  areaOverride: string | null;
  attachments: IssueAttachment[];
}

const EMPTY_FORM: FormDraft = { title: '', description: '', purposeOverride: null, areaOverride: null, attachments: [] };
const AUTOSAVE_DELAY_MS = 500;

const isEmptyForm = (f: FormDraft): boolean =>
  !f.title.trim() && !f.description.trim() && !f.purposeOverride && !f.areaOverride && f.attachments.length === 0;

function readStoredDraft(key: string): FormDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<FormDraft>;
    const draft: FormDraft = {
      title: typeof o.title === 'string' ? o.title : '',
      description: typeof o.description === 'string' ? o.description : '',
      purposeOverride: o.purposeOverride ?? null,
      areaOverride: typeof o.areaOverride === 'string' ? o.areaOverride : null,
      attachments: Array.isArray(o.attachments) ? o.attachments.filter((a) => a && typeof a.path === 'string') : [],
    };
    return isEmptyForm(draft) ? null : draft;
  } catch {
    return null; // read failures are ignored (spec C10)
  }
}

function writeStoredDraft(key: string, f: FormDraft): void {
  try {
    if (isEmptyForm(f)) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify({ ...f, savedAt: new Date().toISOString() }));
  } catch {
    /* write failures are ignored (spec C10) */
  }
}

/**
 * CREATE-2 / CREATE-3 / CREATE-4: per-user autosave (500 ms idle) of the user's own input
 * and overrides only (never the computed suggestion). The stored draft is cleared only by
 * a successful submit or [새로 작성], never by unmount or navigation.
 */
export function useIssueFormState(storageKey: string) {
  const [initial] = useState(() => readStoredDraft(storageKey));
  const [form, setForm] = useState<FormDraft>(initial ?? EMPTY_FORM);
  const [restored, setRestored] = useState(initial !== null);

  useEffect(() => {
    const timer = window.setTimeout(() => writeStoredDraft(storageKey, form), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [form, storageKey]);

  const update = useCallback((patch: Partial<FormDraft>) => setForm((prev) => ({ ...prev, ...patch })), []);

  /** After submit / [새로 작성]: empty the form and drop the stored draft immediately. */
  const reset = useCallback(() => {
    setForm(EMPTY_FORM);
    setRestored(false);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* ignored */
    }
  }, [storageKey]);

  return { form, update, setForm, restored, reset };
}

/** ATT-1: one document-level paste listener while mounted; the latest handler via ref. */
export function useDocumentPaste(onFiles: (files: File[]) => void, enabled = true): void {
  const handlerRef = useRef(onFiles);
  handlerRef.current = onFiles;
  useEffect(() => {
    if (!enabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = extractFiles(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        handlerRef.current(files);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [enabled]);
}
