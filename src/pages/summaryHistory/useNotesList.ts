import { useEffect, useRef, useState } from 'react';
import { queryHistoryNotes, type NoteOwnershipFilter, type NoteSortKey } from '../../lib/notes/repository';
import { noteMatchesSearch } from './noteSearch';
import type { Note } from './types';

export const NOTES_PAGE_SIZE = 10;

export type HistoryViewMode = 'list' | 'calendar';

export interface UseNotesListOptions {
  /** Signed-in user id; without it the list is empty and nothing is queried. */
  userId: string | undefined;
  chatId: string | null;
  viewMode: HistoryViewMode;
  /** Visible calendar window (only used in calendar view). Must be referentially stable per month. */
  calendarWindow: { start: Date; endExclusive: Date };
  /** Trimmed search text; non-empty switches to read-all plus client-side filtering. */
  searchQuery: string;
  /** Strings that identify the current user, so searching your own name does not match every note you wrote. Must be memoized. */
  currentUserSearchValues: string[];
  ownership: NoteOwnershipFilter;
  sortKey: NoteSortKey;
  /** Called when the filter scope changes and the page snaps back to 1 (the page clears its expanded note). */
  onScopeReset?: () => void;
}

/**
 * History list loading: runs the notes query for the current scope, keeps page, total, loading and
 * error state, and resets to page 1 (cancelling any stale response) when the scope changes.
 */
export function useNotesList(options: UseNotesListOptions) {
  const {
    userId,
    chatId,
    viewMode,
    calendarWindow,
    searchQuery,
    currentUserSearchValues,
    ownership,
    sortKey,
  } = options;
  const onScopeResetRef = useRef(options.onScopeReset);
  onScopeResetRef.current = options.onScopeReset;

  const [notes, setNotes] = useState<Note[]>([]);
  const [notesTotalCount, setNotesTotalCount] = useState(0);
  const [notesPage, setNotesPage] = useState(1);
  const [notesLoading, setNotesLoading] = useState(true);
  // Distinguishes "the fetch failed" from "there are legitimately no notes":
  // without this, a failed load renders the empty state and reads as data loss.
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesReloadNonce, setNotesReloadNonce] = useState(0);

  const notesScopeKey = `${chatId ?? ''}|${userId ?? ''}|${viewMode}|${searchQuery}|${ownership}|${sortKey}`;
  const prevNotesScopeRef = useRef(notesScopeKey);

  useEffect(() => {
    let cancelled = false;

    const loadNotes = async () => {
      try {
        setNotesLoading(true);
        setNotesError(null);

        let effectivePage = notesPage;
        if (prevNotesScopeRef.current !== notesScopeKey) {
          prevNotesScopeRef.current = notesScopeKey;
          effectivePage = 1;
          setNotesPage(1);
          onScopeResetRef.current?.();
        }

        if (!userId) {
          if (!cancelled) {
            setNotes([]);
            setNotesTotalCount(0);
          }
          return;
        }

        const from = (effectivePage - 1) * NOTES_PAGE_SIZE;
        const to = from + NOTES_PAGE_SIZE - 1;
        const shouldFilterBySearch = Boolean(searchQuery);

        const { data, error, count } = await queryHistoryNotes({
          userId,
          chatId,
          ownership,
          calendarWindow:
            viewMode === 'calendar'
              ? {
                  startIso: calendarWindow.start.toISOString(),
                  endIso: calendarWindow.endExclusive.toISOString(),
                }
              : null,
          sortKey,
          range: viewMode === 'calendar' || shouldFilterBySearch ? null : { from, to },
        });

        if (cancelled) return;
        if (error) throw error;
        const loadedNotes = (data as Note[]) || [];
        const filteredNotes = shouldFilterBySearch
          ? loadedNotes.filter((note) => noteMatchesSearch(note, searchQuery, currentUserSearchValues))
          : loadedNotes;
        setNotes(
          viewMode === 'calendar'
            ? filteredNotes
            : shouldFilterBySearch
              ? filteredNotes.slice(from, to + 1)
              : filteredNotes
        );
        setNotesTotalCount(shouldFilterBySearch ? filteredNotes.length : typeof count === 'number' ? count : 0);
      } catch (error) {
        console.error('Error fetching notes:', error);
        if (!cancelled) {
          setNotes([]);
          setNotesTotalCount(0);
          setNotesError(
            error instanceof Error
              ? error.message
              : 'Could not load your notes. Check your connection and try again.'
          );
        }
      } finally {
        if (!cancelled) setNotesLoading(false);
      }
    };

    void loadNotes();
    return () => {
      cancelled = true;
    };
  }, [
    notesScopeKey,
    notesPage,
    chatId,
    userId,
    viewMode,
    calendarWindow.start,
    calendarWindow.endExclusive,
    currentUserSearchValues,
    searchQuery,
    ownership,
    sortKey,
    notesReloadNonce,
  ]);

  return {
    notes,
    setNotes,
    notesTotalCount,
    setNotesTotalCount,
    notesPage,
    setNotesPage,
    notesLoading,
    notesError,
    reloadNotes: () => setNotesReloadNonce((n) => n + 1),
  };
}
