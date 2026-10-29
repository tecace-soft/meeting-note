import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mounting characterization of SummaryHistory transcript-segment playback (T2-4 playback unit): the signed
// audio URL request and cache, play / stop, switching notes, and the audio element events. Own harness on
// purpose; R10 updates the original failure contract to one re-sign and one retry,
// followed by reset only when recovery also fails.

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
vi.mock('../lib/speakers/repository', () => ({
  selectSpeakersByNames: vi.fn(async () => ({ data: [], error: null })),
  updateSpeakerProfileReturningId: vi.fn(),
  insertSpeaker: vi.fn(),
}));
vi.mock('../lib/noteImages', () => ({ getNoteImageCounts: async () => ({}) }));
vi.mock('../services/graphService', () => ({ getOutlookCalendarEvents: async () => [] }));
vi.mock('../services/meetingKnowledge', () => ({ meetingKnowledgeUiEnabled: false }));
vi.mock('../components/MeetingBriefing', () => ({ MeetingBriefing: () => null }));
vi.mock('../components/NoteImageAttachments', () => ({ default: () => null }));
vi.mock('../components/ShareNoteModal', () => ({ default: () => null }));
vi.mock('../components/MeetingKnowledgeModal', () => ({ default: () => null }));
vi.mock('../components/AxkhIntegrationButton', () => ({ default: () => null }));
vi.mock('../components/TranscriptDiarizedEditor', () => {
  type Seg = { speaker: string; text: string; start?: number; end?: number };
  const Editor = (p: {
    noteId: string;
    segments: Seg[];
    canPlaySegment?: (s: Seg) => boolean;
    onPlaySegment?: (s: Seg, i: number) => void;
    activePlaybackSegmentIndex?: number | null;
    isPlaybackActive?: boolean;
    loadingPlaybackSegmentIndex?: number | null;
    playbackTimeLabel?: string | null;
  }) => (
    <div data-testid={`editor-${p.noteId}`}>
      <span data-testid="pb-active">{String(p.activePlaybackSegmentIndex)}</span>
      <span data-testid="pb-playing">{String(p.isPlaybackActive)}</span>
      <span data-testid="pb-loading">{String(p.loadingPlaybackSegmentIndex)}</span>
      <span data-testid="pb-label">{String(p.playbackTimeLabel)}</span>
      {p.segments.map((s, i) => (
        <button key={i} type="button" data-playable={String(Boolean(p.canPlaySegment?.(s)))} onClick={() => p.onPlaySegment?.(s, i)}>
          {`play-${s.speaker}`}
        </button>
      ))}
    </div>
  );
  return { default: Editor, getTranscriptSpeakerFilters: () => [], TranscriptSpeakerFilterControls: () => null };
});

import SummaryHistory from './SummaryHistory';

const SEGS_A = [
  { speaker: 'Ann', text: 'hello', start: 0, end: 4 },
  { speaker: 'Bob', text: 'hi', start: 5 },
  { speaker: 'Cat', text: 'no timing' },
];
const NOTE_A = {
  id: 'n1',
  name: 'Alpha note',
  user_id: 'user-1',
  user_name: 'Me',
  created_at: '2026-10-01T10:00:00Z',
  meeting_at: '2026-10-01T10:00:00Z',
  summary: 'Alpha summary',
  diarization: SEGS_A,
};
const NOTE_B = {
  ...NOTE_A,
  id: 'n2',
  name: 'Beta note',
  created_at: '2026-10-02T10:00:00Z',
  meeting_at: '2026-10-02T10:00:00Z',
  diarization: [{ speaker: 'Dan', text: 'yo', start: 1, end: 2 }],
};
const NOTE_PLAIN = { ...NOTE_A, id: 'n3', name: 'Gamma note', diarization: [{ speaker: 'Eve', text: 'untimed' }] };

type AudioCall = string;
const media = {
  calls: [] as AudioCall[],
  currentTime: 0,
  duration: Number.NaN,
  src: '',
  loadMode: 'ok' as 'ok' | 'error' | 'never',
  loadModes: [] as Array<'ok' | 'error' | 'never'>,
  playError: null as Error | null,
};
let fetchCalls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let fetchHandler: (body: Record<string, unknown>) => { ok: boolean; status?: number; payload: unknown };

function stubFetch() {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      fetchCalls.push({ url, headers: init.headers, body });
      const r = fetchHandler(body);
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), text: async () => (typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload)) };
    })
  );
}

function stubMedia() {
  const proto = HTMLMediaElement.prototype;
  Object.defineProperty(proto, 'readyState', { configurable: true, get: () => (media.src ? 4 : 0) });
  Object.defineProperty(proto, 'duration', { configurable: true, get: () => media.duration });
  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get: () => media.currentTime,
    set: (v: number) => {
      media.currentTime = v;
      media.calls.push(`seek:${v}`);
    },
  });
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get: () => media.src,
    set: (v: string) => {
      media.src = v;
      media.calls.push(`src:${v}`);
    },
  });
  vi.spyOn(proto, 'load').mockImplementation(function (this: HTMLMediaElement) {
    media.calls.push('load');
    const mode = media.loadModes.shift() ?? media.loadMode;
    setTimeout(() => {
      if (mode === 'ok') this.dispatchEvent(new Event('loadedmetadata'));
      if (mode === 'error') this.dispatchEvent(new Event('error'));
    }, 0);
  });
  vi.spyOn(proto, 'play').mockImplementation(async function () {
    media.calls.push('play');
    if (media.playError) throw media.playError;
  });
  vi.spyOn(proto, 'pause').mockImplementation(() => {
    media.calls.push('pause');
  });
}

const errorCalls = () => (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
const urlFor = (id: string) => `https://audio.example/${id}.mp3`;

async function mountLoaded(notes: unknown[] = [NOTE_A, NOTE_B, NOTE_PLAIN]) {
  h.queryHistoryNotes.mockResolvedValue({ data: notes, error: null, count: notes.length });
  render(
    <MemoryRouter initialEntries={['/history']}>
      <SummaryHistory />
    </MemoryRouter>
  );
  await screen.findAllByText('Alpha note');
}
async function selectNote(title: string) {
  fireEvent.click(screen.getAllByText(title)[0]);
  fireEvent.click((await screen.findAllByRole('tab', { name: 'transcription' }))[0]);
  await screen.findAllByTestId(/^editor-/);
}
const text = (id: string) => screen.getAllByTestId(id)[0].textContent;
const playButton = (name: string) => screen.getAllByRole('button', { name: `play-${name}` })[0];
const audio = () => document.querySelector('audio') as HTMLAudioElement;
const signedFetches = () => fetchCalls.filter((c) => c.url.includes('note-audio-url'));

beforeEach(() => {
  h.appToken = null;
  h.auth.getAccessToken = async () => 'ms-token';
  media.calls = [];
  media.currentTime = 0;
  media.duration = Number.NaN;
  media.src = '';
  media.loadMode = 'ok';
  media.loadModes = [];
  media.playError = null;
  fetchHandler = (body) => ({ ok: true, payload: { url: urlFor(String(body.noteId)) } });
  stubFetch();
  stubMedia();
  vi.stubGlobal('MediaError', { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['readyState', 'duration', 'currentTime', 'src']) {
    delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

describe('SummaryHistory signed audio URL', () => {
  it('preloads the signed URL for the selected note with its id and the Microsoft token', async () => {
    await mountLoaded();
    await selectNote('Alpha note');
    await waitFor(() => expect(signedFetches()).toHaveLength(1));
    expect(signedFetches()[0].url).toBe('https://example.test/functions/v1/note-audio-url');
    expect(signedFetches()[0].body).toEqual({ noteId: 'n1' });
    expect(signedFetches()[0].headers).toMatchObject({
      'Content-Type': 'application/json',
      apikey: 'anon',
      Authorization: 'Bearer anon',
      'x-ms-access-token': 'ms-token',
    });
  });

  it('uses the app token and no Microsoft token when one is available', async () => {
    h.appToken = 'app-token';
    await mountLoaded();
    await selectNote('Alpha note');
    await waitFor(() => expect(signedFetches()).toHaveLength(1));
    expect(signedFetches()[0].headers.Authorization).toBe('Bearer app-token');
    expect(signedFetches()[0].headers['x-ms-access-token']).toBeUndefined();
  });

  it('does not preload for a note without any timed segment', async () => {
    await mountLoaded();
    await selectNote('Gamma note');
    await Promise.resolve();
    expect(signedFetches()).toHaveLength(0);
  });

  it('reuses the cached URL for the same note, including after switching away and back, and fetches per note', async () => {
    await mountLoaded();
    await selectNote('Alpha note');
    await waitFor(() => expect(signedFetches()).toHaveLength(1));
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect(media.calls).toContain('play'));
    expect(signedFetches()).toHaveLength(1);
    await selectNote('Beta note');
    await waitFor(() => expect(signedFetches()).toHaveLength(2));
    expect(signedFetches()[1].body).toEqual({ noteId: 'n2' });
    await selectNote('Alpha note');
    await Promise.resolve();
    expect(signedFetches()).toHaveLength(2);
  });

  it('a preload failure is only a warning and a later play requests the URL again', async () => {
    fetchHandler = () => ({ ok: false, payload: { error: 'nope' } });
    await mountLoaded();
    await selectNote('Alpha note');
    await waitFor(() => expect(console.warn).toHaveBeenCalledWith('Could not preload note audio URL:', expect.any(Error)));
    expect(signedFetches()).toHaveLength(1);
    fetchHandler = (body) => ({ ok: true, payload: { url: urlFor(String(body.noteId)) } });
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect(media.calls).toContain('play'));
    expect(signedFetches()).toHaveLength(2);
  });
});

describe('SummaryHistory segment playback', () => {
  async function ready() {
    await mountLoaded();
    await selectNote('Alpha note');
    await waitFor(() => expect(signedFetches()).toHaveLength(1));
  }

  it('plays a timed segment: loads the URL, seeks to the start, plays, and reports state to the editor', async () => {
    await ready();
    expect(playButton('Ann')).toHaveAttribute('data-playable', 'true');
    expect(playButton('Cat')).toHaveAttribute('data-playable', 'false');
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect(media.calls).toContain('play'));
    expect(media.calls).toEqual(expect.arrayContaining([`src:${urlFor('n1')}`, 'load', 'seek:0', 'play']));
    expect(text('pb-active')).toBe('0');
    expect(text('pb-playing')).toBe('true');
    expect(text('pb-label')).toBe('0:00 / 0:04');
    expect(text('pb-loading')).toBe('null');
  });

  it('shows the loading segment while the metadata loads', async () => {
    media.loadMode = 'never';
    await ready();
    fireEvent.click(playButton('Bob'));
    await waitFor(() => expect(text('pb-loading')).toBe('1'));
    expect(text('pb-label')).toBe('0:05');
  });

  it('ignores a segment without a timestamp', async () => {
    await ready();
    fireEvent.click(playButton('Cat'));
    await Promise.resolve();
    expect(media.calls).not.toContain('play');
    expect(text('pb-active')).toBe('null');
  });

  it('clicking the segment that is playing stops it', async () => {
    await ready();
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect(text('pb-playing')).toBe('true'));
    act(() => {
      audio().dispatchEvent(new Event('play'));
    });
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect(text('pb-active')).toBe('null'));
    expect(media.calls).toContain('pause');
  });

  it('resets playback and shows nothing when the segment is outside the audio length', async () => {
    media.duration = 3;
    await ready();
    fireEvent.click(playButton('Bob'));
    await waitFor(() => expect(console.error).toHaveBeenCalledWith('Failed to play transcript segment:', expect.any(Error)));
    expect(errorCalls()[errorCalls().length - 1][1]).toHaveProperty(
      'message',
      'Segment timestamp 0:05 is outside this audio file (0:03).'
    );
    expect(text('pb-active')).toBe('null');
    expect(text('pb-loading')).toBe('null');
    expect(media.calls).not.toContain('play');
  });

  it('re-signs after a load failure and restores the selected segment and stop position', async () => {
    await ready();
    media.loadModes = ['error', 'ok'];
    fetchHandler = () => ({ ok: true, payload: { url: 'https://audio.example/refreshed.mp3' } });
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect(media.calls).toContain('play'));
    expect(signedFetches()).toHaveLength(2);
    expect(media.calls.filter((call) => call === 'load')).toHaveLength(2);
    expect(media.calls).toContain('src:https://audio.example/refreshed.mp3');
    expect(text('pb-active')).toBe('0');
    expect(text('pb-playing')).toBe('true');
    expect(text('pb-loading')).toBe('null');
    media.currentTime = 4.2;
    act(() => audio().dispatchEvent(new Event('timeupdate')));
    expect(text('pb-label')).toBe('0:04 / 0:04');
    expect(text('pb-playing')).toBe('false');
  }, 5000);

  it('resets only after both load attempts fail and never retries a third time', async () => {
    media.loadMode = 'error';
    await ready();
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect(console.error).toHaveBeenCalledWith('Failed to play transcript segment:', expect.any(Error)));
    expect(signedFetches()).toHaveLength(2);
    expect(media.calls.filter((call) => call === 'load')).toHaveLength(2);
    expect(text('pb-active')).toBe('null');
    expect(text('pb-loading')).toBe('null');
    expect(media.calls).not.toContain('play');
  }, 5000);

  it('resets an autoplay rejection without re-signing the already loaded audio', async () => {
    await ready();
    media.playError = new Error('autoplay blocked');
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect(errorCalls().some((call) => (call[1] as Error)?.message === 'autoplay blocked')).toBe(true));
    expect(signedFetches()).toHaveLength(1);
    expect(text('pb-active')).toBe('null');
  }, 5000);

  it('the real page keeps loading until fifteen seconds, retries once and then clears the state', async () => {
    await ready();
    media.loadMode = 'never';
    vi.useFakeTimers();
    let requestsBeforeTimeout = 0;
    let loadingBeforeTimeout: string | null = null;
    try {
      await act(async () => {
        fireEvent.click(playButton('Ann'));
        await vi.advanceTimersByTimeAsync(14999);
      });
      requestsBeforeTimeout = signedFetches().length;
      loadingBeforeTimeout = text('pb-loading');
      await act(async () => { await vi.advanceTimersByTimeAsync(15001); });
    } finally { vi.useRealTimers(); }
    expect(requestsBeforeTimeout).toBe(1);
    expect(loadingBeforeTimeout).toBe('0');
    expect(signedFetches()).toHaveLength(2);
    expect(media.calls.filter((call) => call === 'load')).toHaveLength(2);
    expect(text('pb-active')).toBe('null');
    expect(text('pb-loading')).toBe('null');
    expect(media.calls).not.toContain('play');
  }, 5000);

  it('resets playback when the signed URL cannot be fetched, with the server message or a fallback', async () => {
    await mountLoaded();
    fetchHandler = () => ({ ok: false, status: 403, payload: { error: 'forbidden audio' } });
    await selectNote('Alpha note');
    await waitFor(() => expect(signedFetches()).toHaveLength(1));
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => (c[1] as Error)?.message === 'forbidden audio')).toBe(true));
    fetchHandler = () => ({ ok: false, status: 500, payload: 'not json' });
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => (c[1] as Error)?.message === 'not json')).toBe(true));
    fetchHandler = () => ({ ok: false, status: 500, payload: {} });
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => (c[1] as Error)?.message === 'Audio request failed (500).')).toBe(true));
    fetchHandler = () => ({ ok: true, payload: { url: '  ' } });
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => (c[1] as Error)?.message === 'Audio URL was not returned.')).toBe(true));
    expect(text('pb-active')).toBe('null');
  });

  it('resets playback when no access token is available', async () => {
    h.auth.getAccessToken = async () => null;
    await mountLoaded();
    await selectNote('Alpha note');
    await Promise.resolve();
    fireEvent.click(playButton('Ann'));
    await waitFor(() =>
      expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => (c[1] as Error)?.message === 'Could not get access. Please sign in again.')).toBe(true)
    );
    expect(signedFetches()).toHaveLength(0);
  });

  it('selecting another note stops playback of the first one', async () => {
    await ready();
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect(text('pb-active')).toBe('0'));
    media.calls.length = 0;
    await selectNote('Beta note');
    await waitFor(() => expect(media.calls).toContain('pause'));
    await waitFor(() => expect(screen.getAllByTestId('pb-active')[0].textContent).toBe('null'));
  });
});

describe('SummaryHistory audio element events', () => {
  async function playing() {
    await mountLoaded();
    await selectNote('Alpha note');
    await waitFor(() => expect(signedFetches()).toHaveLength(1));
    fireEvent.click(playButton('Ann'));
    await waitFor(() => expect(text('pb-playing')).toBe('true'));
  }

  it('tracks the current time and stops at the end of the segment', async () => {
    await playing();
    media.currentTime = 2;
    act(() => {
      audio().dispatchEvent(new Event('timeupdate'));
    });
    expect(text('pb-label')).toBe('0:02 / 0:04');
    media.calls.length = 0;
    media.currentTime = 4.2;
    act(() => {
      audio().dispatchEvent(new Event('timeupdate'));
    });
    expect(media.calls).toContain('pause');
    expect(text('pb-playing')).toBe('false');
    expect(text('pb-label')).toBe('0:04 / 0:04');
  });

  it('follows pause, play and ended events', async () => {
    await playing();
    media.currentTime = 1;
    act(() => {
      audio().dispatchEvent(new Event('pause'));
    });
    expect(text('pb-playing')).toBe('false');
    expect(text('pb-label')).toBe('0:01 / 0:04');
    act(() => {
      audio().dispatchEvent(new Event('play'));
    });
    expect(text('pb-playing')).toBe('true');
    act(() => {
      audio().dispatchEvent(new Event('ended'));
    });
    expect(text('pb-playing')).toBe('false');
    expect(text('pb-active')).toBe('0');
  });

  it('an audio error clears the playback state', async () => {
    await playing();
    act(() => {
      audio().dispatchEvent(new Event('error'));
    });
    expect(text('pb-active')).toBe('null');
  });
});
