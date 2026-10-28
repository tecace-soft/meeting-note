import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  appToken: null as string | null,
  select: null as unknown as ReturnType<typeof vi.fn>,
  update: null as unknown as ReturnType<typeof vi.fn>,
  insert: null as unknown as ReturnType<typeof vi.fn>,
  invoke: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('../../config/supabaseConfig', () => ({
  getSupabaseAccessTokenForRequest: async () => h.appToken,
  SUPABASE_URL: 'https://example.test',
  SUPABASE_ANON_KEY: 'anon',
}));
vi.mock('../../lib/speakers/repository', () => {
  h.select = vi.fn();
  h.update = vi.fn();
  h.insert = vi.fn();
  return {
    selectSpeakersByNames: (...a: unknown[]) => h.select(...a),
    updateSpeakerProfileReturningId: (...a: unknown[]) => h.update(...a),
    insertSpeaker: (...a: unknown[]) => h.insert(...a),
  };
});
vi.mock('./generateProfile', () => {
  h.invoke = vi.fn();
  return { invokeGenerateProfile: (...a: unknown[]) => h.invoke(...a) };
});

import { useNoteSpeakers } from './useNoteSpeakers';
import type { Note } from './types';

const SEGS = [
  { speaker: 'Ann', text: 'hello', start: 0, end: 1 },
  { speaker: 'Bob', text: 'hi', start: 1, end: 2 },
  { speaker: 'Speaker A', text: 'who', start: 2, end: 3 },
];
const NOTE: Note = { id: 'n1', name: 'Alpha', user_id: 'u1', user_name: 'Me', diarization: SEGS };
const TEXT = 'Ann: hello\n\nBob: hi\n\nSpeaker A: who';

function setup(opts: { userId?: string | null; token?: string | null } = {}) {
  const closeNoteMenu = vi.fn();
  const getAccessToken = vi.fn(async () => (opts.token === undefined ? 'ms' : opts.token));
  const view = renderHook(() =>
    useNoteSpeakers({ userId: opts.userId === null ? undefined : opts.userId ?? 'u1', getAccessToken, closeNoteMenu })
  );
  return { ...view, closeNoteMenu, getAccessToken };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  h.appToken = null;
  h.select.mockReset();
  h.select.mockResolvedValue({ data: [{ id: 'sp-ann', name: 'Ann', profile: ' {"old":1} ' }], error: null });
  h.update.mockReset();
  h.insert.mockReset();
  h.invoke.mockReset();
  h.invoke.mockResolvedValue({ profile: '{"x":1}' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useNoteSpeakers open and generate', () => {
  it('moves finding -> generating -> ready and builds a draft per speaker', async () => {
    const lookup = deferred<{ data: unknown[]; error: null }>();
    h.select.mockReturnValue(lookup.promise);
    const { result, closeNoteMenu } = setup();
    let opening!: Promise<void>;
    act(() => {
      opening = result.current.openProfileModal(NOTE);
    });
    expect(closeNoteMenu).toHaveBeenCalled();
    expect(result.current.profileModalNoteId).toBe('n1');
    expect(result.current.profileGenStep).toBe('finding-speakers');
    await act(async () => {
      lookup.resolve({ data: [{ id: 'sp-ann', name: 'Ann', profile: ' {"old":1} ' }], error: null });
      await opening;
    });
    expect(result.current.profileGenStep).toBe('ready');
    expect(h.select).toHaveBeenCalledWith('u1', ['Ann', 'Bob', 'Speaker A'], 'id, name, profile');
    const ann = result.current.generatedProfiles.find((p) => p.speakerName === 'Ann')!;
    const bob = result.current.generatedProfiles.find((p) => p.speakerName === 'Bob')!;
    expect(ann).toMatchObject({ speakerId: 'sp-ann', isNew: false, saving: false, saved: false, saveError: null });
    expect(bob).toMatchObject({ speakerId: null, isNew: true });
    expect(ann.draft).toContain('schema_version');
    expect(h.invoke).toHaveBeenCalledWith(
      { speakerName: 'Ann', speakerId: 'sp-ann', transcriptText: TEXT, existingProfile: '{"old":1}' },
      { appToken: null, msToken: 'ms' }
    );
    expect(h.invoke).toHaveBeenCalledWith(
      { speakerName: 'Bob', speakerId: '', transcriptText: TEXT, existingProfile: null },
      { appToken: null, msToken: 'ms' }
    );
  });

  it('prefers the app token over a Microsoft token', async () => {
    h.appToken = 'app';
    const { result, getAccessToken } = setup();
    await act(async () => result.current.openProfileModal(NOTE));
    expect(h.invoke.mock.calls[0][1]).toEqual({ appToken: 'app', msToken: null });
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('errors for a note without a usable diarized transcript, without querying', async () => {
    const { result } = setup();
    await act(async () => result.current.openProfileModal({ ...NOTE, diarization: null }));
    expect(result.current.profileGenStep).toBe('error');
    expect(result.current.profileGenError).toBe('No diarized transcription found for this note.');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('errors on a speaker lookup failure', async () => {
    h.select.mockResolvedValue({ data: null, error: new Error('lookup down') });
    const { result } = setup();
    await act(async () => result.current.openProfileModal(NOTE));
    expect(result.current.profileGenStep).toBe('error');
    expect(result.current.profileGenError).toBe('lookup down');
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('uses the generic message for a non-Error failure', async () => {
    h.select.mockResolvedValue({ data: null, error: { message: 'raw' } });
    const { result } = setup();
    await act(async () => result.current.openProfileModal(NOTE));
    expect(result.current.profileGenError).toBe('Profile generation failed');
  });

  it('errors when neither token is available', async () => {
    const { result } = setup({ token: null });
    await act(async () => result.current.openProfileModal(NOTE));
    expect(result.current.profileGenError).toBe('Could not get access. Please sign in again.');
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('names the speaker for an invoke failure and for an error field', async () => {
    h.invoke.mockImplementation(async (body: { speakerName: string }) => {
      if (body.speakerName === 'Bob') throw new Error('model down');
      return { profile: '{}' };
    });
    const { result } = setup();
    await act(async () => result.current.openProfileModal(NOTE));
    expect(result.current.profileGenError).toBe('Edge function error for "Bob": model down');
    h.invoke.mockReset();
    h.invoke.mockResolvedValue({ error: 'bad' });
    await act(async () => result.current.openProfileModal(NOTE));
    expect(result.current.profileGenError).toMatch(/^Profile error for ".*": bad$/);
  });

  it('ignores a generation that finishes after unmount without errors', async () => {
    const lookup = deferred<{ data: unknown[]; error: null }>();
    h.select.mockReturnValue(lookup.promise);
    const { result, unmount } = setup();
    let opening!: Promise<void>;
    act(() => {
      opening = result.current.openProfileModal(NOTE);
    });
    unmount();
    await act(async () => {
      lookup.resolve({ data: [], error: null });
      await opening;
    });
    expect(console.error).not.toHaveBeenCalled();
  });
});

async function ready() {
  const view = setup();
  await act(async () => view.result.current.openProfileModal(NOTE));
  return view;
}

describe('useNoteSpeakers saving one profile', () => {
  it('fails fast without a user, for a non-person name, and for an unknown profile', async () => {
    const { result } = await ready();
    expect(await result.current.saveHistoryProfile('Speaker A')).toEqual({
      ok: false,
      error: '"Speaker A" is not a person name and was not saved as a speaker.',
    });
    expect(await result.current.saveHistoryProfile('Nobody')).toEqual({ ok: false, error: 'Profile "Nobody" not found.' });
    const noUser = setup({ userId: null });
    expect(await noUser.result.current.saveHistoryProfile('Ann')).toEqual({ ok: false, error: 'Missing authenticated user.' });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('updates an existing speaker owner-scoped, shows saving, then saved with the canonical draft', async () => {
    const d = deferred<{ id: string }>();
    h.update.mockReturnValue(d.promise);
    const { result } = await ready();
    let saving!: Promise<{ ok: boolean }>;
    act(() => {
      saving = result.current.saveHistoryProfile('Ann');
    });
    expect(result.current.generatedProfiles.find((p) => p.speakerName === 'Ann')!.saving).toBe(true);
    await act(async () => {
      d.resolve({ id: 'sp-ann' });
      await saving;
    });
    const ann = result.current.generatedProfiles.find((p) => p.speakerName === 'Ann')!;
    expect(ann).toMatchObject({ saving: false, saved: true });
    expect(h.update).toHaveBeenCalledWith({ speakerId: 'sp-ann', userId: 'u1', profile: expect.stringContaining('schema_version') });
    expect(ann.draft).toBe(h.update.mock.calls[0][0].profile);
  });

  it('does not mark saved when no row changed', async () => {
    h.update.mockResolvedValue(null);
    const { result } = await ready();
    let out!: { ok: boolean; error?: string };
    await act(async () => {
      out = await result.current.saveHistoryProfile('Ann');
    });
    expect(out).toEqual({ ok: false, error: 'Could not save the speaker profile. Please refresh and try again.' });
    expect(result.current.generatedProfiles.find((p) => p.speakerName === 'Ann')).toMatchObject({
      saving: false,
      saved: false,
      saveError: 'Could not save the speaker profile. Please refresh and try again.',
    });
  });

  it('inserts a new speaker, and reports an Error or a generic message from a failed insert', async () => {
    h.insert.mockResolvedValueOnce({ error: null });
    const { result } = await ready();
    await act(async () => {
      await result.current.saveHistoryProfile('Bob');
    });
    expect(h.insert).toHaveBeenCalledWith({ userId: 'u1', name: 'Bob', profile: expect.stringContaining('schema_version') });
    expect(result.current.generatedProfiles.find((p) => p.speakerName === 'Bob')!.saved).toBe(true);

    h.insert.mockResolvedValueOnce({ error: new Error('insert denied') });
    const second = await ready();
    await act(async () => {
      await second.result.current.saveHistoryProfile('Bob');
    });
    expect(second.result.current.generatedProfiles.find((p) => p.speakerName === 'Bob')!.saveError).toBe('insert denied');
    h.insert.mockResolvedValueOnce({ error: { message: 'raw' } });
    await act(async () => {
      await second.result.current.saveHistoryProfile('Bob');
    });
    expect(second.result.current.generatedProfiles.find((p) => p.speakerName === 'Bob')!.saveError).toBe('Save failed');
  });
});

describe('useNoteSpeakers save all', () => {
  it('with nothing unsaved it succeeds and closes the modal', async () => {
    const { result } = setup();
    await act(async () => result.current.confirmSaveAllProfiles());
    expect(result.current.saveAllStatus).toBe('success');
    expect(result.current.saveAllErrorDetails).toEqual([]);
    expect(result.current.profileModalNoteId).toBeNull();
  });

  it('saves person profiles, lists failures, and keeps the modal open on failure', async () => {
    h.update.mockResolvedValue({ id: 'sp-ann' });
    h.insert.mockResolvedValue({ error: null });
    const { result } = await ready();
    await act(async () => result.current.confirmSaveAllProfiles());
    expect(result.current.saveAllStatus).toBe('error');
    expect(result.current.saveAllErrorDetails).toEqual(['Speaker A: "Speaker A" is not a person name and was not saved as a speaker.']);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(result.current.profileModalNoteId).toBe('n1');
  });

  it('succeeds and closes when every profile saves', async () => {
    h.select.mockResolvedValue({ data: [], error: null });
    h.insert.mockResolvedValue({ error: null });
    const view = setup();
    await act(async () => view.result.current.openProfileModal({ ...NOTE, diarization: SEGS.slice(0, 2) }));
    await act(async () => view.result.current.confirmSaveAllProfiles());
    await waitFor(() => expect(view.result.current.saveAllStatus).toBe('success'));
    expect(view.result.current.profileModalNoteId).toBeNull();
  });
});
