import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  patchOwned: null as unknown as ReturnType<typeof vi.fn>,
  patch: null as unknown as ReturnType<typeof vi.fn>,
  saveTranslations: null as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('../../lib/notes/repository', () => {
  h.patchOwned = vi.fn();
  h.patch = vi.fn();
  h.saveTranslations = vi.fn();
  return {
    patchOwnedNoteReturningId: (...a: unknown[]) => h.patchOwned(...a),
    patchNoteReturningId: (...a: unknown[]) => h.patch(...a),
    saveNoteTranslations: (...a: unknown[]) => h.saveTranslations(...a),
  };
});

import { useNoteEditing } from './useNoteEditing';
import type { Note } from './types';

const N1: Note = { id: 'n1', name: 'Alpha', user_id: 'u1', user_name: 'Me', summary: 'Alpha summary' };
const N2: Note = { id: 'n2', name: 'Beta', user_id: 'u1', user_name: 'Me', summary: 'Beta summary' };
const SEGS = [{ speaker: 'Ann', text: 'hello', start: 0, end: 1 }];

function setup(userIdArg: string | null = 'u1') {
  const userId = userIdArg ?? undefined;
  const setActionError = vi.fn();
  const closeNoteMenu = vi.fn();
  const view = renderHook(() => {
    const [notes, setNotes] = useState<Note[]>([N1, N2]);
    const editing = useNoteEditing({ userId, appLanguage: 'en', setNotes, setActionError, closeNoteMenu });
    return { notes, editing };
  });
  return { ...view, setActionError, closeNoteMenu };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  h.patchOwned.mockReset();
  h.patch.mockReset();
  h.saveTranslations.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useNoteEditing summary edit', () => {
  it('starts with the localized summary as the draft', () => {
    const { result } = setup();
    act(() => result.current.editing.startNoteEdit({ ...N1, summary_edit: 'Edited before' }));
    expect(result.current.editing.editingNoteId).toBe('n1');
    expect(result.current.editing.noteEditDraft).toBe('Edited before');
    expect(result.current.editing.noteEditError).toBeNull();
  });

  it('shows a saving state, writes owner-scoped, applies the edit locally and closes the editor', async () => {
    const d = deferred<{ id: string } | null>();
    h.patchOwned.mockReturnValue(d.promise);
    const { result } = setup();
    act(() => result.current.editing.startNoteEdit(N1));
    act(() => result.current.editing.setNoteEditDraft('New summary'));
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.editing.saveNoteEdit(N1);
    });
    expect(result.current.editing.savingNoteId).toBe('n1');
    expect(h.patchOwned).toHaveBeenCalledWith({ noteId: 'n1', userId: 'u1', patch: { summary_edit: 'New summary' } });
    await act(async () => {
      d.resolve({ id: 'n1' });
      await saving;
    });
    expect(result.current.editing.savingNoteId).toBeNull();
    expect(result.current.editing.editingNoteId).toBeNull();
    expect(result.current.notes[0].summary_edit).toBe('New summary');
    expect(result.current.notes[1].summary_edit).toBeUndefined();
  });

  it('keeps the editor open with a permission error when no row changed', async () => {
    h.patchOwned.mockResolvedValue(null);
    const { result } = setup();
    act(() => result.current.editing.startNoteEdit(N1));
    await act(async () => result.current.editing.saveNoteEdit(N1));
    expect(result.current.editing.noteEditError).toBe('Could not save your edit. You may not have permission to edit this note.');
    expect(result.current.editing.editingNoteId).toBe('n1');
    expect(result.current.editing.savingNoteId).toBeNull();
    expect(result.current.notes[0].summary_edit).toBeUndefined();
  });

  it('uses the generic message for a non-Error rejection', async () => {
    h.patchOwned.mockRejectedValue({ message: 'raw' });
    const { result } = setup();
    await act(async () => result.current.editing.saveNoteEdit(N1));
    expect(result.current.editing.noteEditError).toBe('Failed to save note edit');
  });

  it('does nothing without a user', async () => {
    const { result } = setup(null);
    await act(async () => result.current.editing.saveNoteEdit(N1));
    expect(h.patchOwned).not.toHaveBeenCalled();
    expect(result.current.editing.savingNoteId).toBeNull();
  });

  it('ignores a save that resolves after unmount without errors', async () => {
    const d = deferred<{ id: string } | null>();
    h.patchOwned.mockReturnValue(d.promise);
    const { result, unmount } = setup();
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.editing.saveNoteEdit(N1);
    });
    unmount();
    await act(async () => {
      d.resolve({ id: 'n1' });
      await saving;
    });
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('useNoteEditing row rename', () => {
  it('starting closes the menu, clears the action error and seeds the draft', () => {
    const { result, setActionError, closeNoteMenu } = setup();
    act(() => result.current.editing.startRenameNote(N1));
    expect(closeNoteMenu).toHaveBeenCalled();
    expect(setActionError).toHaveBeenCalledWith(null);
    expect(result.current.editing.renamingNoteId).toBe('n1');
    expect(result.current.editing.renameNoteDraft).toBe('Alpha');
  });

  it('saves owner-scoped, applies the name locally and leaves rename mode', async () => {
    h.patchOwned.mockResolvedValue({ id: 'n1' });
    const { result } = setup();
    act(() => result.current.editing.startRenameNote(N1));
    act(() => result.current.editing.setRenameNoteDraft('  Alpha 2  '));
    await act(async () => result.current.editing.saveRenameNote('n1'));
    expect(h.patchOwned).toHaveBeenCalledWith({ noteId: 'n1', userId: 'u1', patch: { name: 'Alpha 2' } });
    expect(result.current.notes[0].name).toBe('Alpha 2');
    expect(result.current.editing.renamingNoteId).toBeNull();
    expect(result.current.editing.renameNoteDraft).toBe('');
  });

  it('rejects an empty name without writing and stays in rename mode', async () => {
    const { result, setActionError } = setup();
    act(() => result.current.editing.startRenameNote(N1));
    act(() => result.current.editing.setRenameNoteDraft('   '));
    await act(async () => result.current.editing.saveRenameNote('n1'));
    expect(setActionError).toHaveBeenLastCalledWith('Note name is required.');
    expect(h.patchOwned).not.toHaveBeenCalled();
    expect(result.current.editing.renamingNoteId).toBe('n1');
  });

  it('shows the permission error on a zero-row rename and keeps the old name', async () => {
    h.patchOwned.mockResolvedValue(null);
    const { result, setActionError } = setup();
    act(() => result.current.editing.startRenameNote(N1));
    act(() => result.current.editing.setRenameNoteDraft('Nope'));
    await act(async () => result.current.editing.saveRenameNote('n1'));
    expect(setActionError).toHaveBeenLastCalledWith('Could not rename this note. You may not have permission to edit it.');
    expect(result.current.notes[0].name).toBe('Alpha');
    expect(result.current.editing.renamingNoteId).toBe('n1');
  });
});

describe('useNoteEditing detail title edit', () => {
  it('writes a changed title, applies it locally and always leaves edit mode', async () => {
    h.patchOwned.mockResolvedValue({ id: 'n1' });
    const { result } = setup();
    act(() => result.current.editing.startDetailTitleEdit(N1));
    expect(result.current.editing.editingDetailTitleNoteId).toBe('n1');
    expect(result.current.editing.detailTitleDraft).toBe('Alpha');
    act(() => result.current.editing.setDetailTitleDraft('Alpha detail'));
    await act(async () => result.current.editing.saveDetailTitleEdit(N1));
    expect(h.patchOwned).toHaveBeenCalledWith({ noteId: 'n1', userId: 'u1', patch: { name: 'Alpha detail' } });
    expect(result.current.notes[0].name).toBe('Alpha detail');
    expect(result.current.editing.editingDetailTitleNoteId).toBeNull();
    expect(result.current.editing.detailTitleDraft).toBe('');
  });

  it('skips the write for an unchanged or empty title', async () => {
    const { result } = setup();
    act(() => result.current.editing.startDetailTitleEdit(N1));
    await act(async () => result.current.editing.saveDetailTitleEdit(N1));
    act(() => result.current.editing.startDetailTitleEdit(N1));
    act(() => result.current.editing.setDetailTitleDraft('  '));
    await act(async () => result.current.editing.saveDetailTitleEdit(N1));
    expect(h.patchOwned).not.toHaveBeenCalled();
    expect(result.current.editing.editingDetailTitleNoteId).toBeNull();
  });

  it('ignores a save for a note that is not being edited', async () => {
    const { result } = setup();
    await act(async () => result.current.editing.saveDetailTitleEdit(N1));
    expect(h.patchOwned).not.toHaveBeenCalled();
  });

  it('reports a zero-row title write and still leaves edit mode', async () => {
    h.patchOwned.mockResolvedValue(null);
    const { result, setActionError } = setup();
    act(() => result.current.editing.startDetailTitleEdit(N1));
    act(() => result.current.editing.setDetailTitleDraft('Nope'));
    await act(async () => result.current.editing.saveDetailTitleEdit(N1));
    expect(setActionError).toHaveBeenLastCalledWith('Could not rename this note. You may not have permission to edit it.');
    expect(result.current.notes[0].name).toBe('Alpha');
    expect(result.current.editing.editingDetailTitleNoteId).toBeNull();
  });
});

describe('useNoteEditing transcript', () => {
  it('persists the original transcript through patchNoteReturningId and rejects a zero-row result', async () => {
    h.patch.mockResolvedValue({ id: 'n1' });
    const { result } = setup();
    await act(async () => result.current.editing.persistDisplayedTranscript(N1, 'original', SEGS));
    expect(h.patch).toHaveBeenCalledWith({ noteId: 'n1', patch: { diarization: SEGS } });
    h.patch.mockResolvedValue(null);
    await expect(result.current.editing.persistDisplayedTranscript(N1, 'original', SEGS)).rejects.toThrow(
      'Diarization save did not update the note. You may not have permission to edit this note.'
    );
  });

  it('persists a translation with both columns merged onto the existing translations', async () => {
    h.saveTranslations.mockResolvedValue(undefined);
    const note: Note = { ...N1, transcription_translations: { en: 'Ann: hi' }, diarization_translations: { en: SEGS } };
    const { result } = setup();
    const ko = [{ speaker: 'Ann', text: 'annyeong', start: 0, end: 1 }];
    await act(async () => result.current.editing.persistDisplayedTranscript(note, 'ko', ko));
    expect(h.saveTranslations).toHaveBeenCalledWith({
      noteId: 'n1',
      diarizationTranslations: { en: SEGS, ko },
      transcriptionTranslations: { en: 'Ann: hi', ko: 'Ann: annyeong' },
    });
  });

  it('updates the displayed original or translated segments locally, only for that note', async () => {
    const { result } = setup();
    act(() => result.current.editing.updateDisplayedTranscript(N1, 'original', SEGS));
    expect(result.current.notes[0].diarization).toEqual(SEGS);
    expect(result.current.notes[1].diarization).toBeUndefined();
    act(() => result.current.editing.updateDisplayedTranscript(N1, 'ko', SEGS));
    await waitFor(() => expect(result.current.notes[0].diarization_translations).toEqual({ ko: SEGS }));
    expect(result.current.notes[0].transcription_translations).toEqual({ ko: 'Ann: hello' });
  });
});
