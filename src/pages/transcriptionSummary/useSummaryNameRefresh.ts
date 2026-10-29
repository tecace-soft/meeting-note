import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeadlineError, withDeadline } from '../../lib/deadline';
import { namingSignature } from '../../lib/speakers/mainSpeakers';
import type { RegenerateSummaryResult } from '../../lib/regenerateSummary';
import type { TranscriptSegment } from '../../lib/transcriptSegments';

/** Wait after the last naming change before regenerating (DEC-0024). */
export const NAME_REFRESH_DEBOUNCE_MS = 4000;
/** Automatic refreshes per note per page session; the manual button is not counted. */
export const MAX_AUTO_NAME_REFRESHES_PER_NOTE = 3;
/** Upper bound for one whole run (token, reads, regenerate, save), whatever step hangs. */
export const NAME_REFRESH_RUN_DEADLINE_MS = 150_000;

export interface SummaryNameRefreshInput {
  /** The note whose summary is on screen, or null while there is none (disables and resets). */
  noteId: string | null;
  /** Original-language transcript with the names the user applied. */
  segments: TranscriptSegment[];
  /** Summary texts this page knows were generated for the note (job summary and its translations). */
  generatedTexts: readonly string[];
  /** The summary text currently shown. */
  currentSummary: string;
  /** True while the summary editor is open. */
  isEditing: boolean;
  /** Regenerate with these segments, asking the server not to save (persist:false). */
  regenerate: (segments: TranscriptSegment[], signal: AbortSignal) => Promise<RegenerateSummaryResult>;
  /** Owner-scoped read of the saved summary_edit. */
  readSavedEdit: () => Promise<string | null>;
  /**
   * Owner-scoped save of summary_edit. With onlyIfUnsaved the write only lands while summary_edit
   * is still empty and resolves false when it was not; otherwise it throws when nothing was saved.
   */
  saveSummary: (text: string, options: { onlyIfUnsaved: boolean }) => Promise<boolean>;
  /** Show `text` as the summary. */
  onApply: (text: string) => void;
}

type RunMode = 'auto' | 'retry' | 'manual';
export type NameRefreshPhase = 'idle' | 'scheduled' | 'running';

export interface SummaryNameRefresh {
  phase: NameRefreshPhase;
  error: string | null;
  /** A regenerated summary waiting for the user because the current one was edited by hand. */
  pendingReplacement: string | null;
  /** True when automatic refresh stopped for this note (cap reached or an older server). */
  autoPaused: boolean;
  /** An older server saved the summary itself; automatic refresh is off for this note. */
  serverSavedNotice: boolean;
  /** "Update summary with names": regenerate now and replace (the user asked for it). */
  runManual: () => void;
  /** Retry after a failure, with the same hand-edit protection as the automatic refresh. */
  retry: () => void;
  acceptReplacement: () => Promise<void>;
  dismissReplacement: () => void;
}

interface SavedEditState {
  /** The saved summary_edit is a hand edit (or could not be read). */
  edited: boolean;
  /** Nothing is saved yet, so a conditional "only if still empty" write is possible. */
  empty: boolean;
}

const normalize = (text: string) => text.trim();

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Could not update the summary.';
}

/**
 * Name-aware summary refresh (U9, DEC-0024): once every main speaker has a real name, wait
 * NAME_REFRESH_DEBOUNCE_MS after the last naming change and regenerate once. At most one request
 * runs at a time; a hand-edited summary is never replaced without the user's consent.
 */
export function useSummaryNameRefresh(input: SummaryNameRefreshInput): SummaryNameRefresh {
  const { noteId, segments } = input;
  const latest = useRef(input);
  latest.current = input;

  const [phase, setPhase] = useState<NameRefreshPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ text: string; signature: string | null } | null>(null);
  const [autoPaused, setAutoPaused] = useState(false);
  const [serverSavedNotice, setServerSavedNotice] = useState(false);
  // Bumped whenever the refs below change so the scheduling effect re-evaluates.
  const [revision, setRevision] = useState(0);

  const noteRef = useRef<string | null>(null);
  const baselineRef = useRef<string | null>(null);
  const lastAttemptRef = useRef<string | null>(null);
  const autoCountRef = useRef(0);
  const olderServerRef = useRef(false);
  const generatedRef = useRef<Set<string>>(new Set());
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const signature = useMemo(() => namingSignature(segments), [segments]);

  // Reset per note: the summary on screen reflects the names it was generated with.
  if (noteRef.current !== noteId) {
    noteRef.current = noteId;
    baselineRef.current = noteId ? signature : null;
    lastAttemptRef.current = null;
    autoCountRef.current = 0;
    olderServerRef.current = false;
    generatedRef.current = new Set();
  }
  for (const text of input.generatedTexts) {
    if (normalize(text)) generatedRef.current.add(normalize(text));
  }

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setPhase('idle');
    setError(null);
    setPending(null);
    setAutoPaused(false);
    setServerSavedNotice(false);
  }, [noteId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const isGenerated = useCallback((text: string) => generatedRef.current.has(normalize(text)), []);

  const readSavedEditState = useCallback(async (): Promise<SavedEditState> => {
    try {
      const saved = await latest.current.readSavedEdit();
      const empty = saved === null || normalize(saved) === '';
      return { edited: !empty && !isGenerated(saved as string), empty };
    } catch (readError) {
      console.warn('Could not read the saved summary; treating it as edited so it is not replaced:', readError);
      return { edited: true, empty: false };
    }
  }, [isGenerated]);

  const editedOnThisPage = useCallback(
    () => latest.current.isEditing || !isGenerated(latest.current.currentSummary),
    [isGenerated]
  );

  /** Record `text` as generated and as the summary of `appliedSignature`; show it unless the editor is open. */
  const show = useCallback((text: string, appliedSignature: string | null) => {
    generatedRef.current.add(normalize(text));
    baselineRef.current = appliedSignature;
    // Already saved; an editor opened meanwhile keeps the user's text on screen (Done saves it).
    if (!latest.current.isEditing) latest.current.onApply(text);
  }, []);

  const run = useCallback(
    async (mode: RunMode) => {
      const forNote = noteRef.current;
      if (busyRef.current || !forNote) return;
      busyRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      const requestSegments = latest.current.segments;
      const requestSignature = namingSignature(requestSegments);
      lastAttemptRef.current = requestSignature;
      if (mode === 'auto') autoCountRef.current += 1;
      setPhase('running');
      setError(null);
      // Unmount, note change or deadline: the remaining steps must not touch the screen or the DB.
      const cancelled = () => controller.signal.aborted || noteRef.current !== forNote;
      const ask = (text: string) => setPending({ text, signature: requestSignature });

      const work = async (): Promise<void> => {
        const before = mode === 'manual' ? null : await readSavedEditState();
        if (cancelled()) return;
        const result = await latest.current.regenerate(requestSegments, controller.signal);
        if (cancelled()) return;
        if (mode === 'manual') {
          if (result.persisted !== true) await latest.current.saveSummary(result.summary, { onlyIfUnsaved: false });
          if (!cancelled()) show(result.summary, requestSignature);
          return;
        }
        if (result.persisted !== false) {
          // An older server ignored persist:false and already saved: show what it saved instead of
          // asking as if nothing changed, and stop automatic refresh for this note.
          olderServerRef.current = true;
          setServerSavedNotice(true);
          setAutoPaused(true);
          show(result.summary, requestSignature);
          return;
        }
        if (before?.edited || editedOnThisPage()) return ask(result.summary);
        // Re-check right before writing: an edit saved elsewhere during the request wins.
        const now = await readSavedEditState();
        if (cancelled()) return;
        if (now.edited || editedOnThisPage()) return ask(result.summary);
        const saved = await latest.current.saveSummary(result.summary, { onlyIfUnsaved: now.empty });
        if (cancelled()) return;
        if (!saved) return ask(result.summary);
        show(result.summary, requestSignature);
      };

      let timedOut = false;
      try {
        await withDeadline(work(), NAME_REFRESH_RUN_DEADLINE_MS, 'The summary update timed out. Please try again.');
      } catch (runError) {
        timedOut = runError instanceof DeadlineError;
        if (timedOut) controller.abort();
        if (noteRef.current !== forNote || (controller.signal.aborted && !timedOut)) return;
        console.error('Summary refresh with speaker names failed:', runError);
        setError(errorMessage(runError));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        const superseded = noteRef.current !== forNote || (controller.signal.aborted && !timedOut);
        if (!superseded) {
          busyRef.current = false;
          setPhase('idle');
          setRevision((value) => value + 1);
        }
      }
    },
    [editedOnThisPage, readSavedEditState, show]
  );

  // Schedule one debounced automatic refresh when the names differ from what the summary shows.
  useEffect(() => {
    if (!noteId || phase === 'running' || pending || olderServerRef.current) return;
    if (signature === null || signature === baselineRef.current || signature === lastAttemptRef.current) {
      setPhase('idle');
      return;
    }
    if (autoCountRef.current >= MAX_AUTO_NAME_REFRESHES_PER_NOTE) {
      setAutoPaused(true);
      setPhase('idle');
      return;
    }
    setPhase('scheduled');
    const timer = setTimeout(() => void run('auto'), NAME_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [noteId, signature, phase, pending, revision, run]);

  const acceptReplacement = useCallback(async () => {
    if (!pending) return;
    try {
      setError(null);
      await latest.current.saveSummary(pending.text, { onlyIfUnsaved: false });
      show(pending.text, pending.signature);
      setPending(null);
      setRevision((value) => value + 1);
    } catch (acceptError) {
      console.error('Replacing the summary failed:', acceptError);
      setError(errorMessage(acceptError));
    }
  }, [pending, show]);

  const dismissReplacement = useCallback(() => {
    if (!pending) return;
    baselineRef.current = pending.signature;
    setPending(null);
    setRevision((value) => value + 1);
  }, [pending]);

  const runManual = useCallback(() => {
    setPending(null);
    void run('manual');
  }, [run]);
  const retry = useCallback(() => void run('retry'), [run]);

  return {
    phase,
    error,
    pendingReplacement: pending?.text ?? null,
    autoPaused,
    serverSavedNotice,
    runManual,
    retry,
    acceptReplacement,
    dismissReplacement,
  };
}
