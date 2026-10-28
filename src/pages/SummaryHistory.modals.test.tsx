import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mounting characterization of the SummaryHistory dialogs (T2-4 modals unit): delete confirm, add to
// project, share, AX-KH. Own harness on purpose: the older mounting test files are left untouched.

const h = vi.hoisted(() => ({
  auth: {
    user: { id: 'user-1', displayName: 'Me Myself', microsoftAccountName: 'Me', email: 'me@example.test' },
    isAuthenticated: true,
    isLoading: false,
    getAccessToken: async (): Promise<string | null> => 'ms-token',
  },
  language: { appLanguage: 'en', t: (key: string) => key },
  queryHistoryNotes: null as unknown as ReturnType<typeof vi.fn>,
  deleteOwned: null as unknown as ReturnType<typeof vi.fn>,
  projects: { data: [] as unknown[], error: null as { message: string } | null },
  projectQueries: [] as unknown[][],
  rpc: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../context/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => h.language }));
vi.mock('../config/msalConfig', () => ({ graphScopes: { calendar: [] } }));
vi.mock('../config/supabaseConfig', () => ({
  supabase: {
    from: (table: string) => {
      const calls: unknown[] = [table];
      h.projectQueries.push(calls);
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'in', 'update', 'contains']) {
        q[m] = (...a: unknown[]) => {
          calls.push([m, ...a]);
          return q;
        };
      }
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve(h.projects).then(ok);
      return q;
    },
    rpc: (...a: unknown[]) => h.rpc(...a),
  },
  getSupabaseAccessTokenForRequest: async () => null,
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_URL: 'https://example.test',
}));
vi.mock('../lib/notes/repository', () => {
  h.queryHistoryNotes = vi.fn();
  h.deleteOwned = vi.fn();
  h.rpc = vi.fn();
  return {
    queryHistoryNotes: (...a: unknown[]) => h.queryHistoryNotes(...a),
    patchOwnedNoteReturningId: vi.fn(),
    deleteOwnedNoteReturningId: (...a: unknown[]) => h.deleteOwned(...a),
    saveNoteTranslations: vi.fn(),
    patchNoteReturningId: vi.fn(),
  };
});
vi.mock('../lib/speakers/repository', () => ({
  selectSpeakersByNames: vi.fn(async () => ({ data: [], error: null })),
  updateSpeakerProfileReturningId: vi.fn(),
  insertSpeaker: vi.fn(),
}));
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
  default: (p: {
    isOpen: boolean;
    noteId: string | null;
    noteTitle?: string | null;
    existingSharedUserIds?: string[];
    onClose: () => void;
    onShared?: (id: string, ids: string[]) => void;
  }) =>
    p.isOpen ? (
      <div data-testid="share-modal">
        <span data-testid="share-id">{p.noteId}</span>
        <span data-testid="share-title">{p.noteTitle}</span>
        <span data-testid="share-existing">{(p.existingSharedUserIds ?? []).join(',')}</span>
        <button type="button" onClick={() => p.onShared?.(p.noteId as string, ['x', 'y'])}>
          share-confirm
        </button>
        <button type="button" onClick={p.onClose}>
          share-close
        </button>
      </div>
    ) : null,
}));
vi.mock('../components/MeetingKnowledgeModal', () => ({
  default: (p: { noteId: string; noteTitle?: string | null; onClose: () => void }) => (
    <div data-testid="knowledge-modal">
      <span data-testid="knowledge-id">{p.noteId}</span>
      <span data-testid="knowledge-title">{p.noteTitle}</span>
      <button type="button" onClick={p.onClose}>
        knowledge-close
      </button>
    </div>
  ),
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
  projects: ['p1'],
  shared_users: ['z'],
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
const PROJECTS = [
  { id: 'p1', name: 'Project One', notes: ['n1'] },
  { id: 'p2', name: 'Project Two', notes: ['n9'] },
];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
async function mountLoaded() {
  render(
    <MemoryRouter initialEntries={['/history']}>
      <SummaryHistory />
    </MemoryRouter>
  );
  await screen.findAllByText('Alpha note');
}
async function openMenuAndPick(noteTitle: string, item: string | RegExp) {
  fireEvent.click(screen.getAllByRole('button', { name: `Note actions for ${noteTitle}` })[0]);
  fireEvent.click(await screen.findByRole('button', { name: item }));
}
const rpcCalls = () => h.rpc.mock.calls as [string, Record<string, unknown>][];

beforeEach(() => {
  h.queryHistoryNotes.mockReset();
  h.queryHistoryNotes.mockResolvedValue({ data: [OWN, SHARED], error: null, count: 2 });
  h.deleteOwned.mockReset();
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: null, error: null });
  h.projects.data = PROJECTS;
  h.projects.error = null;
  h.projectQueries.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SummaryHistory delete confirm dialog', () => {
  it('names the note, and Cancel closes it without deleting', async () => {
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'deleteNote');
    expect(await screen.findByText('deleteNote?')).toBeInTheDocument();
    expect(screen.getByText('This will permanently delete', { exact: false })).toBeInTheDocument();
    const dialogText = screen.getByText('deleteNote?').closest('div') as HTMLElement;
    expect(within(dialogText).getByText('Alpha note')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.queryByText('deleteNote?')).not.toBeInTheDocument());
    expect(h.deleteOwned).not.toHaveBeenCalled();
    expect(screen.getAllByText('Alpha note').length).toBeGreaterThan(0);
  });

  it('clicking the backdrop closes it, clicking inside does not', async () => {
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'deleteNote');
    const title = await screen.findByText('deleteNote?');
    fireEvent.click(title);
    expect(screen.getByText('deleteNote?')).toBeInTheDocument();
    const backdrop = title.closest('div.fixed') as HTMLElement;
    fireEvent.click(backdrop);
    await waitFor(() => expect(screen.queryByText('deleteNote?')).not.toBeInTheDocument());
  });

  it('while deleting, Cancel is disabled and the backdrop does not close it', async () => {
    const d = deferred<{ id: string } | null>();
    h.deleteOwned.mockReturnValue(d.promise);
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'deleteNote');
    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'cancel' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'delete' })).toBeDisabled();
    fireEvent.click(screen.getByText('deleteNote?').closest('div.fixed') as HTMLElement);
    expect(screen.getByText('deleteNote?')).toBeInTheDocument();
    await act(async () => d.resolve({ id: 'n1' }));
    await waitFor(() => expect(screen.queryByText('deleteNote?')).not.toBeInTheDocument());
  });

  it('shows an Error from a failed delete inside the dialog and keeps it open', async () => {
    h.deleteOwned.mockRejectedValue(new Error('delete exploded'));
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'deleteNote');
    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));
    expect(await screen.findByText('delete exploded')).toBeInTheDocument();
    expect(screen.getByText('deleteNote?')).toBeInTheDocument();
  });

  it('a shared note asks to remove it from your shared notes and removes your access through the rpc', async () => {
    await mountLoaded();
    await openMenuAndPick('Beta note', 'deleteNote');
    expect(await screen.findByText('Remove shared note?')).toBeInTheDocument();
    expect(screen.getByText('from your shared notes', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryAllByText('Beta note')).toHaveLength(0));
    expect(rpcCalls()).toContainEqual(['remove_current_user_from_note_shared_users', { p_note_id: 'n2' }]);
    expect(h.deleteOwned).not.toHaveBeenCalled();
  });

  it('shows an rpc failure when removing a shared note', async () => {
    h.rpc.mockResolvedValue({ data: null, error: new Error('rpc denied') });
    await mountLoaded();
    await openMenuAndPick('Beta note', 'deleteNote');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('rpc denied')).toBeInTheDocument();
    expect(screen.getAllByText('Beta note').length).toBeGreaterThan(0);
  });
});

describe('SummaryHistory add to project dialog', () => {
  async function openDialog() {
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'addToProject');
    return screen.findByRole('dialog');
  }

  it('opens for the chosen note and lists the projects by name', async () => {
    const dialog = await openDialog();
    expect(within(dialog).getByText('addToProject', { selector: 'h2' })).toBeInTheDocument();
    expect(within(dialog).getByText('Alpha note')).toBeInTheDocument();
    expect(await within(dialog).findByText('Project One')).toBeInTheDocument();
    expect(within(dialog).getByText('Project Two')).toBeInTheDocument();
    const projectQuery = h.projectQueries.find((q) => q[0] === 'project') as unknown[];
    expect(projectQuery).toEqual(['project', ['select', 'id, name, notes'], ['order', 'name', { ascending: true }]]);
  });

  it('marks a project that already has the note and disables it', async () => {
    const dialog = await openDialog();
    const one = (await within(dialog).findByText('Project One')).closest('button') as HTMLButtonElement;
    expect(one).toBeDisabled();
    expect(within(one).getByText('alreadyInProject')).toBeInTheDocument();
    expect((within(dialog).getByText('Project Two').closest('button') as HTMLButtonElement)).not.toBeDisabled();
  });

  it('adds the note through the rpc, closes, and the project is then marked as already containing it', async () => {
    const dialog = await openDialog();
    fireEvent.click((await within(dialog).findByText('Project Two')).closest('button') as HTMLButtonElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(rpcCalls()).toContainEqual(['add_accessible_note_to_project', { p_note_id: 'n1', p_project_id: 'p2' }]);
    await openMenuAndPick('Alpha note', 'addToProject');
    const again = await screen.findByRole('dialog');
    const two = (await within(again).findByText('Project Two')).closest('button') as HTMLButtonElement;
    expect(two).toBeDisabled();
  });

  it('shows the rpc failure and keeps the dialog open', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'project rpc denied' } });
    const dialog = await openDialog();
    fireEvent.click((await within(dialog).findByText('Project Two')).closest('button') as HTMLButtonElement);
    expect(await within(dialog).findByText('project rpc denied')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the empty state and the load error', async () => {
    h.projects.data = [];
    const dialog = await openDialog();
    expect(await within(dialog).findByText('noProjectsFound')).toBeInTheDocument();
  });

  it('shows the generic load error for a non-Error failure', async () => {
    h.projects.data = [];
    h.projects.error = { message: 'projects down' };
    const dialog = await openDialog();
    expect(await within(dialog).findByText('Failed to load projects')).toBeInTheDocument();
  });

  it('the close button and the backdrop dismiss it', async () => {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await openMenuAndPick('Alpha note', 'addToProject');
    const again = await screen.findByRole('dialog');
    fireEvent.click(again.closest('div.fixed') as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('SummaryHistory share dialog', () => {
  it('opens with the note id, title and current share list, and Close dismisses it', async () => {
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'share');
    expect(await screen.findByTestId('share-id')).toHaveTextContent('n1');
    expect(screen.getByTestId('share-title')).toHaveTextContent('Alpha note');
    expect(screen.getByTestId('share-existing')).toHaveTextContent('z');
    fireEvent.click(screen.getByRole('button', { name: 'share-close' }));
    await waitFor(() => expect(screen.queryByTestId('share-modal')).not.toBeInTheDocument());
  });

  it('applies a confirmed share to the note so the next open shows the new list', async () => {
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'share');
    fireEvent.click(await screen.findByRole('button', { name: 'share-confirm' }));
    fireEvent.click(screen.getByRole('button', { name: 'share-close' }));
    await openMenuAndPick('Alpha note', 'share');
    expect(await screen.findByTestId('share-existing')).toHaveTextContent('x,y');
  });

  it('shows nothing for a note that is no longer in the list', async () => {
    await mountLoaded();
    await openMenuAndPick('Alpha note', 'share');
    await screen.findByTestId('share-modal');
    h.queryHistoryNotes.mockResolvedValue({ data: [SHARED], error: null, count: 1 });
    fireEvent.change(screen.getByLabelText('owner'), { target: { value: 'shared' } });
    await waitFor(() => expect(screen.queryByTestId('share-modal')).not.toBeInTheDocument());
  });
});

describe('SummaryHistory AX-KH dialog', () => {
  it('opens from the row menu for an owned note with its id and title, and closes', async () => {
    await mountLoaded();
    await openMenuAndPick('Alpha note', /AXKH integration/);
    expect(await screen.findByTestId('knowledge-id')).toHaveTextContent('n1');
    expect(screen.getByTestId('knowledge-title')).toHaveTextContent('Alpha note');
    fireEvent.click(screen.getByRole('button', { name: 'knowledge-close' }));
    await waitFor(() => expect(screen.queryByTestId('knowledge-modal')).not.toBeInTheDocument());
  });

  it('opens from the detail pane button for the selected note', async () => {
    await mountLoaded();
    fireEvent.click(screen.getAllByText('Alpha note')[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: 'axkh-open' }))[0]);
    expect(await screen.findByTestId('knowledge-id')).toHaveTextContent('n1');
  });

  it('is not offered for a note shared with you', async () => {
    await mountLoaded();
    fireEvent.click(screen.getAllByRole('button', { name: 'Note actions for Beta note' })[0]);
    await screen.findByRole('button', { name: 'share' });
    expect(screen.queryByRole('button', { name: /AXKH integration/ })).not.toBeInTheDocument();
  });
});
