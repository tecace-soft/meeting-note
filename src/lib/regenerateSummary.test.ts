import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ selectSpeakersByNames: null as unknown as ReturnType<typeof vi.fn> }));
vi.mock('./speakers/repository', () => {
  h.selectSpeakersByNames = vi.fn();
  return { selectSpeakersByNames: (...a: unknown[]) => h.selectSpeakersByNames(...a) };
});
import { loadSpeakerProfilesForSummary, requestRegeneratedSummary } from './regenerateSummary';

const base = {
  apiUrl: 'https://workflow.example.test',
  token: 'token',
  noteId: 'n1',
  diarization: [{ speaker: 'Andrew', speakerKey: 'Speaker A', text: 'hi' }],
  previousSummary: 'Old',
  speakerProfiles: [],
  instructions: '',
  promptId: '7',
  persist: false,
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('requestRegeneratedSummary', () => {
  it('posts the named transcript with persist and returns summary and persisted', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ summary: 'New', persisted: false }), { status: 200 }));
    expect(await requestRegeneratedSummary(base)).toEqual({ summary: 'New', persisted: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://workflow.example.test/regenerate-summary');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');
    expect(JSON.parse(String(init.body))).toEqual({
      noteId: 'n1',
      diarization: base.diarization,
      previousSummary: 'Old',
      speakerProfiles: [],
      instructions: '',
      promptId: '7',
      persist: false,
    });
  });

  it('reports persisted null when an older server does not say', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ summary: 'New' }), { status: 200 }));
    expect(await requestRegeneratedSummary(base)).toEqual({ summary: 'New', persisted: null });
  });

  it('throws the server error message', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'You do not have access' }), { status: 403 }));
    await expect(requestRegeneratedSummary(base)).rejects.toThrow('You do not have access');
  });

  it('throws when the server returns no summary', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ summary: '  ' }), { status: 200 }));
    await expect(requestRegeneratedSummary(base)).rejects.toThrow(/No summary/);
  });

  it('throws without a configured API url', async () => {
    await expect(requestRegeneratedSummary({ ...base, apiUrl: '' })).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out instead of waiting forever', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })
    );
    const pending = requestRegeneratedSummary({ ...base, timeoutMs: 1000 });
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it('rethrows an AbortError when the caller aborts', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })
    );
    const pending = requestRegeneratedSummary({ ...base, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('loadSpeakerProfilesForSummary', () => {
  it('loads the profiles of the named speakers and parses JSON profiles', async () => {
    h.selectSpeakersByNames.mockResolvedValue({
      data: [
        { name: 'Andrew', profile: '{"role":"PM"}' },
        { name: 'Hansoo', profile: 'plain text' },
        { name: 'Empty', profile: null },
      ],
      error: null,
    });
    const profiles = await loadSpeakerProfilesForSummary('u1', [
      { speaker: 'Andrew', text: 'a' },
      { speaker: 'Hansoo', text: 'b' },
      { speaker: 'Andrew', text: 'c' },
    ]);
    expect(h.selectSpeakersByNames).toHaveBeenCalledWith('u1', ['Andrew', 'Hansoo'], 'name, profile');
    expect(profiles).toEqual([
      { speakerName: 'Andrew', profile: { role: 'PM' } },
      { speakerName: 'Hansoo', profile: 'plain text' },
    ]);
  });

  it('logs a lookup error and continues without profiles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.selectSpeakersByNames.mockResolvedValue({ data: null, error: { message: 'down' } });
    expect(await loadSpeakerProfilesForSummary('u1', [{ speaker: 'Andrew', text: 'a' }])).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
