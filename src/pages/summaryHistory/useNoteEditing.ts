import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { patchOwnedNoteReturningId, saveNoteTranslations } from '../../lib/notes/repository';
import { persistNoteDiarization, type TranscriptLanguage, type TranscriptSegment } from '../../lib/transcriptSegments';
import { updateTranslationMap } from '../../lib/transcriptTranslationDisplay';
import { getLocalizedSummary, getNoteDisplayTitle } from './noteDisplay';
import type { Note } from './types';

export interface UseNoteEditingOptions {
  /** Signed-in user id; owner-scoped writes are skipped without it. */
  userId: string | undefined;
  appLanguage: 'en' | 'ko';
  /** The list owns the notes; local edits are applied to it after a confirmed write. */
  setNotes: Dispatch<SetStateAction<Note[]>>;
  /** Shared list-level action error line (rename failures; cleared when an edit starts). */
  setActionError: (message: string | null) => void;
  /** Closes the row action menu when a rename starts from it. */
  closeNoteMenu: () => void;
}

/**
 * Note editing in the history page: summary edit, row rename, detail-pane title edit and transcript
 * persistence. Each write is owner-scoped; a zero-row result becomes a visible permission error and
 * local state only changes after the write is confirmed.
 */
export function useNoteEditing(options: UseNoteEditingOptions) {
  const { userId, appLanguage, setNotes, setActionError, closeNoteMenu } = options;

  // Summary edit
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState('');
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null);
  const [noteEditError, setNoteEditError] = useState<string | null>(null);
  // Row rename
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null);
  const [renameNoteDraft, setRenameNoteDraft] = useState('');
  // Detail-pane title edit
  const detailTitleInputRef = useRef<HTMLInputElement | null>(null);
  const [editingDetailTitleNoteId, setEditingDetailTitleNoteId] = useState<string | null>(null);
  const [detailTitleDraft, setDetailTitleDraft] = useState('');

  const startDetailTitleEdit = (note: Note, selectAll = false) => {
    setEditingDetailTitleNoteId(note.id);
    setDetailTitleDraft(getNoteDisplayTitle(note));
    window.requestAnimationFrame(() => {
      detailTitleInputRef.current?.focus();
      if (selectAll) detailTitleInputRef.current?.select();
    });
  };

  const saveDetailTitleEdit = async (note: Note) => {
    if (editingDetailTitleNoteId !== note.id || !userId) return;
    const name = detailTitleDraft.trim();
    if (!name || name === getNoteDisplayTitle(note)) {
      setEditingDetailTitleNoteId(null);
      setDetailTitleDraft('');
      return;
    }

    try {
      setActionError(null);
      const data = await patchOwnedNoteReturningId({ noteId: note.id, userId, patch: { name } });
      // 0 rows updated (e.g. a shared note you don't own): the write silently
      // no-ops under RLS, so surface it instead of faking success.
      if (!data) throw new Error('Could not rename this note. You may not have permission to edit it.');
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, name } : n)));
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to rename note');
    } finally {
      setEditingDetailTitleNoteId(null);
      setDetailTitleDraft('');
    }
  };

  const startNoteEdit = (note: Note) => {
    setEditingNoteId(note.id);
    setNoteEditDraft(getLocalizedSummary(note, appLanguage));
    setNoteEditError(null);
  };

  const saveNoteEdit = async (note: Note) => {
    if (!userId) return;
    setSavingNoteId(note.id);
    setNoteEditError(null);
    try {
      const data = await patchOwnedNoteReturningId({ noteId: note.id, userId, patch: { summary_edit: noteEditDraft } });
      // 0 rows updated (e.g. a shared note you don't own): don't fake success.
      if (!data) throw new Error('Could not save your edit. You may not have permission to edit this note.');

      setNotes((prev) =>
        prev.map((n) => (n.id === note.id ? { ...n, summary_edit: noteEditDraft } : n))
      );
      setEditingNoteId(null);
    } catch (err: unknown) {
      setNoteEditError(err instanceof Error ? err.message : 'Failed to save note edit');
    } finally {
      setSavingNoteId(null);
    }
  };

  const startRenameNote = (note: Note) => {
    closeNoteMenu();
    setActionError(null);
    setRenamingNoteId(note.id);
    setRenameNoteDraft(note.name?.trim() || '');
  };

  const saveRenameNote = async (noteId: string) => {
    if (!userId) return;
    const name = renameNoteDraft.trim();
    if (!name) {
      setActionError('Note name is required.');
      return;
    }
    try {
      setActionError(null);
      const data = await patchOwnedNoteReturningId({ noteId, userId, patch: { name } });
      // 0 rows updated (e.g. a shared note you don't own): don't fake success.
      if (!data) throw new Error('Could not rename this note. You may not have permission to edit it.');
      setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, name } : n)));
      setRenamingNoteId(null);
      setRenameNoteDraft('');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to rename note');
    }
  };

  const persistDisplayedTranscript = async (note: Note, language: TranscriptLanguage, next: TranscriptSegment[]) => {
    if (language === 'original') {
      await persistNoteDiarization(note.id, next);
      return;
    }
    const nextTranslations = updateTranslationMap(note.diarization_translations, language, next);
    await saveNoteTranslations({
      noteId: note.id,
      diarizationTranslations: nextTranslations,
      transcriptionTranslations: {
        ...(note.transcription_translations ?? {}),
        [language]: next.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n'),
      },
    });
  };

  const updateDisplayedTranscript = (note: Note, language: TranscriptLanguage, next: TranscriptSegment[]) => {
    setNotes((prev) =>
      prev.map((item) => {
        if (item.id !== note.id) return item;
        if (language === 'original') return { ...item, diarization: next };
        return {
          ...item,
          diarization_translations: updateTranslationMap(item.diarization_translations, language, next),
          transcription_translations: {
            ...(item.transcription_translations ?? {}),
            [language]: next.map((segment) => `${segment.speaker}: ${segment.text}`).join('\n\n'),
          },
        };
      })
    );
  };

  return {
    editingNoteId,
    setEditingNoteId,
    noteEditDraft,
    setNoteEditDraft,
    savingNoteId,
    noteEditError,
    renamingNoteId,
    setRenamingNoteId,
    renameNoteDraft,
    setRenameNoteDraft,
    detailTitleInputRef,
    editingDetailTitleNoteId,
    setEditingDetailTitleNoteId,
    detailTitleDraft,
    setDetailTitleDraft,
    startDetailTitleEdit,
    saveDetailTitleEdit,
    startNoteEdit,
    saveNoteEdit,
    startRenameNote,
    saveRenameNote,
    persistDisplayedTranscript,
    updateDisplayedTranscript,
  };
}
