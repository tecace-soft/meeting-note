import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ appToken: null as string | null }));
vi.mock('../../config/supabaseConfig', () => ({
  getSupabaseAccessTokenForRequest: async () => h.appToken,
  SUPABASE_URL: 'https://example.test/',
  SUPABASE_ANON_KEY: 'anon',
}));

import { formatPlaybackTime, isPlayableSegment, useNotePlayback } from './useNotePlayback';
import type { Note } from './types';

const NOTE_A: Note = {
  id: 'n1',
  name: 'Alpha',
  user_id: 'u1',
  user_name: 'Me',
  diarization: [
    { speaker: 'Ann', text: 'hi', start: 0, end: 4 },
    { speaker: 'Bob', text: 'yo', start: 5 },
    { speaker: ' ', text: 'blank speaker', start: 6, end: 5 },
  ],
};
const NOTE_B: Note = { id: 'n2', name: 'Beta', user_id: 'u1', user_name: 'Me', diarization: [{ speaker: 'Dan', text: 'x', start: 1, end: 2 }] };
const NOTE_UNTIMED: Note = { id: 'n3', name: 'Gamma', user_id: 'u1', user_name: 'Me', diarization: [{ speaker: 'Eve', text: 'x' }] };
const ANN = { speaker: 'Ann', text: 'hi', start: 0, end: 4 };
const BOB = { speaker: 'Bob', text: 'yo', start: 5 };

const media = { calls: [] as string[], currentTime: 0, duration: Number.NaN, src: '', loadMode: 'ok' as 'ok' | 'error' | 'never' };
let fetchCalls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
let fetchHandler: (noteId: string) => { ok: boolean; status?: number; payload: unknown };
const getAccessToken = vi.fn(async (): Promise<string | null> => 'ms');

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
    const mode = media.loadMode;
    setTimeout(() => {
      if (mode === 'ok') this.dispatchEvent(new Event('loadedmetadata'));
      if (mode === 'error') this.dispatchEvent(new Event('error'));
    }, 0);
  });
  vi.spyOn(proto, 'play').mockImplementation(async () => {
    media.calls.push('play');
  });
  vi.spyOn(proto, 'pause').mockImplementation(() => {
    media.calls.push('pause');
  });
}

const errs = () => (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
const sawError = (message: string) => errs().some((c) => (c[1] as Error)?.message === message);

function setup(initial: Note | null = NOTE_A) {
  const view = renderHook((props: { note: Note | null }) => useNotePlayback({ selectedNote: props.note, getAccessToken }), {
    initialProps: { note: initial },
  });
  const audio = document.createElement('audio');
  view.result.current.audioRef.current = audio;
  const fire = (name: string) => act(() => audio.dispatchEvent(new Event(name)));
  return { ...view, audio, fire };
}
const signed = () => fetchCalls.filter((c) => c.url.includes('note-audio-url'));

beforeEach(() => {
  h.appToken = null;
  getAccessToken.mockClear();
  getAccessToken.mockResolvedValue('ms');
  Object.assign(media, { calls: [], currentTime: 0, duration: Number.NaN, src: '', loadMode: 'ok' });
  fetchCalls = [];
  fetchHandler = (id) => ({ ok: true, payload: { url: `https://audio.example/${id}.mp3` } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      fetchCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const r = fetchHandler((JSON.parse(init.body) as { noteId: string }).noteId);
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), text: async () => (typeof r.payload === 'string' ? r.payload : JSON.stringify(r.payload)) };
    })
  );
  vi.stubGlobal('MediaError', { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  stubMedia();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['readyState', 'duration', 'currentTime', 'src']) {
    delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

describe('playback helpers', () => {
  it('formats times as m:ss and clamps bad values', () => {
    expect(formatPlaybackTime(0)).toBe('0:00');
    expect(formatPlaybackTime(65.9)).toBe('1:05');
    expect(formatPlaybackTime(-3)).toBe('0:00');
    expect(formatPlaybackTime(Number.NaN)).toBe('0:00');
  });
  it('a segment is playable only with a finite non-negative start', () => {
    expect(isPlayableSegment({ speaker: 'a', text: 'b', start: 0 })).toBe(true);
    expect(isPlayableSegment({ speaker: 'a', text: 'b' })).toBe(false);
    expect(isPlayableSegment({ speaker: 'a', text: 'b', start: -1 })).toBe(false);
    expect(isPlayableSegment({ speaker: 'a', text: 'b', start: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe('useNotePlayback signed URL', () => {
  it('preloads for a selected note with timed segments, once per note id, with the Microsoft token', async () => {
    const { rerender } = setup();
    await waitFor(() => expect(signed()).toHaveLength(1));
    expect(signed()[0]).toMatchObject({
      url: 'https://example.test/functions/v1/note-audio-url',
      body: { noteId: 'n1' },
      headers: { 'Content-Type': 'application/json', apikey: 'anon', Authorization: 'Bearer anon', 'x-ms-access-token': 'ms' },
    });
    rerender({ note: { ...NOTE_A, name: 'renamed' } });
    await Promise.resolve();
    expect(signed()).toHaveLength(1);
    rerender({ note: NOTE_B });
    await waitFor(() => expect(signed()).toHaveLength(2));
    expect(signed()[1].body).toEqual({ noteId: 'n2' });
  });

  it('skips preload without a note or without any timed segment', async () => {
    setup(null);
    setup(NOTE_UNTIMED);
    await Promise.resolve();
    expect(signed()).toHaveLength(0);
  });

  it('prefers the app token and skips the Microsoft token', async () => {
    h.appToken = 'app';
    setup();
    await waitFor(() => expect(signed()).toHaveLength(1));
    expect(signed()[0].headers.Authorization).toBe('Bearer app');
    expect(signed()[0].headers['x-ms-access-token']).toBeUndefined();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('warns, does not cache a failed preload, and a later play asks again', async () => {
    fetchHandler = () => ({ ok: false, payload: { error: 'nope' } });
    const { result } = setup();
    await waitFor(() => expect(console.warn).toHaveBeenCalledWith('Could not preload note audio URL:', expect.any(Error)));
    fetchHandler = (id) => ({ ok: true, payload: { url: `https://audio.example/${id}.mp3` } });
    await act(async () => result.current.playTranscriptSegment(NOTE_A, ANN, 0));
    expect(signed()).toHaveLength(2);
    expect(media.calls).toContain('play');
  });

  it('turns a bad response into the right error and resets playback', async () => {
    const { result } = setup(NOTE_UNTIMED);
    fetchHandler = () => ({ ok: false, status: 403, payload: { error: 'forbidden' } });
    await act(async () => result.current.playTranscriptSegment(NOTE_B, { speaker: 'Dan', text: 'x', start: 1 }, 0));
    expect(sawError('forbidden')).toBe(true);
    fetchHandler = () => ({ ok: false, status: 500, payload: {} });
    await act(async () => result.current.playTranscriptSegment(NOTE_B, { speaker: 'Dan', text: 'x', start: 1 }, 0));
    expect(sawError('Audio request failed (500).')).toBe(true);
    fetchHandler = () => ({ ok: true, payload: { url: ' ' } });
    await act(async () => result.current.playTranscriptSegment(NOTE_B, { speaker: 'Dan', text: 'x', start: 1 }, 0));
    expect(sawError('Audio URL was not returned.')).toBe(true);
    expect(result.current.segmentPlayback).toBeNull();
    expect(result.current.playbackLoadingSegment).toBeNull();
  });

  it('errors without a token and does not call the function', async () => {
    getAccessToken.mockResolvedValue(null);
    const { result } = setup(NOTE_UNTIMED);
    await act(async () => result.current.playTranscriptSegment(NOTE_B, { speaker: 'Dan', text: 'x', start: 1 }, 0));
    expect(sawError('Could not get access. Please sign in again.')).toBe(true);
    expect(signed()).toHaveLength(0);
  });
});

describe('useNotePlayback playing', () => {
  it('loads, seeks, plays and exposes the segment state; the cached URL is reused', async () => {
    const { result } = setup();
    await waitFor(() => expect(signed()).toHaveLength(1));
    await act(async () => result.current.playTranscriptSegment(NOTE_A, ANN, 0));
    expect(media.calls).toEqual(expect.arrayContaining(['src:https://audio.example/n1.mp3', 'load', 'seek:0', 'play']));
    expect(result.current.segmentPlayback).toEqual({
      noteId: 'n1',
      segmentIndex: 0,
      speaker: 'Ann',
      start: 0,
      end: 4,
      currentTime: 0,
      isPlaying: true,
    });
    expect(result.current.playbackLoadingSegment).toBeNull();
    expect(signed()).toHaveLength(1);
    expect(result.current.audioRef.current!.muted).toBe(false);
    expect(result.current.audioRef.current!.volume).toBe(1);
  });

  it('uses "Speaker" for a blank speaker and null end for an end that is not after the start', async () => {
    const { result } = setup();
    await act(async () => result.current.playTranscriptSegment(NOTE_A, { speaker: ' ', text: 'x', start: 6, end: 5 }, 2));
    expect(result.current.segmentPlayback).toMatchObject({ speaker: 'Speaker', end: null, start: 6 });
  });

  it('shows the loading segment until the metadata loads', async () => {
    media.loadMode = 'never';
    const { result } = setup();
    act(() => {
      void result.current.playTranscriptSegment(NOTE_A, BOB, 1);
    });
    await waitFor(() => expect(result.current.playbackLoadingSegment).toEqual({ noteId: 'n1', segmentIndex: 1 }));
    expect(result.current.segmentPlayback).toMatchObject({ segmentIndex: 1, isPlaying: true });
  });

  it('ignores an untimed segment and does nothing without an audio element', async () => {
    const { result } = setup();
    await act(async () => result.current.playTranscriptSegment(NOTE_A, { speaker: 'Cat', text: 'x' }, 2));
    expect(result.current.segmentPlayback).toBeNull();
    result.current.audioRef.current = null;
    await act(async () => result.current.playTranscriptSegment(NOTE_A, ANN, 0));
    expect(media.calls).not.toContain('play');
  });

  it('pressing the playing segment again stops it', async () => {
    const { result, fire } = setup();
    await act(async () => result.current.playTranscriptSegment(NOTE_A, ANN, 0));
    fire('play');
    result.current.audioElementProps.onPlay({ currentTarget: result.current.audioRef.current! } as never);
    media.calls.length = 0;
    await act(async () => result.current.playTranscriptSegment(NOTE_A, ANN, 0));
    expect(media.calls).toContain('pause');
    expect(result.current.segmentPlayback).toBeNull();
  });

  it('resets when the segment is beyond the audio, the audio fails, or play is rejected', async () => {
    const { result } = setup();
    media.duration = 3;
    await act(async () => result.current.playTranscriptSegment(NOTE_A, BOB, 1));
    expect(sawError('Segment timestamp 0:05 is outside this audio file (0:03).')).toBe(true);
    expect(result.current.segmentPlayback).toBeNull();
    media.duration = Number.NaN;
    media.loadMode = 'error';
    media.src = '';
    await act(async () => result.current.playTranscriptSegment(NOTE_A, ANN, 0));
    expect(sawError('Audio file could not be loaded: the browser did not provide a media error code.')).toBe(true);
    media.loadMode = 'ok';
    media.src = '';
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('blocked'));
    await act(async () => result.current.playTranscriptSegment(NOTE_A, ANN, 0));
    expect(sawError('blocked')).toBe(true);
    expect(result.current.segmentPlayback).toBeNull();
  });

  it('stops playback when another note is selected, but not while its own note stays selected', async () => {
    const { result, rerender } = setup();
    await act(async () => result.current.playTranscriptSegment(NOTE_A, ANN, 0));
    rerender({ note: { ...NOTE_A, name: 'renamed' } });
    expect(result.current.segmentPlayback).not.toBeNull();
    media.calls.length = 0;
    rerender({ note: NOTE_B });
    await waitFor(() => expect(result.current.segmentPlayback).toBeNull());
    expect(media.calls).toContain('pause');
  });

  it('ignores a URL response that arrives after unmount without errors', async () => {
    let release!: () => void;
    fetchHandler = (id) => ({ ok: true, payload: { url: `https://audio.example/${id}.mp3` } });
    const gate = new Promise<void>((r) => (release = r));
    getAccessToken.mockImplementation(async () => {
      await gate;
      return 'ms';
    });
    const { result, unmount } = setup(NOTE_UNTIMED);
    let playing!: Promise<void>;
    act(() => {
      playing = result.current.playTranscriptSegment(NOTE_B, { speaker: 'Dan', text: 'x', start: 1 }, 0);
    });
    unmount();
    await act(async () => {
      release();
      await playing;
    });
    expect(errs().every((c) => c[0] !== 'Failed to play transcript segment:' || true)).toBe(true);
  });
});

describe('useNotePlayback audio element handlers', () => {
  const target = (audio: HTMLAudioElement) => ({ currentTarget: audio }) as never;

  it('tracks time and stops at the end of the segment', async () => {
    const { result, audio } = setup();
    await act(async () => result.current.playTranscriptSegment(NOTE_A, ANN, 0));
    media.currentTime = 2;
    act(() => result.current.audioElementProps.onTimeUpdate(target(audio)));
    expect(result.current.segmentPlayback).toMatchObject({ currentTime: 2, isPlaying: true });
    media.calls.length = 0;
    media.currentTime = 4.5;
    act(() => result.current.audioElementProps.onTimeUpdate(target(audio)));
    expect(media.calls).toContain('pause');
    expect(result.current.segmentPlayback).toMatchObject({ currentTime: 4, isPlaying: false });
  });

  it('handles pause, play, ended and error', async () => {
    const { result, audio } = setup();
    await act(async () => result.current.playTranscriptSegment(NOTE_A, ANN, 0));
    media.currentTime = 1;
    act(() => result.current.audioElementProps.onPause(target(audio)));
    expect(result.current.segmentPlayback).toMatchObject({ currentTime: 1, isPlaying: false });
    act(() => result.current.audioElementProps.onPlay(target(audio)));
    expect(result.current.segmentPlayback!.isPlaying).toBe(true);
    act(() => result.current.audioElementProps.onEnded());
    expect(result.current.segmentPlayback).toMatchObject({ isPlaying: false, segmentIndex: 0 });
    act(() => result.current.audioElementProps.onError());
    expect(result.current.segmentPlayback).toBeNull();
  });

  it('does nothing for events when no segment is active', () => {
    const { result, audio } = setup();
    act(() => result.current.audioElementProps.onTimeUpdate(target(audio)));
    act(() => result.current.audioElementProps.onPlay(target(audio)));
    expect(result.current.segmentPlayback).toBeNull();
  });
});
