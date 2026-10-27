import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mounting characterization of the SummaryHistory page (T2-4). The notes and speakers repositories are
// mocked at the module boundary; heavy child components are replaced by stubs that expose the note id they
// were opened with. These tests must stay green, unchanged, across the T2-4 extractions.

type HistoryResult = { data: unknown[] | null; error: unknown; count: number | null };
type HistoryArgs = {
  userId: string;
  chatId?: string | null;
  ownership: string;
  calendarWindow?: { startIso: string; endIso: string } | null;
  sortKey: string;
  range?: { from: number; to: number } | null;
};

const h = vi.hoisted(() => ({
  auth: {
    user: { id: 'user-1', displayName: 'Me Myself', microsoftAccountName: 'Me', email: 'me@example.test' },
    isAuthenticated: true,
    isLoading: false,
    getAccessToken: async () => 'token',
  },
  language: { appLanguage: 'en', t: (key: string) => key },
  queryHistoryNotes: null as unknown as ReturnType<typeof vi.fn>,
  patchOwnedNoteReturningId: null as unknown as ReturnType<typeof vi.fn>,
  deleteOwnedNoteReturningId: null as unknown as ReturnType<typeof vi.fn>,
  saveNoteTranslations: null as unknown as ReturnType<typeof vi.fn>,
  selectSpeakersByNames: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../context/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => h.language }));
vi.mock('../config/msalConfig', () => ({ graphScopes: { calendar: [] } }));
vi.mock('../config/supabaseConfig', () => ({
  supabase: {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'in', 'update', 'contains']) q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  },
  getSupabaseAccessTokenForRequest: async () => null,
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_URL: 'https://example.test',
}));
vi.mock('../lib/notes/repository', async () => {
  h.queryHistoryNotes = vi.fn();
  h.patchOwnedNoteReturningId = vi.fn();
  h.deleteOwnedNoteReturningId = vi.fn();
  h.saveNoteTranslations = vi.fn();
  return {
    queryHistoryNotes: (...a: unknown[]) => h.queryHistoryNotes(...a),
    patchOwnedNoteReturningId: (...a: unknown[]) => h.patchOwnedNoteReturningId(...a),
    deleteOwnedNoteReturningId: (...a: unknown[]) => h.deleteOwnedNoteReturningId(...a),
    saveNoteTranslations: (...a: unknown[]) => h.saveNoteTranslations(...a),
  };
});
vi.mock('../lib/speakers/repository', () => {
  h.selectSpeakersByNames = vi.fn(async () => ({ data: [], error: null }));
  return {
    insertSpeaker: vi.fn(),
    selectSpeakersByNames: (...a: unknown[]) => h.selectSpeakersByNames(...a),
    updateSpeakerProfileReturningId: vi.fn(),
  };
});
vi.mock('../lib/noteImages', () => ({ getNoteImageCounts: async () => ({}) }));
vi.mock('../services/graphService', () => ({ getOutlookCalendarEvents: async () => [] }));
vi.mock('../services/meetingKnowledge', () => ({ meetingKnowledgeUiEnabled: true }));
vi.mock('../components/MeetingBriefing', () => ({ MeetingBriefing: () => null }));
vi.mock('../components/NoteImageAttachments', () => ({ default: () => null }));
vi.mock('../components/TranscriptDiarizedEditor', () => ({
  default: () => null,
  getTranscriptSpeakerFilters: () => [],
  TranscriptSpeakerFilterControls: () => null,
}));
vi.mock('../components/ShareNoteModal', () => ({
  default: (p: { isOpen: boolean; noteId: string | null }) => (p.isOpen ? <div data-testid="share-modal">{p.noteId}</div> : null),
}));
vi.mock('../components/MeetingKnowledgeModal', () => ({
  default: (p: { noteId: string }) => <div data-testid="knowledge-modal">{p.noteId}</div>,
}));
vi.mock('../components/AxkhIntegrationButton', () => ({
  default: (p: { onOpen: () => void }) => (
    <button type="button" onClick={p.onOpen}>
      axkh-open
    </button>
  ),
}));

import SummaryHistory from './SummaryHistory';

const OWN = {
  id: 'n1',
  name: 'Alpha note',
  user_id: 'user-1',
  user_name: 'Me',
  created_at: '2026-10-01T10:00:00Z',
  meeting_at: '2026-10-01T10:00:00Z',
  summary: 'Alpha summary',
};
const SHARED = {
  id: 'n2',
  name: 'Beta note',
  user_id: 'other',
  user_name: 'Bea',
  shared_users: ['user-1'],
  created_at: '2026-10-02T10:00:00Z',
  meeting_at: '2026-10-02T10:00:00Z',
  summary: 'Beta summary',
};

const ok = (notes: unknown[], count = notes.length): HistoryResult => ({ data: notes, error: null, count });
const lastArgs = (): HistoryArgs => h.queryHistoryNotes.mock.calls[h.queryHistoryNotes.mock.calls.length - 1][0] as HistoryArgs;
const allArgs = (): HistoryArgs[] => h.queryHistoryNotes.mock.calls.map((c) => c[0] as HistoryArgs);

function mount() {
  return render(
    <MemoryRouter initialEntries={['/history']}>
      <SummaryHistory />
    </MemoryRouter>
  );
}
async function mountLoaded() {
  mount();
  await screen.findAllByText('Alpha note');
}
const first = (text: string) => screen.getAllByText(text)[0];
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  h.queryHistoryNotes.mockReset();
  h.queryHistoryNotes.mockResolvedValue(ok([OWN, SHARED]));
  h.patchOwnedNoteReturningId.mockReset();
  h.deleteOwnedNoteReturningId.mockReset();
  h.selectSpeakersByNames.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SummaryHistory list loading', () => {
  it('queries the first page of all visible notes, newest meeting first, and shows them', async () => {
    await mountLoaded();
    expect(h.queryHistoryNotes).toHaveBeenCalledTimes(1);
    expect(lastArgs()).toEqual({
      userId: 'user-1',
      chatId: null,
      ownership: 'all',
      calendarWindow: null,
      sortKey: 'meeting_desc',
      range: { from: 0, to: 9 },
    });
    expect(screen.getAllByText('Beta note').length).toBeGreaterThan(0);
    expect(screen.getByText('Showing 1–2 of 2')).toBeInTheDocument();
  });

  it('shows the loading state until the query resolves', async () => {
    const d = deferred<HistoryResult>();
    h.queryHistoryNotes.mockReturnValue(d.promise);
    mount();
    expect(await screen.findByText('Loading notes...')).toBeInTheDocument();
    await act(async () => d.resolve(ok([OWN])));
    expect((await screen.findAllByText('Alpha note')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Loading notes...')).not.toBeInTheDocument();
  });

  it('shows the error message with a retry that reloads', async () => {
    h.queryHistoryNotes.mockResolvedValueOnce({ data: null, error: new Error('boom'), count: null });
    mount();
    expect(await screen.findByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findAllByText('Alpha note')).length).toBeGreaterThan(0);
    expect(h.queryHistoryNotes).toHaveBeenCalledTimes(2);
  });

  it('uses the generic message when the failure is not an Error', async () => {
    h.queryHistoryNotes.mockResolvedValueOnce({ data: null, error: { message: 'raw' }, count: null });
    mount();
    expect(await screen.findByText('Could not load your notes. Check your connection and try again.')).toBeInTheDocument();
  });

  it('shows the empty state when there are no notes', async () => {
    h.queryHistoryNotes.mockResolvedValue(ok([], 0));
    mount();
    expect(await screen.findByText('No meeting notes found for your account')).toBeInTheDocument();
  });
});

describe('SummaryHistory filters, sort, search and calendar', () => {
  it('passes the ownership filter to the query', async () => {
    await mountLoaded();
    fireEvent.change(screen.getByLabelText('owner'), { target: { value: 'mine' } });
    await waitFor(() => expect(lastArgs().ownership).toBe('mine'));
    fireEvent.change(screen.getByLabelText('owner'), { target: { value: 'shared' } });
    await waitFor(() => expect(lastArgs().ownership).toBe('shared'));
  });

  it('passes each sort key to the query', async () => {
    await mountLoaded();
    for (const key of ['meeting_asc', 'created_desc', 'created_asc', 'title_asc', 'title_desc']) {
      fireEvent.change(screen.getByLabelText('sort'), { target: { value: key } });
      await waitFor(() => expect(lastArgs().sortKey).toBe(key));
    }
  });

  it('search reads every row (no range) and filters client side with its own total', async () => {
    h.queryHistoryNotes.mockResolvedValue(ok([OWN, SHARED], 2));
    await mountLoaded();
    fireEvent.change(screen.getByPlaceholderText('searchNotes'), { target: { value: 'beta' } });
    await waitFor(() => expect(lastArgs().range).toBeNull());
    await waitFor(() => expect(screen.queryAllByText('Alpha note')).toHaveLength(0));
    expect(screen.getAllByText('Beta note').length).toBeGreaterThan(0);
    expect(screen.getByText('Showing 1–1 of 1')).toBeInTheDocument();
  });

  it('calendar view queries the visible month window with no range', async () => {
    await mountLoaded();
    fireEvent.click(screen.getByRole('tab', { name: 'calendar' }));
    await waitFor(() => expect(lastArgs().calendarWindow).not.toBeNull());
    const first = lastArgs();
    expect(first.range).toBeNull();
    const startIso = first.calendarWindow!.startIso;
    expect(new Date(first.calendarWindow!.endIso).getTime()).toBeGreaterThan(new Date(startIso).getTime());
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    await waitFor(() => expect(lastArgs().calendarWindow!.startIso).not.toBe(startIso));
    fireEvent.click(screen.getByRole('tab', { name: 'list' }));
    await waitFor(() => expect(lastArgs().calendarWindow).toBeNull());
    expect(lastArgs().range).toEqual({ from: 0, to: 9 });
  });
});

describe('SummaryHistory pagination', () => {
  beforeEach(() => {
    h.queryHistoryNotes.mockResolvedValue(ok([OWN, SHARED], 25));
  });

  it('shows page controls and requests the matching range', async () => {
    await mountLoaded();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(lastArgs().range).toEqual({ from: 10, to: 19 }));
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastArgs().range).toEqual({ from: 20, to: 29 }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(lastArgs().range).toEqual({ from: 10, to: 19 }));
  });

  // The scope change issues a page-1 query immediately (the effect resets the page it uses), then the page
  // state update re-runs the effect and issues a second page-1 query; the first response is discarded.
  it('resets to page 1 when the filter scope changes: two page-1 queries, never the new filter on page 2', async () => {
    await mountLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(lastArgs().range).toEqual({ from: 10, to: 19 }));
    await screen.findByText('Page 2 of 3');
    const before = allArgs().length;
    fireEvent.change(screen.getByLabelText('owner'), { target: { value: 'mine' } });
    await waitFor(() => expect(lastArgs().ownership).toBe('mine'));
    await screen.findByText('Page 1 of 3');
    const after = allArgs().slice(before);
    expect(after.some((a) => a.ownership === 'mine' && a.range?.from === 10)).toBe(false);
    expect(after.filter((a) => a.ownership === 'mine' && a.range?.from === 0)).toHaveLength(2);
    expect(after[after.length - 1].range).toEqual({ from: 0, to: 9 });
  });

  it('ignores a slow response from a superseded query', async () => {
    const slow = deferred<HistoryResult>();
    h.queryHistoryNotes.mockResolvedValueOnce(ok([OWN], 1));
    await mountLoaded();
    h.queryHistoryNotes.mockReturnValueOnce(slow.promise);
    fireEvent.change(screen.getByLabelText('owner'), { target: { value: 'mine' } });
    await waitFor(() => expect(lastArgs().ownership).toBe('mine'));
    h.queryHistoryNotes.mockResolvedValueOnce(ok([SHARED], 1));
    fireEvent.change(screen.getByLabelText('owner'), { target: { value: 'shared' } });
    await waitFor(() => expect(lastArgs().ownership).toBe('shared'));
    await screen.findAllByText('Beta note');
    await act(async () => slow.resolve(ok([OWN], 1)));
    expect(screen.queryAllByText('Alpha note')).toHaveLength(0);
    expect(screen.getAllByText('Beta note').length).toBeGreaterThan(0);
  });

  it('changing scope clears the expanded note', async () => {
    await mountLoaded();
    fireEvent.click(first('Alpha note'));
    expect((await screen.findAllByRole('region', { name: 'Note detail' })).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('owner'), { target: { value: 'mine' } });
    await waitFor(() => expect(screen.queryAllByRole('region', { name: 'Note detail' })).toHaveLength(0));
  });
});

async function openMenuAndPick(noteTitle: string, item: string) {
  fireEvent.click(screen.getAllByRole('button', { name: `Note actions for ${noteTitle}` })[0]);
  fireEvent.click(await screen.findByRole('button', { name: item }));
}

describe('SummaryHistory rename', () => {
  let focusSpy: ReturnType<typeof vi.spyOn> | null = null;
  // The row renders a mobile and a desktop input that both autoFocus; in a browser only the visible one
  // can take focus, so neutralise focus() to avoid a jsdom-only blur-save from the hidden copy.
  beforeEach(() => {
    focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
  });
  afterEach(() => {
    focusSpy?.mockRestore();
    focusSpy = null;
  });

  it('renames through the owner-scoped patch and shows the new title', async () => {
    h.patchOwnedNoteReturningId.mockResolvedValue({ id: 'n1' });
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'renameNote');
    const input = screen.getAllByDisplayValue('Alpha note')[0];
    fireEvent.change(input, { target: { value: 'Alpha renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getAllByText('Alpha renamed').length).toBeGreaterThan(0));
    expect(h.patchOwnedNoteReturningId).toHaveBeenCalledTimes(1);
    expect(h.patchOwnedNoteReturningId).toHaveBeenCalledWith({ noteId: 'n1', userId: 'user-1', patch: { name: 'Alpha renamed' } });
  });

  it('shows the permission error and keeps the old title when no row was changed', async () => {
    h.patchOwnedNoteReturningId.mockResolvedValue(null);
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'renameNote');
    const input = screen.getAllByDisplayValue('Alpha note')[0];
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Could not rename this note. You may not have permission to edit it.')).toBeInTheDocument();
    expect(screen.queryAllByText('Nope')).toHaveLength(0);
  });

  it('rejects an empty name without writing', async () => {
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'renameNote');
    const input = screen.getAllByDisplayValue('Alpha note')[0];
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Note name is required.')).toBeInTheDocument();
    expect(h.patchOwnedNoteReturningId).not.toHaveBeenCalled();
  });
});

describe('SummaryHistory summary edit', () => {
  async function startEdit() {
    await mountLoaded();
    fireEvent.click(first('Alpha note'));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Edit' }))[0]);
    const box = (await screen.findAllByDisplayValue('Alpha summary'))[0];
    fireEvent.change(box, { target: { value: 'Edited summary' } });
  }

  it('saves the edit owner-scoped and then shows it', async () => {
    h.patchOwnedNoteReturningId.mockResolvedValue({ id: 'n1' });
    await startEdit();
    fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[0]);
    await waitFor(() => expect(screen.queryAllByDisplayValue('Edited summary')).toHaveLength(0));
    expect(screen.getAllByText('Edited summary').length).toBeGreaterThan(0);
    expect(h.patchOwnedNoteReturningId).toHaveBeenCalledWith({ noteId: 'n1', userId: 'user-1', patch: { summary_edit: 'Edited summary' } });
  });

  it('keeps the editor open with the permission message when no row changed', async () => {
    h.patchOwnedNoteReturningId.mockResolvedValue(null);
    await startEdit();
    fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[0]);
    expect((await screen.findAllByText('Could not save your edit. You may not have permission to edit this note.')).length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue('Edited summary').length).toBeGreaterThan(0);
  });
});

describe('SummaryHistory delete', () => {
  it('deletes an owned note through the owner-scoped delete and removes the row', async () => {
    h.deleteOwnedNoteReturningId.mockResolvedValue({ id: 'n1' });
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'deleteNote');
    expect(await screen.findByText('deleteNote?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await waitFor(() => expect(screen.queryAllByText('Alpha note')).toHaveLength(0));
    expect(h.deleteOwnedNoteReturningId).toHaveBeenCalledWith({ noteId: 'n1', userId: 'user-1' });
    expect(screen.getAllByText('Beta note').length).toBeGreaterThan(0);
  });

  it('keeps the row and shows an error when nothing was deleted (not the owner)', async () => {
    h.deleteOwnedNoteReturningId.mockResolvedValue(null);
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'deleteNote');
    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));
    expect(await screen.findByText('Could not delete this note. Please refresh and try again.')).toBeInTheDocument();
    expect(screen.getAllByText('Alpha note').length).toBeGreaterThan(0);
  });

  it('a shared note offers Remove (share removal), not an owner delete', async () => {
    await mountLoaded();
    await openMenuAndPick('Beta note', 'deleteNote');
    expect(await screen.findByText('Remove shared note?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryAllByText('Beta note')).toHaveLength(0));
    expect(h.deleteOwnedNoteReturningId).not.toHaveBeenCalled();
  });
});

describe('SummaryHistory modals open with the right note', () => {
  it('opens the share modal for the selected note', async () => {
    await mountLoaded();
    fireEvent.click(first('Beta note'));
    fireEvent.click((await screen.findAllByRole('button', { name: 'share' }))[0]);
    expect(within(await screen.findByTestId('share-modal')).getByText('n2')).toBeInTheDocument();
  });

  it('opens the share modal from the row menu', async () => {
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'share');
    expect(await screen.findByTestId('share-modal')).toHaveTextContent('n1');
  });

  it('opens the AX-KH modal for an owned note only', async () => {
    await mountLoaded();
    fireEvent.click(first('Alpha note'));
    fireEvent.click((await screen.findAllByRole('button', { name: 'axkh-open' }))[0]);
    expect(await screen.findByTestId('knowledge-modal')).toHaveTextContent('n1');
    cleanup();
    h.queryHistoryNotes.mockResolvedValue(ok([SHARED]));
    mount();
    fireEvent.click((await screen.findAllByText('Beta note'))[0]);
    await screen.findAllByRole('region', { name: 'Note detail' });
    expect(screen.queryByRole('button', { name: 'axkh-open' })).not.toBeInTheDocument();
  });

  it('opens the profile modal and reports a note without a diarized transcript', async () => {
    await mountLoaded();
    fireEvent.click(first('Alpha note'));
    fireEvent.click((await screen.findAllByRole('button', { name: 'syncProfile' }))[0]);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText('No diarized transcription found for this note.')).toBeInTheDocument();
    expect(h.selectSpeakersByNames).not.toHaveBeenCalled();
  });
});
