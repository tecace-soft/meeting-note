import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mounting characterization of the Sync Profile (speaker profile generation) flows of SummaryHistory (T2-4
// speakers unit). The notes and speakers repositories are mocked at the module boundary and the
// generate-profile edge function is a stubbed fetch. Own harness on purpose: the older mounting test file is
// left untouched.

const h = vi.hoisted(() => ({
  auth: {
    user: { id: 'user-1', displayName: 'Me Myself', microsoftAccountName: 'Me', email: 'me@example.test' },
    isAuthenticated: true,
    isLoading: false,
    getAccessToken: async (): Promise<string | null> => 'ms-token',
  },
  appToken: null as string | null,
  language: { appLanguage: 'en', t: (key: string) => key },
  queryHistoryNotes: null as unknown as ReturnType<typeof vi.fn>,
  selectSpeakersByNames: null as unknown as ReturnType<typeof vi.fn>,
  updateSpeakerProfileReturningId: null as unknown as ReturnType<typeof vi.fn>,
  insertSpeaker: null as unknown as ReturnType<typeof vi.fn>,
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
  getSupabaseAccessTokenForRequest: async () => h.appToken,
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_URL: 'https://example.test',
}));
vi.mock('../lib/notes/repository', () => {
  h.queryHistoryNotes = vi.fn();
  return {
    queryHistoryNotes: (...a: unknown[]) => h.queryHistoryNotes(...a),
    patchOwnedNoteReturningId: vi.fn(),
    deleteOwnedNoteReturningId: vi.fn(),
    saveNoteTranslations: vi.fn(),
    patchNoteReturningId: vi.fn(),
  };
});
vi.mock('../lib/speakers/repository', () => {
  h.selectSpeakersByNames = vi.fn();
  h.updateSpeakerProfileReturningId = vi.fn();
  h.insertSpeaker = vi.fn();
  return {
    selectSpeakersByNames: (...a: unknown[]) => h.selectSpeakersByNames(...a),
    updateSpeakerProfileReturningId: (...a: unknown[]) => h.updateSpeakerProfileReturningId(...a),
    insertSpeaker: (...a: unknown[]) => h.insertSpeaker(...a),
  };
});
vi.mock('../lib/noteImages', () => ({ getNoteImageCounts: async () => ({}) }));
vi.mock('../services/graphService', () => ({ getOutlookCalendarEvents: async () => [] }));
vi.mock('../services/meetingKnowledge', () => ({ meetingKnowledgeUiEnabled: false }));
vi.mock('../components/MeetingBriefing', () => ({ MeetingBriefing: () => null }));
vi.mock('../components/NoteImageAttachments', () => ({ default: () => null }));
vi.mock('../components/TranscriptDiarizedEditor', () => ({
  default: () => null,
  getTranscriptSpeakerFilters: () => [],
  TranscriptSpeakerFilterControls: () => null,
}));
vi.mock('../components/ShareNoteModal', () => ({ default: () => null }));
vi.mock('../components/MeetingKnowledgeModal', () => ({ default: () => null }));
vi.mock('../components/AxkhIntegrationButton', () => ({ default: () => null }));

import SummaryHistory from './SummaryHistory';

const SEGS = [
  { speaker: 'Ann', text: 'hello there', start: 0, end: 1 },
  { speaker: 'Bob', text: 'hi', start: 1, end: 2 },
  { speaker: 'Speaker A', text: 'who is this', start: 2, end: 3 },
];
const NOTE = {
  id: 'n1',
  name: 'Alpha note',
  user_id: 'user-1',
  user_name: 'Me',
  created_at: '2026-10-01T10:00:00Z',
  meeting_at: '2026-10-01T10:00:00Z',
  summary: 'Alpha summary',
  diarization: SEGS,
};
const TRANSCRIPT_TEXT = 'Ann: hello there\n\nBob: hi\n\nSpeaker A: who is this';
const PROFILE_JSON = '{"role":"engineer"}';
// canonicalOntologyProfileString stamps last_updated_at, so compare on the stable schema marker.
const CANON = expect.stringContaining('"schema_version"');

type FetchCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let fetchCalls: FetchCall[] = [];
function stubFetch(handler: (body: Record<string, unknown>) => { ok: boolean; status?: number; payload: unknown } = () => ({ ok: true, payload: { profile: PROFILE_JSON } })) {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (url.includes('generate-profile')) fetchCalls.push({ url, headers: init.headers, body });
      const r = handler(body);
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), text: async () => JSON.stringify(r.payload) };
    })
  );
}

async function openModal() {
  render(
    <MemoryRouter initialEntries={['/history']}>
      <SummaryHistory />
    </MemoryRouter>
  );
  fireEvent.click((await screen.findAllByText('Alpha note'))[0]);
  fireEvent.click((await screen.findAllByRole('button', { name: 'syncProfile' }))[0]);
  return screen.findByRole('dialog');
}
async function openReady() {
  const dialog = await openModal();
  await within(dialog).findByText('Ann');
  return dialog;
}

beforeEach(() => {
  h.appToken = null;
  h.auth.getAccessToken = async () => 'ms-token';
  h.queryHistoryNotes.mockReset();
  h.queryHistoryNotes.mockResolvedValue({ data: [NOTE], error: null, count: 1 });
  h.selectSpeakersByNames.mockReset();
  h.selectSpeakersByNames.mockResolvedValue({
    data: [{ id: 'sp-ann', name: 'Ann', profile: '{"role":"old"}' }],
    error: null,
  });
  h.updateSpeakerProfileReturningId.mockReset();
  h.insertSpeaker.mockReset();
  stubFetch();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SummaryHistory Sync Profile generation', () => {
  it('looks up saved speakers by name, then generates one profile per speaker from the transcript', async () => {
    const dialog = await openReady();
    expect(h.selectSpeakersByNames).toHaveBeenCalledWith('user-1', ['Ann', 'Bob', 'Speaker A'], 'id, name, profile');
    expect(fetchCalls).toHaveLength(3);
    const byName = Object.fromEntries(fetchCalls.map((c) => [c.body.speakerName as string, c]));
    expect(byName.Ann.body).toEqual({
      speakerName: 'Ann',
      speakerId: 'sp-ann',
      transcriptText: TRANSCRIPT_TEXT,
      existingProfile: '{"role":"old"}',
    });
    expect(byName.Bob.body).toMatchObject({ speakerId: '', existingProfile: null });
    expect(byName.Ann.url).toBe('https://example.test/functions/v1/generate-profile');
    expect(byName.Ann.headers).toMatchObject({ Authorization: 'Bearer anon', 'x-ms-access-token': 'ms-token' });
    // existing speaker is an update, unknown speakers are new
    const annCard = within(dialog).getByText('Ann').closest('div.overflow-hidden') as HTMLElement;
    expect(within(annCard).getByText('updatedProfile')).toBeInTheDocument();
    const bobCard = within(dialog).getByText('Bob').closest('div.overflow-hidden') as HTMLElement;
    expect(within(bobCard).getByText('newProfile')).toBeInTheDocument();
    expect((within(bobCard).getByRole('textbox') as HTMLTextAreaElement).value).toContain('schema_version');
    expect(within(dialog).getByText('0 of 3 profiles saved')).toBeInTheDocument();
  });

  it('uses the app token and no Microsoft token when one is available', async () => {
    h.appToken = 'app-token';
    await openReady();
    expect(fetchCalls[0].headers.Authorization).toBe('Bearer app-token');
    expect(fetchCalls[0].headers['x-ms-access-token']).toBeUndefined();
  });

  it('shows the finding/generating progress while working', async () => {
    let release!: () => void;
    h.selectSpeakersByNames.mockReturnValue(new Promise((r) => (release = () => r({ data: [], error: null }))));
    const dialog = await openModal();
    expect(await within(dialog).findByText('lookingUpSpeakerData')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'close' })).toBeDisabled();
    await act(async () => release());
    await within(dialog).findByText('Ann');
  });

  it('reports a speaker lookup failure', async () => {
    h.selectSpeakersByNames.mockResolvedValue({ data: null, error: new Error('lookup down') });
    const dialog = await openModal();
    expect(await within(dialog).findByText('lookup down')).toBeInTheDocument();
    expect(fetchCalls).toHaveLength(0);
  });

  it('reports a missing access token without calling the edge function', async () => {
    h.auth.getAccessToken = async () => null;
    const dialog = await openModal();
    expect(await within(dialog).findByText('Could not get access. Please sign in again.')).toBeInTheDocument();
    expect(fetchCalls).toHaveLength(0);
  });

  it('names the speaker when the edge function fails or returns an error', async () => {
    stubFetch((body) => (body.speakerName === 'Bob' ? { ok: false, payload: { error: 'model down' } } : { ok: true, payload: { profile: PROFILE_JSON } }));
    const dialog = await openModal();
    expect(await within(dialog).findByText('Edge function error for "Bob": model down')).toBeInTheDocument();
  });

  it('names the speaker when the edge function answers with an error field', async () => {
    stubFetch(() => ({ ok: true, payload: { error: 'bad profile' } }));
    const dialog = await openModal();
    expect(await within(dialog).findByText(/Profile error for ".*": bad profile/)).toBeInTheDocument();
  });

  it('close button dismisses the dialog once ready', async () => {
    const dialog = await openReady();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'close' })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('SummaryHistory Sync Profile saving', () => {
  const card = (dialog: HTMLElement, name: string) => within(dialog).getByText(name).closest('div.overflow-hidden') as HTMLElement;

  it('saves an existing speaker with an owner-scoped update and marks it saved', async () => {
    h.updateSpeakerProfileReturningId.mockResolvedValue({ id: 'sp-ann' });
    const dialog = await openReady();
    fireEvent.click(within(card(dialog, 'Ann')).getByRole('button', { name: /saveProfile/ }));
    await waitFor(() => expect(within(card(dialog, 'Ann')).getByText('saved')).toBeInTheDocument());
    expect(h.updateSpeakerProfileReturningId).toHaveBeenCalledWith({ speakerId: 'sp-ann', userId: 'user-1', profile: CANON });
    expect(within(dialog).getByText('1 of 3 profiles saved')).toBeInTheDocument();
  });

  it('shows the refresh message and does not mark saved when no row was updated', async () => {
    h.updateSpeakerProfileReturningId.mockResolvedValue(null);
    const dialog = await openReady();
    fireEvent.click(within(card(dialog, 'Ann')).getByRole('button', { name: /saveProfile/ }));
    expect(await within(dialog).findByText('Could not save the speaker profile. Please refresh and try again.')).toBeInTheDocument();
    expect(within(card(dialog, 'Ann')).queryByText('saved')).not.toBeInTheDocument();
  });

  it('inserts a new speaker with the profile', async () => {
    h.insertSpeaker.mockResolvedValue({ error: null });
    const dialog = await openReady();
    fireEvent.click(within(card(dialog, 'Bob')).getByRole('button', { name: /saveProfile/ }));
    await waitFor(() => expect(within(card(dialog, 'Bob')).getByText('saved')).toBeInTheDocument());
    expect(h.insertSpeaker).toHaveBeenCalledWith({ userId: 'user-1', name: 'Bob', profile: CANON });
  });

  it('shows an Error message from a failed insert, and the generic one for a non-Error', async () => {
    h.insertSpeaker.mockResolvedValueOnce({ error: new Error('insert denied') });
    const dialog = await openReady();
    fireEvent.click(within(card(dialog, 'Bob')).getByRole('button', { name: /saveProfile/ }));
    expect(await within(dialog).findByText('insert denied')).toBeInTheDocument();
    h.insertSpeaker.mockResolvedValueOnce({ error: { message: 'raw' } });
    fireEvent.click(within(card(dialog, 'Bob')).getByRole('button', { name: /saveProfile/ }));
    expect(await within(dialog).findByText('Save failed')).toBeInTheDocument();
  });

  it('refuses to save an anonymous speaker label as a speaker', async () => {
    const dialog = await openReady();
    fireEvent.click(within(card(dialog, 'Speaker A')).getByRole('button', { name: /saveProfile/ }));
    await Promise.resolve();
    expect(h.insertSpeaker).not.toHaveBeenCalled();
    expect(h.updateSpeakerProfileReturningId).not.toHaveBeenCalled();
  });

  it('editing a draft is kept and saved as typed', async () => {
    h.insertSpeaker.mockResolvedValue({ error: null });
    const dialog = await openReady();
    const box = within(card(dialog, 'Bob')).getByRole('textbox');
    fireEvent.change(box, { target: { value: '{"role":"designer"}' } });
    expect(box).toHaveValue('{"role":"designer"}');
    fireEvent.click(within(card(dialog, 'Bob')).getByRole('button', { name: /saveProfile/ }));
    await waitFor(() => expect(h.insertSpeaker).toHaveBeenCalled());

    expect(h.insertSpeaker).toHaveBeenCalledWith({ userId: 'user-1', name: 'Bob', profile: CANON });
  });
});

describe('SummaryHistory Sync Profile save all', () => {
  async function openConfirm() {
    const dialog = await openReady();
    fireEvent.click(within(dialog).getByRole('button', { name: 'saveAll' }));
    const confirm = (await screen.findAllByRole('dialog')).pop() as HTMLElement;
    return { dialog, confirm };
  }

  it('saves the person profiles and lists the anonymous label as a failed one', async () => {
    h.updateSpeakerProfileReturningId.mockResolvedValue({ id: 'sp-ann' });
    h.insertSpeaker.mockResolvedValue({ error: null });
    const { confirm } = await openConfirm();
    fireEvent.click(within(confirm).getByRole('button', { name: 'confirmSaveAll' }));
    expect(await within(confirm).findByText('failedSaveAllProfiles')).toBeInTheDocument();
    expect(within(confirm).getByText('Speaker A: "Speaker A" is not a person name and was not saved as a speaker.')).toBeInTheDocument();
    expect(h.updateSpeakerProfileReturningId).toHaveBeenCalledTimes(1);
    expect(h.insertSpeaker).toHaveBeenCalledTimes(1);
    expect(h.insertSpeaker).toHaveBeenCalledWith({ userId: 'user-1', name: 'Bob', profile: CANON });
  });

  it('cancel leaves everything unsaved', async () => {
    const { confirm } = await openConfirm();
    fireEvent.click(within(confirm).getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    expect(h.insertSpeaker).not.toHaveBeenCalled();
    expect(h.updateSpeakerProfileReturningId).not.toHaveBeenCalled();
  });

  it('with only person speakers it succeeds and closes both dialogs', async () => {
    h.selectSpeakersByNames.mockResolvedValue({ data: [{ id: 'sp-ann', name: 'Ann', profile: null }], error: null });
    h.queryHistoryNotes.mockResolvedValue({ data: [{ ...NOTE, diarization: SEGS.slice(0, 2) }], error: null, count: 1 });
    h.updateSpeakerProfileReturningId.mockResolvedValue({ id: 'sp-ann' });
    h.insertSpeaker.mockResolvedValue({ error: null });
    const { confirm } = await openConfirm();
    fireEvent.click(within(confirm).getByRole('button', { name: 'confirmSaveAll' }));
    expect(await within(confirm).findByText('profilesSaved')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    fireEvent.click(within(confirm).getByRole('button', { name: 'close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
