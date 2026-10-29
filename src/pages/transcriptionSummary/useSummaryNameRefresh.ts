import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeadlineError, withDeadline } from '../../lib/deadline';
import { namingSignature } from '../../lib/speakers/mainSpeakers';
import type { RegenerateSummaryResult } from '../../lib/regenerateSummary';
import type { TranscriptSegment } from '../../lib/transcriptSegments';

/** Wait after the last naming change before regenerating (DEC-0024). */
export const NAME_REFRESH_DEBOUNCE_MS = 4000;
/** Automatic refreshes per note per page session; the manual button is not counted. */
export const MAX_AUTO_NAME_REFRESHES_PER_NOTE = 3;
/** Foreground run bound; an already-started write retains its barrier until it settles. */
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
  /** A refresh reached the DB while an editor was open; retain its draft and report the conflict. */
  onSavedWhileEditing?: (text: string) => void;
}

type RunMode = 'auto' | 'retry' | 'manual' | 'replace';
export type NameRefreshPhase = 'idle' | 'scheduled' | 'running';

export interface SummaryNameRefresh {
  phase: NameRefreshPhase;
  /** Includes an uncancellable write that outlived the run deadline. */
  isBusy: () => boolean;
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
  const pendingWrites = useRef(new Map<string, Promise<boolean>>());
  const alive = useRef(true);
  const noteEpoch = useRef(0);
  const isBusy = useCallback(() => busyRef.current || Boolean(noteRef.current && pendingWrites.current.has(noteRef.current)), []);

  const signature = useMemo(() => namingSignature(segments), [segments]);

  // Reset per note: the summary on screen reflects the names it was generated with.
  if (noteRef.current !== noteId) {
    noteRef.current = noteId;
    noteEpoch.current += 1;
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

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; abortRef.current?.abort(); };
  }, []);

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
    // Keep the draft, but let Done distinguish it from the newer persisted summary.
    if (latest.current.isEditing) latest.current.onSavedWhileEditing?.(text);
    else latest.current.onApply(text);
  }, []);

  const run = useCallback(
    async (mode: RunMode, replacement?: { text: string; signature: string | null }) => {
      const forNote = noteRef.current;
      if (!forNote) return;
      if (pendingWrites.current.has(forNote)) {
        setError('The previous summary save is still pending. Please wait before trying again.');
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      const requestSegments = latest.current.segments;
      const requestSignature = replacement ? replacement.signature : namingSignature(requestSegments);
      lastAttemptRef.current = requestSignature;
      if (mode === 'auto') autoCountRef.current += 1;
      setPhase('running');
      setError(null);
      if (mode === 'manual') setPending(null);
      const epoch = noteEpoch.current;
      let timedOut = false;
      const sameNote = () => alive.current && noteRef.current === forNote && noteEpoch.current === epoch;
      // Cancellation blocks subsequent steps; an already-started write is tracked and reconciled.
      const cancelled = () => controller.signal.aborted || noteRef.current !== forNote;
      const ask = (text: string) => setPending({ text, signature: requestSignature });

      const save = (text: string, onlyIfUnsaved: boolean): Promise<boolean> => {
        const callbacks = latest.current;
        const tracked: Promise<boolean> = (async () => {
          // Publish the barrier before a callback can synchronously throw.
          await Promise.resolve();
          try {
            const saved = await callbacks.saveSummary(text, { onlyIfUnsaved });
            // Aborting a browser request cannot undo a DB commit already in progress.
            // Keep the barrier through an authoritative read and reconcile only our saved text.
            if (timedOut && saved && sameNote()) {
              const actual = await withDeadline(callbacks.readSavedEdit(), 15_000,
                'Could not verify the delayed summary save. Please reload the note.');
              if (sameNote()) {
                if (actual !== null && normalize(actual) === normalize(text)) show(actual, requestSignature);
                else setError('The saved summary changed. Please reload the note before replacing it.');
              }
            }
            return saved;
          } catch (saveError) {
            if (timedOut && sameNote()) setError(errorMessage(saveError));
            throw saveError;
          } finally {
            if (pendingWrites.current.get(forNote) === tracked) pendingWrites.current.delete(forNote);
            if (alive.current && noteRef.current === forNote) setRevision((value) => value + 1);
          }
        })();
        pendingWrites.current.set(forNote, tracked);
        return tracked;
      };

      const work = async (): Promise<void> => {
        if (mode === 'replace' && replacement) {
          const saved = await save(replacement.text, false);
          if (!cancelled() && saved) {
            show(replacement.text, replacement.signature);
            setPending(null);
          }
          return;
        }
        const before = mode === 'manual' ? null : await readSavedEditState();
        if (cancelled()) return;
        const result = await latest.current.regenerate(requestSegments, controller.signal);
        if (cancelled()) return;
        if (mode === 'manual') {
          if (result.persisted !== true) await save(result.summary, false);
          if (!cancelled()) show(result.summary, requestSignature);
          return;
        }
        if (before?.edited || editedOnThisPage()) {
          if (result.persisted !== false) {
            olderServerRef.current = true;
            setServerSavedNotice(true);
            setAutoPaused(true);
          }
          return ask(result.summary);
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
        // Re-check right before writing: an edit saved elsewhere during the request wins.
        const now = await readSavedEditState();
        if (cancelled()) return;
        if (now.edited || editedOnThisPage()) return ask(result.summary);
        const saved = await save(result.summary, now.empty);
        if (cancelled()) return;
        if (!saved) return ask(result.summary);
        show(result.summary, requestSignature);
      };

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
    if (!noteId || phase === 'running' || pending || olderServerRef.current || pendingWrites.current.has(noteId)) return;
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
    if (pending) await run('replace', pending);
  }, [pending, run]);

  const dismissReplacement = useCallback(() => {
    if (!pending) return;
    baselineRef.current = pending.signature;
    setPending(null);
    setRevision((value) => value + 1);
  }, [pending]);

  const runManual = useCallback(() => { void run('manual'); }, [run]);
  const retry = useCallback(() => void run('retry'), [run]);

  return {
    phase,
    isBusy,
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
