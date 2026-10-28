import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { anonymousLabelsInTranscript, type SpeakerSuggestion } from '../identifySpeakers';
import type { TranscriptSegment } from '../transcriptSegments';

// U9 (DEC-0024): speaker-name suggestions shared by every transcript editor of the same note and
// transcript revision, so a tab switch or a second panel reads the cache instead of calling the
// model again. Suggestions are only ever shown; applying one stays a user action.

/** Upper bound for one identify-speakers call. */
export const SUGGESTION_TIMEOUT_MS = 60_000;
const MAX_ENTRIES = 50;

export type SuggestionFetcher = (signal: AbortSignal) => Promise<SpeakerSuggestion[]>;

type Entry =
  | { status: 'loading' }
  | { status: 'ready'; suggestions: SpeakerSuggestion[] }
  | { status: 'error'; message: string };

const entries = new Map<string, Entry>();
const autoRequestedNotes = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setEntry(key: string, entry: Entry): void {
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  notify();
}

/** Test-only: forget every cached suggestion and auto-run mark. */
export function resetSuggestionStoreForTests(): void {
  entries.clear();
  autoRequestedNotes.clear();
  notify();
}

/**
 * Revision of a transcript for suggestion purposes: FNV-1a over each segment's stored speakerKey
 * and original text. Renaming a speaker changes neither, so applying one suggestion keeps the
 * others; editing the text or the diarization keys starts a new revision.
 */
export function transcriptRevision(segments: readonly TranscriptSegment[]): string {
  let hash = 0x811c9dc5;
  const mix = (value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const segment of segments) {
    mix(segment.speakerKey ?? '');
    mix('\u0001');
    mix(segment.text);
    mix('\u0002');
  }
  return `${segments.length}:${hash.toString(16)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Speaker suggestion failed';
}

async function loadEntry(key: string, fetcher: SuggestionFetcher, force: boolean): Promise<void> {
  const existing = entries.get(key);
  if (existing?.status === 'loading') return;
  if (existing?.status === 'ready' && !force) return;
  setEntry(key, { status: 'loading' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUGGESTION_TIMEOUT_MS);
  try {
    const suggestions = await fetcher(controller.signal);
    setEntry(key, { status: 'ready', suggestions });
  } catch (error) {
    const message = controller.signal.aborted ? 'Speaker suggestion timed out. Please try again.' : errorMessage(error);
    console.error('Speaker suggestion failed:', error);
    setEntry(key, { status: 'error', message });
  } finally {
    clearTimeout(timer);
  }
}

export interface SpeakerSuggestionsState {
  /** Suggestions for labels that are still anonymous now; null before any result. */
  suggestions: SpeakerSuggestion[] | null;
  /** Every suggestion of this revision, including labels the user has since named (feedback log). */
  allSuggestions: SpeakerSuggestion[] | null;
  suggesting: boolean;
  error: string | null;
  requestSuggestions: (options?: { force?: boolean }) => Promise<void>;
}

/**
 * Suggestions for one note and transcript revision. With `autoSuggest`, the first editor that
 * shows a note with anonymous labels requests them once per page session (DEC-0024).
 */
export function useSpeakerSuggestions(input: {
  noteId: string | null;
  segments: TranscriptSegment[];
  autoSuggest: boolean;
  fetcher: SuggestionFetcher;
}): SpeakerSuggestionsState {
  const { noteId, segments, autoSuggest, fetcher } = input;
  const key = useMemo(() => `${noteId ?? 'no-note'}::${transcriptRevision(segments)}`, [noteId, segments]);
  const anonymous = useMemo(() => anonymousLabelsInTranscript(segments), [segments]);
  const entry = useSyncExternalStore(subscribe, () => entries.get(key));

  const requestSuggestions = useCallback(
    (options?: { force?: boolean }) => loadEntry(key, fetcher, Boolean(options?.force)),
    [key, fetcher]
  );

  const shouldAuto = autoSuggest && Boolean(noteId) && anonymous.length > 0 && entry === undefined;
  useEffect(() => {
    if (!shouldAuto || !noteId || autoRequestedNotes.has(noteId)) return;
    autoRequestedNotes.add(noteId);
    void loadEntry(key, fetcher, false);
  }, [shouldAuto, noteId, key, fetcher]);

  const allSuggestions = entry?.status === 'ready' ? entry.suggestions : null;
  const suggestions = useMemo(
    () => (allSuggestions ? allSuggestions.filter((s) => anonymous.includes(s.label)) : null),
    [allSuggestions, anonymous]
  );
  return {
    suggestions,
    allSuggestions,
    suggesting: entry?.status === 'loading',
    error: entry?.status === 'error' ? entry.message : null,
    requestSuggestions,
  };
}
