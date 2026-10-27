import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: null as unknown as ReturnType<typeof vi.fn> }));
vi.mock('../../lib/notes/repository', () => {
  h.query = vi.fn();
  return { queryHistoryNotes: (...a: unknown[]) => h.query(...a) };
});

import { NOTES_PAGE_SIZE, useNotesList, type UseNotesListOptions } from './useNotesList';

type Result = { data: unknown[] | null; error: unknown; count: number | null };
const A = { id: 'a', name: 'Alpha', user_id: 'u1', user_name: 'Me', summary: 'alpha text' };
const B = { id: 'b', name: 'Beta', user_id: 'u2', user_name: 'Bea', summary: 'beta text' };
const ok = (notes: unknown[], count = notes.length): Result => ({ data: notes, error: null, count });

const WINDOW = { start: new Date('2026-10-01T00:00:00Z'), endExclusive: new Date('2026-11-01T00:00:00Z') };
const NO_VALUES: string[] = [];
const base = (): UseNotesListOptions => ({
  userId: 'u1',
  chatId: null,
  viewMode: 'list',
  calendarWindow: WINDOW,
  searchQuery: '',
  currentUserSearchValues: NO_VALUES,
  ownership: 'all',
  sortKey: 'meeting_desc',
});
const lastArgs = () => h.query.mock.calls[h.query.mock.calls.length - 1][0];
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  h.query.mockReset();
  h.query.mockResolvedValue(ok([A, B], 25));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useNotesList loading and error', () => {
  it('starts loading, then exposes notes and the exact total', async () => {
    const { result } = renderHook(() => useNotesList(base()));
    expect(result.current.notesLoading).toBe(true);
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    expect(result.current.notes).toEqual([A, B]);
    expect(result.current.notesTotalCount).toBe(25);
    expect(result.current.notesError).toBeNull();
    expect(lastArgs()).toEqual({
      userId: 'u1',
      chatId: null,
      ownership: 'all',
      calendarWindow: null,
      sortKey: 'meeting_desc',
      range: { from: 0, to: NOTES_PAGE_SIZE - 1 },
    });
  });

  it('reports an Error message, empties the list, and reload retries', async () => {
    h.query.mockResolvedValueOnce({ data: null, error: new Error('boom'), count: null });
    const { result } = renderHook(() => useNotesList(base()));
    await waitFor(() => expect(result.current.notesError).toBe('boom'));
    expect(result.current.notes).toEqual([]);
    expect(result.current.notesTotalCount).toBe(0);
    expect(result.current.notesLoading).toBe(false);
    act(() => result.current.reloadNotes());
    await waitFor(() => expect(result.current.notes).toEqual([A, B]));
    expect(result.current.notesError).toBeNull();
    expect(h.query).toHaveBeenCalledTimes(2);
  });

  it('uses the generic message for a non-Error failure and for a rejected query', async () => {
    h.query.mockResolvedValueOnce({ data: null, error: { message: 'raw' }, count: null });
    const first = renderHook(() => useNotesList(base()));
    await waitFor(() => expect(first.result.current.notesError).toBe('Could not load your notes. Check your connection and try again.'));
    h.query.mockRejectedValueOnce(new Error('network'));
    const second = renderHook(() => useNotesList(base()));
    await waitFor(() => expect(second.result.current.notesError).toBe('network'));
  });

  it('treats a missing count as zero', async () => {
    h.query.mockResolvedValue({ data: [A], error: null, count: null });
    const { result } = renderHook(() => useNotesList(base()));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    expect(result.current.notesTotalCount).toBe(0);
  });

  it('without a user it empties the list and does not query', async () => {
    const { result } = renderHook(() => useNotesList({ ...base(), userId: undefined }));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    expect(result.current.notes).toEqual([]);
    expect(result.current.notesTotalCount).toBe(0);
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('useNotesList unmount and supersede', () => {
  it('ignores a response that arrives after unmount', async () => {
    const d = deferred<Result>();
    h.query.mockReturnValue(d.promise);
    const { result, unmount } = renderHook(() => useNotesList(base()));
    expect(result.current.notesLoading).toBe(true);
    unmount();
    await act(async () => d.resolve(ok([A])));
    expect(result.current.notes).toEqual([]);
    expect(result.current.notesLoading).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('ignores a failure that arrives after unmount', async () => {
    const d = deferred<Result>();
    h.query.mockReturnValue(d.promise);
    const { result, unmount } = renderHook(() => useNotesList(base()));
    unmount();
    await act(async () => d.resolve({ data: null, error: new Error('late'), count: null }));
    expect(result.current.notesError).toBeNull();
  });

  it('ignores a stale response when the scope changed before it arrived', async () => {
    const stale = deferred<Result>();
    h.query.mockReturnValueOnce(stale.promise);
    h.query.mockResolvedValueOnce(ok([B], 1));
    const { result, rerender } = renderHook((o: UseNotesListOptions) => useNotesList(o), { initialProps: base() });
    rerender({ ...base(), ownership: 'shared' });
    await waitFor(() => expect(result.current.notes).toEqual([B]));
    await act(async () => stale.resolve(ok([A], 1)));
    expect(result.current.notes).toEqual([B]);
    expect(result.current.notesTotalCount).toBe(1);
  });
});

describe('useNotesList scope, paging and modes', () => {
  it('pages by range and snaps back to page 1 once, calling onScopeReset, when the scope changes', async () => {
    const onScopeReset = vi.fn();
    const { result, rerender } = renderHook((o: UseNotesListOptions) => useNotesList(o), {
      initialProps: { ...base(), onScopeReset },
    });
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    act(() => result.current.setNotesPage(2));
    await waitFor(() => expect(lastArgs().range).toEqual({ from: 10, to: 19 }));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    expect(onScopeReset).not.toHaveBeenCalled();

    const before = h.query.mock.calls.length;
    rerender({ ...base(), ownership: 'mine', onScopeReset });
    await waitFor(() => expect(result.current.notesPage).toBe(1));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    const after = h.query.mock.calls.slice(before).map((c) => c[0]);
    expect(after.some((a) => a.ownership === 'mine' && a.range?.from === 10)).toBe(false);
    expect(after[after.length - 1]).toMatchObject({ ownership: 'mine', range: { from: 0, to: 9 } });
    expect(onScopeReset).toHaveBeenCalledTimes(1);
  });

  it('search reads all rows, filters client side, slices the page and uses the filtered total', async () => {
    h.query.mockResolvedValue(ok([A, B], 2));
    const { result } = renderHook(() => useNotesList({ ...base(), searchQuery: 'beta' }));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    expect(lastArgs().range).toBeNull();
    expect(result.current.notes).toEqual([B]);
    expect(result.current.notesTotalCount).toBe(1);
  });

  it('search does not match the current user when the query looks like their own name', async () => {
    h.query.mockResolvedValue(ok([{ ...A, user_name: 'Me Myself' }, B], 2));
    const values = ['Me Myself'];
    const { result } = renderHook(() => useNotesList({ ...base(), searchQuery: 'me myself', currentUserSearchValues: values }));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    expect(result.current.notes).toEqual([]);
  });

  it('calendar view sends the window ISO bounds, no range, and keeps every row', async () => {
    h.query.mockResolvedValue(ok([A, B], 2));
    const { result } = renderHook(() => useNotesList({ ...base(), viewMode: 'calendar' }));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    expect(lastArgs().calendarWindow).toEqual({ startIso: WINDOW.start.toISOString(), endIso: WINDOW.endExclusive.toISOString() });
    expect(lastArgs().range).toBeNull();
    expect(result.current.notes).toEqual([A, B]);
  });

  it('setNotes and setNotesTotalCount let the page apply local edits', async () => {
    const { result } = renderHook(() => useNotesList(base()));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    act(() => {
      result.current.setNotes((prev) => prev.filter((n) => n.id !== 'a'));
      result.current.setNotesTotalCount(24);
    });
    expect(result.current.notes).toEqual([B]);
    expect(result.current.notesTotalCount).toBe(24);
  });
});

describe('useNotesList local mutations during an in-flight fetch', () => {
  it('does not let a stale list response overwrite a local delete: it refetches instead', async () => {
    const stale = deferred<Result>();
    h.query.mockReturnValueOnce(stale.promise);
    h.query.mockResolvedValueOnce(ok([B], 1));
    const { result } = renderHook(() => useNotesList(base()));
    expect(result.current.notesLoading).toBe(true);
    // A local mutation lands (for example a delete confirmed while the list was reloading) ...
    act(() => {
      result.current.setNotes([B] as never);
      result.current.setNotesTotalCount(1);
    });
    // ... and then the older response, which still contains the deleted note, arrives.
    await act(async () => stale.resolve(ok([A, B], 2)));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(result.current.notes).toEqual([B]);
    expect(result.current.notesTotalCount).toBe(1);
  });

  it('keeps showing loading, not the stale list, until the refetch lands', async () => {
    const stale = deferred<Result>();
    const fresh = deferred<Result>();
    h.query.mockReturnValueOnce(stale.promise);
    h.query.mockReturnValueOnce(fresh.promise);
    const { result } = renderHook(() => useNotesList(base()));
    act(() => result.current.setNotes([B] as never));
    await act(async () => stale.resolve(ok([A, B], 2)));
    expect(result.current.notesLoading).toBe(true);
    expect(result.current.notes).not.toEqual([A, B]);
    await act(async () => fresh.resolve(ok([B], 1)));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    expect(result.current.notes).toEqual([B]);
  });

  it('a local mutation with no fetch in flight does not trigger a refetch', async () => {
    const { result } = renderHook(() => useNotesList(base()));
    await waitFor(() => expect(result.current.notesLoading).toBe(false));
    const calls = h.query.mock.calls.length;
    act(() => result.current.setNotes((prev) => prev.filter((n) => n.id !== 'a')));
    expect(h.query.mock.calls.length).toBe(calls);
    expect(result.current.notes).toEqual([B]);
  });
});
