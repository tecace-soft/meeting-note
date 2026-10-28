import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { namingSignature } from '../../lib/speakers/mainSpeakers';
import type { RegenerateSummaryResult } from '../../lib/regenerateSummary';
import type { TranscriptSegment } from '../../lib/transcriptSegments';

/** Wait after the last naming change before regenerating (DEC-0024). */
export const NAME_REFRESH_DEBOUNCE_MS = 4000;
/** Automatic refreshes per note per page session; the manual button is not counted. */
export const MAX_AUTO_NAME_REFRESHES_PER_NOTE = 3;

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
  /** Regenerate with these segments; must not save on the server (persist:false). */
  regenerate: (segments: TranscriptSegment[], signal: AbortSignal) => Promise<RegenerateSummaryResult>;
  /** Owner-scoped read of the saved summary_edit. */
  readSavedEdit: () => Promise<string | null>;
  /** Owner-scoped save of summary_edit; throws when nothing was saved. */
  saveSummary: (text: string) => Promise<void>;
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
  /** True when the automatic refresh hit its per-note cap. */
  autoPaused: boolean;
  /** "Update summary with names": regenerate now and replace (the user asked for it). */
  runManual: () => void;
  /** Retry after a failure, with the same hand-edit protection as the automatic refresh. */
  retry: () => void;
  acceptReplacement: () => Promise<void>;
  dismissReplacement: () => void;
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
  // Bumped whenever the refs below change so the scheduling effect re-evaluates.
  const [revision, setRevision] = useState(0);

  const noteRef = useRef<string | null>(null);
  const baselineRef = useRef<string | null>(null);
  const lastAttemptRef = useRef<string | null>(null);
  const autoCountRef = useRef(0);
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
  }, [noteId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const isGenerated = useCallback((text: string) => generatedRef.current.has(normalize(text)), []);

  const hasHandEdit = useCallback(async (): Promise<boolean> => {
    try {
      const saved = await latest.current.readSavedEdit();
      return saved !== null && normalize(saved) !== '' && !isGenerated(saved);
    } catch (readError) {
      console.warn('Could not read the saved summary; treating it as edited so it is not replaced:', readError);
      return true;
    }
  }, [isGenerated]);

  const editedOnThisPage = useCallback(
    () => latest.current.isEditing || !isGenerated(latest.current.currentSummary),
    [isGenerated]
  );

  const apply = useCallback(
    async (text: string, appliedSignature: string | null, alreadySaved: boolean) => {
      if (!alreadySaved) await latest.current.saveSummary(text);
      generatedRef.current.add(normalize(text));
      baselineRef.current = appliedSignature;
      latest.current.onApply(text);
    },
    []
  );

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
      const stale = () => controller.signal.aborted || noteRef.current !== forNote;
      try {
        const editedBefore = mode === 'manual' ? false : await hasHandEdit();
        if (stale()) return;
        const result = await latest.current.regenerate(requestSegments, controller.signal);
        if (stale()) return;
        if (mode !== 'manual' && (editedBefore || editedOnThisPage())) {
          setPending({ text: result.summary, signature: requestSignature });
          return;
        }
        await apply(result.summary, requestSignature, result.persisted === true);
      } catch (runError) {
        if (stale()) return;
        console.error('Summary refresh with speaker names failed:', runError);
        setError(errorMessage(runError));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (!stale()) {
          busyRef.current = false;
          setPhase('idle');
          setRevision((value) => value + 1);
        }
      }
    },
    [apply, editedOnThisPage, hasHandEdit]
  );

  // Schedule one debounced automatic refresh when the names differ from what the summary shows.
  useEffect(() => {
    if (!noteId || phase === 'running' || pending) return;
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
      await apply(pending.text, pending.signature, false);
      setPending(null);
      setRevision((value) => value + 1);
    } catch (acceptError) {
      console.error('Replacing the summary failed:', acceptError);
      setError(errorMessage(acceptError));
    }
  }, [apply, pending]);

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

  return { phase, error, pendingReplacement: pending?.text ?? null, autoPaused, runManual, retry, acceptReplacement, dismissReplacement };
}
