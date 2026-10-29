import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mounting tests of the new-note page's automatic flow (U1/U9, DEC-0024). The workflow API is a
// stubbed fetch, Supabase sits behind mocked repositories, the recorder is a controllable fake and
// the transcript editor is a stub that exposes how the page configures it.

type Seg = { speaker: string; speakerKey?: string; text: string; start?: number; end?: number };

const h = vi.hoisted(() => {
  vi.stubEnv('VITE_WORKFLOW_API_URL', 'https://workflow.example.test');
  return {
    auth: {
      user: { id: 'user-1', displayName: 'Andrew' },
      isAuthenticated: true,
      isLoading: false,
      getAccessToken: async () => 'ms-token',
    },
    recorder: {} as Record<string, unknown>,
    recent: [] as unknown[],
    patchNoteReturningId: null as unknown as ReturnType<typeof vi.fn>,
    patchOwnedNoteReturningId: null as unknown as ReturnType<typeof vi.fn>,
    readOwnedNoteSummaryEdit: null as unknown as ReturnType<typeof vi.fn>,
    saveIfUnsaved: null as unknown as ReturnType<typeof vi.fn>,
    fetchReferencingNotes: null as unknown as ReturnType<typeof vi.fn>,
    upload: null as unknown as ReturnType<typeof vi.fn>,
    fileInsert: null as unknown as ReturnType<typeof vi.fn>,
  };
});

vi.mock('../context/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('../context/LanguageContext', () => ({
  useLanguage: () => ({ appLanguage: 'en', transcriptLanguage: 'original', t: (key: string) => key }),
}));
vi.mock('../context/RecorderContext', () => ({ useRecorder: () => h.recorder }));
vi.mock('../components/ConfirmDialog', () => ({ useConfirm: () => async () => true }));
vi.mock('../config/supabaseConfig', () => {
  const query = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'in', 'limit', 'update', 'delete']) q[m] = () => q;
    q.insert = (...a: unknown[]) => {
      h.fileInsert?.(table, ...a);
      return q;
    };
    const result = () =>
      table === 'summary_prompt'
        ? { data: [{ id: 1, name: 'Default', prompt: 'Summarize.' }], error: null }
        : table === 'file'
          ? { data: { id: 'file-1' }, error: null }
          : { data: [], error: null };
    q.maybeSingle = async () => (table === 'file' ? { data: null, error: null } : result());
    q.single = async () => result();
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok);
    return q;
  };
  return {
    supabase: {
      from: query,
      storage: {
        from: () => ({
          upload: (...a: unknown[]) => h.upload(...a),
          createSignedUrl: async () => ({ data: { signedUrl: 'https://storage.example.test/signed' }, error: null }),
          remove: async () => ({ error: null }),
        }),
      },
    },
    AUDIO_BUCKET: 'meeting-recordings',
    SUPABASE_URL: 'https://example.test',
    SUPABASE_ANON_KEY: 'anon',
    getSupabaseAccessTokenForRequest: async () => 'app-token',
  };
});
vi.mock('../services/supabaseResumableUpload', () => ({
  isSupabaseResumableConfigured: () => false,
  shouldUseResumableUpload: () => false,
  uploadWithTus: vi.fn(),
}));
vi.mock('../lib/storagePublicReady', () => ({ ensureStorageObjectReady: async () => undefined }));
vi.mock('../lib/recentAudioFilesQuery', () => ({ fetchRecentAudioFiles: async () => ({ data: h.recent, error: null }) }));
vi.mock('../lib/audioFileReferences', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/audioFileReferences')>();
  h.fetchReferencingNotes = vi.fn(async () => []);
  return { ...actual, fetchReferencingNotes: (...a: unknown[]) => h.fetchReferencingNotes(...a) };
});
vi.mock('../lib/notes/repository', () => {
  h.patchNoteReturningId = vi.fn(async () => ({ id: 'note-1' }));
  h.patchOwnedNoteReturningId = vi.fn(async () => ({ id: 'note-1' }));
  h.readOwnedNoteSummaryEdit = vi.fn(async () => null);
  h.saveIfUnsaved = vi.fn(async () => true);
  return {
    saveOwnedNoteSummaryEditIfUnsaved: (...a: unknown[]) => h.saveIfUnsaved(...a),
    patchNoteReturningId: (...a: unknown[]) => h.patchNoteReturningId(...a),
    patchOwnedNoteReturningId: (...a: unknown[]) => h.patchOwnedNoteReturningId(...a),
    readOwnedNoteSummaryEdit: (...a: unknown[]) => h.readOwnedNoteSummaryEdit(...a),
    saveNoteTranslations: vi.fn(async () => undefined),
  };
});
vi.mock('../lib/speakers/repository', () => ({
  insertSpeaker: vi.fn(),
  selectSpeakersByNames: vi.fn(async () => ({ data: [], error: null })),
  updateSpeakerProfileReturningId: vi.fn(),
}));
vi.mock('../lib/noteImages', () => ({ uploadNoteImage: vi.fn() }));
vi.mock('../services/meetingKnowledge', () => ({ meetingKnowledgeUiEnabled: false }));
vi.mock('../components/NoteImageAttachments', () => ({ default: () => null }));
vi.mock('../components/ShareNoteModal', () => ({ default: () => null }));
vi.mock('../components/MeetingKnowledgeModal', () => ({ default: () => null }));
vi.mock('../components/AxkhIntegrationButton', () => ({ default: () => null, shouldShowAxkhEntry: () => false }));
vi.mock('../components/TranscriptDiarizedEditor', () => {
  const Editor = (p: {
    segments: Seg[];
    suggestionPanel?: string;
    autoSuggest?: boolean;
    onSegmentsChange: (next: Seg[]) => void;
    onPersistSegments?: (next: Seg[]) => Promise<void>;
  }) => {
    const panel = p.suggestionPanel ?? 'inline';
    const name = (names: Record<string, string>) => {
      const next = p.segments.map((s) => ({ ...s, speaker: names[s.speakerKey ?? s.speaker] ?? s.speaker }));
      void p.onPersistSegments?.(next).then(() => p.onSegmentsChange(next));
    };
    return (
      <div data-testid={`editor-${panel}`} data-auto={String(Boolean(p.autoSuggest))}>
        <span data-testid={`speakers-${panel}`}>{p.segments.map((s) => s.speaker).join('|')}</span>
        {panel === 'only' ? (
          <>
            <button type="button" onClick={() => name({ 'Speaker A': 'Andrew', 'Speaker B': 'Hansoo' })}>
              name-main
            </button>
            <button type="button" onClick={() => name({ 'Speaker A': 'Andrew', 'Speaker B': 'Mina' })}>
              rename-b
            </button>
          </>
        ) : null}
      </div>
    );
  };
  return { default: Editor, getTranscriptSpeakerFilters: () => [], TranscriptSpeakerFilterControls: () => null };
});

import TranscriptionSummary from './TranscriptionSummary';
import { NAME_REFRESH_DEBOUNCE_MS } from './transcriptionSummary/useSummaryNameRefresh';


const TRANSCRIPT: Seg[] = [
  { speaker: 'Speaker A', speakerKey: 'Speaker A', text: 'We ship the web slice first.', start: 0, end: 60 },
  { speaker: 'Speaker B', speakerKey: 'Speaker B', text: 'Mobile follows.', start: 60, end: 95 },
  { speaker: 'Speaker C', speakerKey: 'Speaker C', text: 'Okay.', start: 95, end: 100 },
];

function baseRecorder(overrides: Record<string, unknown> = {}) {
  return {
    isRecording: false,
    recordingTime: 0,
    recordedAudioUrl: null,
    recordedBlob: null,
    recordedFileName: 'Recording.webm',
    recordedMimeType: 'audio/webm',
    isPlayingRecording: false,
    playbackProgress: 0,
    playbackCurrentTime: 0,
    wakeLockWarning: null,
    recoverabilityStatus: 'protected',
    recoveryWarning: null,
    recordingLimitWarning: false,
    recordingAutoStopped: false,
    acknowledgeAutoStop: vi.fn(),
    maxRecordingSeconds: 7200,
    recoverableSession: null,
    recorderError: null,
    clearRecorderError: vi.fn(),
    startRecording: vi.fn(async () => undefined),
    stopRecording: vi.fn(async () => undefined),
    clearRecording: vi.fn(),
    recoverRecording: vi.fn(async () => undefined),
    discardRecording: vi.fn(),
    togglePlayback: vi.fn(),
    seekPlaybackRatio: vi.fn(),
    startScreenWakeLockKeepAlive: vi.fn(),
    ensureScreenWakeLockFromGesture: vi.fn(),
    releaseScreenWakeLock: vi.fn(async () => undefined),
    ...overrides,
  };
}

type FetchCall = { url: string; method: string; body: Record<string, unknown> | null };
let fetchCalls: FetchCall[] = [];
let regenerateResponses: Array<() => Response> = [];
let submitRecordAtPost: string | null = null;
let jobResultExtra: Record<string, unknown> = {};

function installFetch() {
  fetchCalls = [];
  regenerateResponses = [];
  submitRecordAtPost = null;
  jobResultExtra = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      fetchCalls.push({ url: input, method, body });
      if (input.endsWith('/summarize-audio/jobs') && method === 'POST') {
        submitRecordAtPost = window.localStorage.getItem('meeting-note:summary-submit');
        return Response.json({ jobId: 'job-1', status: 'queued' }, { status: 202 });
      }
      if (input.includes('/summarize-audio/jobs/')) {
        return Response.json({
          jobId: 'job-1',
          noteId: 'note-1',
          status: 'completed',
          result: { transcript: TRANSCRIPT, summary: 'Generic summary about Speaker A.', title: 'Web slice', ...jobResultExtra },
        });
      }
      if (input.endsWith('/regenerate-summary')) {
        const next = regenerateResponses.shift();
        return next ? next() : Response.json({ summary: 'Andrew and Hansoo agreed.', persisted: false });
      }
      throw new Error(`Unexpected fetch ${method} ${input}`);
    })
  );
}

const regenerateCalls = () => fetchCalls.filter((c) => c.url.endsWith('/regenerate-summary'));
const submitCalls = () => fetchCalls.filter((c) => c.url.endsWith('/summarize-audio/jobs') && c.method === 'POST');

function renderPage(state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/transcription-summary', state }]}>
      <TranscriptionSummary />
    </MemoryRouter>
  );
}

async function openCompletedNote() {
  window.localStorage.setItem('meeting-note:active-summary-job', JSON.stringify({ jobId: 'job-1', noteId: 'note-1' }));
  renderPage();
  await screen.findByText('Generic summary about Speaker A.');
}

async function nameMainSpeakers() {
  fireEvent.click(screen.getByRole('button', { name: 'name-main' }));
  await waitFor(() => expect(screen.getByTestId('speakers-only').textContent).toBe('Andrew|Hansoo|Speaker C'));
}

async function passDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NAME_REFRESH_DEBOUNCE_MS + 50);
  });
  // Let the token, saved-edit read and regenerate promises settle.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  );
  window.localStorage.clear();
  h.recorder = baseRecorder();
  h.patchNoteReturningId.mockClear();
  h.patchOwnedNoteReturningId.mockClear();
  h.readOwnedNoteSummaryEdit.mockReset();
  h.readOwnedNoteSummaryEdit.mockResolvedValue(null);
  h.saveIfUnsaved.mockReset();
  h.saveIfUnsaved.mockResolvedValue(true);
  h.fetchReferencingNotes.mockReset();
  h.fetchReferencingNotes.mockResolvedValue([]);
  h.upload = vi.fn(async () => ({ error: null }));
  h.fileInsert = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TranscriptionSummary speaker suggestions and name-aware refresh (U9)', () => {
  it('shows the suggestion card above the result with auto suggest, and hides it in the transcript tab', async () => {
    await openCompletedNote();
    const card = screen.getByTestId('editor-only');
    expect(card.dataset.auto).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'transcription' }));
    expect(screen.getByTestId('editor-hidden').dataset.auto).toBe('true');
  });

  it('refreshes the summary once after the main speakers are named, and saves it as the owner', async () => {
    await openCompletedNote();
    await nameMainSpeakers();
    expect(regenerateCalls()).toHaveLength(0);
    await passDebounce();
    await screen.findByText('Andrew and Hansoo agreed.');
    expect(regenerateCalls()).toHaveLength(1);
    const body = regenerateCalls()[0].body!;
    expect(body.persist).toBe(false);
    expect((body.diarization as Seg[]).map((s) => s.speaker)).toEqual(['Andrew', 'Hansoo', 'Speaker C']);
    // Nothing was saved yet: one conditional owner-scoped write (only while summary_edit is empty).
    expect(h.saveIfUnsaved).toHaveBeenCalledWith({ noteId: 'note-1', userId: 'user-1', text: 'Andrew and Hansoo agreed.' });
    expect(h.patchOwnedNoteReturningId).not.toHaveBeenCalled();
  });

  it('an edit saved elsewhere while the request was in flight is kept, and the page asks instead', async () => {
    h.readOwnedNoteSummaryEdit.mockResolvedValueOnce(null).mockResolvedValue('Edited in another tab.');
    await openCompletedNote();
    await nameMainSpeakers();
    await passDebounce();
    await screen.findByText('newSummaryReady');
    expect(h.saveIfUnsaved).not.toHaveBeenCalled();
    expect(h.patchOwnedNoteReturningId).not.toHaveBeenCalled();
    expect(screen.getByText('Generic summary about Speaker A.')).toBeInTheDocument();
  });

  it('an older backend that saved by itself: shows its summary with a neutral notice, no replace prompt, no more auto refresh', async () => {
    regenerateResponses.push(() => Response.json({ summary: 'Saved by the old server.' }));
    await openCompletedNote();
    await nameMainSpeakers();
    await passDebounce();
    await screen.findByText('Saved by the old server.');
    expect(screen.getByText('summaryUpdatedAutoPaused')).toBeInTheDocument();
    expect(screen.queryByText('newSummaryReady')).not.toBeInTheDocument();
    expect(h.saveIfUnsaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'rename-b' }));
    await passDebounce();
    expect(regenerateCalls()).toHaveLength(1);
  });

  it('asks before replacing a summary the user edited, and replaces only on accept', async () => {
    await openCompletedNote();
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    fireEvent.change(screen.getByPlaceholderText(/Edit your summary here/), { target: { value: 'My own notes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'done' }));
    await screen.findByText('My own notes.');
    await nameMainSpeakers();
    await passDebounce();
    await screen.findByText('newSummaryReady');
    expect(screen.getByText('My own notes.')).toBeInTheDocument();
    expect(h.patchOwnedNoteReturningId).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'replaceSummary' }));
    await screen.findByText('Andrew and Hansoo agreed.');
    expect(h.patchOwnedNoteReturningId).toHaveBeenCalledTimes(1);
  });

  it('keeps the old summary on failure and retries on request', async () => {
    regenerateResponses.push(() => Response.json({ error: 'Gemini is busy' }, { status: 500 }));
    await openCompletedNote();
    await nameMainSpeakers();
    await passDebounce();
    await screen.findByText(/Gemini is busy/);
    expect(screen.getByText('Generic summary about Speaker A.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'tryAgain' }));
    await screen.findByText('Andrew and Hansoo agreed.');
    expect(regenerateCalls()).toHaveLength(2);
  });

  it('a translation never replaces a summary the user edited by hand (finding 7)', async () => {
    jobResultExtra = { summaryTranslations: { en: 'Translated summary.' } };
    window.localStorage.setItem('meeting-note:active-summary-job', JSON.stringify({ jobId: 'job-1', noteId: 'note-1' }));
    renderPage();
    await screen.findByText('Translated summary.');
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    fireEvent.change(screen.getByPlaceholderText(/Edit your summary here/), { target: { value: 'My edit.' } });
    fireEvent.click(screen.getByRole('button', { name: 'done' }));
    await screen.findByText('My edit.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByText('My edit.')).toBeInTheDocument();
    expect(screen.queryByText('Translated summary.')).not.toBeInTheDocument();
  });

  it('the update-with-names button regenerates right away', async () => {
    await openCompletedNote();
    fireEvent.click(screen.getByRole('button', { name: 'updateSummaryWithNames' }));
    await screen.findByText('Andrew and Hansoo agreed.');
    expect(regenerateCalls()).toHaveLength(1);
    expect(submitCalls()).toHaveLength(0);
  });
});

describe('TranscriptionSummary automatic summary after recording or choosing a file (U1)', () => {
  const blob = new Blob(['audio-bytes'], { type: 'audio/webm' });
  const finishedRecording = (seconds: number) => ({
    isRecording: false,
    recordedBlob: blob,
    recordedAudioUrl: 'blob:recording',
    recordingTime: seconds,
  });

  // Renders a page whose recorder is recording; stopping it yields `seconds` of audio.
  function renderRecording(seconds: number) {
    h.recorder = baseRecorder({ isRecording: true, recordingTime: seconds });
    const view = renderPage();
    (h.recorder.stopRecording as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      h.recorder = { ...h.recorder, ...finishedRecording(seconds) };
    });
    const rerender = () =>
      view.rerender(
        <MemoryRouter initialEntries={['/transcription-summary']}>
          <TranscriptionSummary />
        </MemoryRouter>
      );
    return { ...view, rerenderPage: rerender };
  }

  async function stopRecording(view: ReturnType<typeof renderRecording>) {
    await act(async () => {
      fireEvent.click(screen.getByText('recordingClickToStop'));
    });
    view.rerenderPage();
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('starts upload and summary after the grace countdown, with the note id stored before the POST', async () => {
    const view = renderRecording(30);
    await stopRecording(view);
    expect(await screen.findByText('autoSummaryStartsIn')).toBeInTheDocument();
    expect(h.upload).not.toHaveBeenCalled();
    await advance(5100);
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    expect(h.upload).toHaveBeenCalledTimes(1);
    const posted = submitCalls()[0].body!;
    const stored = JSON.parse(submitRecordAtPost ?? 'null') as { noteId: string; userId: string } | null;
    expect(stored).toMatchObject({ noteId: posted.noteId, userId: 'user-1' });
    await screen.findByText('Generic summary about Speaker A.');
    // Cleared after the note exists, so summarizing the same file again on purpose makes a new note.
    expect(window.localStorage.getItem('meeting-note:summary-submit')).toBeNull();
  });

  it('cancel during the countdown sends nothing and keeps the recording', async () => {
    const view = renderRecording(30);
    await stopRecording(view);
    await screen.findByText('autoSummaryStartsIn');
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await advance(6000);
    expect(h.upload).not.toHaveBeenCalled();
    expect(submitCalls()).toHaveLength(0);
    expect(screen.getByText('recordingComplete')).toBeInTheDocument();
  });

  it('does not start automatically for a very short recording', async () => {
    const view = renderRecording(3);
    await stopRecording(view);
    await screen.findByText('shortRecordingNoAutoSummary');
    expect(screen.queryByText('autoSummaryStartsIn')).not.toBeInTheDocument();
    await advance(6000);
    expect(submitCalls()).toHaveLength(0);
  });

  it('a recovered recording waits for the user', async () => {
    h.recorder = baseRecorder(finishedRecording(600));
    renderPage();
    await screen.findByText('recordingComplete');
    await advance(6000);
    expect(screen.queryByText('autoSummaryStartsIn')).not.toBeInTheDocument();
    expect(submitCalls()).toHaveLength(0);
  });

  it('a stop from the floating widget starts the countdown on arrival', async () => {
    h.recorder = baseRecorder(finishedRecording(600));
    renderPage({ autoSummarize: true });
    expect(await screen.findByText('autoSummaryStartsIn')).toBeInTheDocument();
  });

  it('a recent recording that already has a note links to it instead of resubmitting', async () => {
    h.recent = [
      { id: 'file-9', name: 'old.webm', bucket: 'meeting-recordings', storage_path: 'old.webm', public_url: '', size_bytes: 10 },
    ];
    h.fetchReferencingNotes.mockResolvedValue([{ id: 'note-9', name: 'Old note', audio_file: null, audio_file_id: 'file-9' }]);
    renderPage();
    fireEvent.click(await screen.findByText('old.webm'));
    await screen.findByText(/recordingHasNote/);
    expect(screen.getByRole('button', { name: 'openNote' })).toBeInTheDocument();
    await advance(6000);
    expect(screen.queryByText('autoSummaryStartsIn')).not.toBeInTheDocument();
    expect(submitCalls()).toHaveLength(0);
    h.recent = [];
  });

  it('a recent recording without a note starts after the countdown', async () => {
    h.recent = [
      { id: 'file-8', name: 'fresh.webm', bucket: 'meeting-recordings', storage_path: 'fresh.webm', public_url: '', size_bytes: 10 },
    ];
    renderPage();
    fireEvent.click(await screen.findByText('fresh.webm'));
    await screen.findByText('autoSummaryStartsIn');
    await advance(5100);
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    expect(submitCalls()[0].body!.fileId).toBe('file-8');
    h.recent = [];
  });

  function chooseFiles(container: HTMLElement, names: string[]) {
    const input = container.querySelector('#meeting-audio-upload') as HTMLInputElement;
    const files = names.map((name) => new File(['audio'], name, { type: 'audio/webm' }));
    fireEvent.change(input, { target: { files } });
  }

  it('a file upload starts the summary after the countdown', async () => {
    const { container } = renderPage();
    await screen.findByText('noRecentRecordings');
    chooseFiles(container, ['meeting.webm']);
    await screen.findByText('autoSummaryStartsIn');
    await advance(5100);
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    expect(submitCalls()[0].body!.fileName).toBe('meeting.webm');
  });

  it('the automatic start submits the file it waited for, not the first one in the list (finding 5)', async () => {
    const { container } = renderPage();
    await screen.findByText('noRecentRecordings');
    chooseFiles(container, ['first.webm']);
    await screen.findByText('autoSummaryStartsIn');
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await advance(100);
    chooseFiles(container, ['second.webm']);
    await screen.findByText('autoSummaryStartsIn');
    await advance(5100);
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    expect(submitCalls()[0].body!.fileName).toBe('second.webm');
  });

  it('a manual Summarize click during the countdown posts once', async () => {
    const { container } = renderPage();
    await screen.findByText('noRecentRecordings');
    chooseFiles(container, ['meeting.webm']);
    await screen.findByText('autoSummaryStartsIn');
    // The Options row's Summarize (the hidden recording panel has its own button).
    const optionsSummarize = await waitFor(() => {
      const button = screen
        .getAllByRole('button', { name: 'summarize' })
        .find((candidate) => !candidate.closest('.recording-playback-actions'));
      if (!button) throw new Error('Summarize button not ready');
      return button;
    });
    fireEvent.click(optionsSummarize);
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    await advance(7000);
    expect(submitCalls()).toHaveLength(1);
    expect(screen.queryByText('autoSummaryStartsIn')).not.toBeInTheDocument();
  });

  it('the 2-hour auto stop on this page starts the countdown, and Cancel acknowledges it', async () => {
    h.recorder = baseRecorder({ ...finishedRecording(7200), recordingAutoStopped: true });
    renderPage();
    await screen.findByText('autoSummaryStartsIn');
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(h.recorder.acknowledgeAutoStop).toHaveBeenCalled();
    await advance(6000);
    expect(submitCalls()).toHaveLength(0);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('a failed referencing-note check skips the automatic start (fail-closed)', async () => {
    h.recent = [
      { id: 'file-7', name: 'unknown.webm', bucket: 'meeting-recordings', storage_path: 'unknown.webm', public_url: '', size_bytes: 10 },
    ];
    h.fetchReferencingNotes.mockRejectedValue(new Error('timeout'));
    renderPage();
    fireEvent.click(await screen.findByText('unknown.webm'));
    await screen.findByText('recordingNoteCheckFailed');
    await advance(6000);
    expect(screen.queryByText('autoSummaryStartsIn')).not.toBeInTheDocument();
    expect(submitCalls()).toHaveLength(0);
    h.recent = [];
  });
});
