import { supabase } from '../../config/supabaseConfig';
import { requireOwnerId } from '../requireOwnerId';

// Reads retain their existing RLS visibility; this method only owns owner writes.
export async function updateOwnedNote(input: {
  noteId: string;
  userId: string | null | undefined;
  patch: { summary_edit?: string; name?: string };
}): Promise<void> {
  if (!input.userId?.trim()) throw new Error('인증 정보를 확인한 뒤 다시 시도해 주세요.');
  const { data, error } = await supabase
    .from('note')
    .update(input.patch)
    .eq('id', input.noteId)
    .eq('user_id', input.userId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.id !== input.noteId) {
    throw new Error('노트를 변경하지 못했습니다. 권한이 없을 수 있습니다. 새로고침 후 다시 시도해 주세요.');
  }
}

// ---------------------------------------------------------------------------
// T2-2: every remaining page-level `supabase.from('note')` call lives here.
// These methods keep each call site's exact query and error semantics (raw
// PostgREST errors are thrown unchanged, zero-row handling stays with the caller
// unless a method says otherwise) so the move changes no behavior.
// ---------------------------------------------------------------------------

export type NoteOwnershipFilter = 'all' | 'mine' | 'shared';
export type NoteSortKey = 'meeting_desc' | 'meeting_asc' | 'created_desc' | 'created_asc' | 'title_asc' | 'title_desc';

export interface NotePatch {
  name?: string;
  summary_edit?: string;
  diarization?: unknown;
  diarization_translations?: unknown;
  transcription_translations?: unknown;
}

/** Notes the user owns or that are directly shared with them, newest first. */
export async function listVisibleNotes<T>(userId: string): Promise<T[]> {
  const { data, error } = await supabase
    .from('note')
    .select('*')
    .or(`user_id.eq.${userId},shared_users.cs.{${userId}}`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as T[]) || [];
}

/** Notes tagged with a project, newest first (RLS decides visibility). */
export async function listProjectNotes<T>(projectIdFilterValue: string | number): Promise<T[]> {
  const { data, error } = await supabase
    .from('note')
    .select('*')
    .contains('projects', [projectIdFilterValue])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as T[]) || [];
}

export interface HistoryNotesQuery {
  userId: string;
  chatId?: string | null;
  ownership: NoteOwnershipFilter;
  /** Calendar view only: ISO bounds of the visible window (end exclusive). */
  calendarWindow?: { startIso: string; endIso: string } | null;
  sortKey: NoteSortKey;
  /** Inclusive row range; omit to read every matching row (calendar and search). */
  range?: { from: number; to: number } | null;
}

/** History list query. Returns the raw result so the caller keeps its cancellation and error flow. */
export async function queryHistoryNotes(input: HistoryNotesQuery) {
  const { userId, chatId, ownership, calendarWindow, sortKey, range } = input;
  let query = supabase.from('note').select('*', { count: 'exact' });
  const ownershipFilter = `user_id.eq.${userId},shared_users.cs.{${userId}}`;

  if (chatId) {
    query = query.eq('chat_id', chatId);
  }

  if (ownership === 'mine') {
    query = query.eq('user_id', userId);
  } else if (ownership === 'shared') {
    query = query.neq('user_id', userId).filter('shared_users', 'cs', `{${userId}}`);
  } else {
    query = query.or(ownershipFilter);
  }

  if (calendarWindow) {
    const { startIso, endIso } = calendarWindow;
    query = query.or(
      `and(meeting_at.gte.${startIso},meeting_at.lt.${endIso}),and(meeting_at.is.null,created_at.gte.${startIso},created_at.lt.${endIso})`
    );
  }

  const orderedQuery =
    sortKey === 'title_asc'
      ? query.order('name', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false })
      : sortKey === 'title_desc'
        ? query.order('name', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
        : sortKey === 'created_asc'
          ? query.order('created_at', { ascending: true })
          : sortKey === 'created_desc'
            ? query.order('created_at', { ascending: false })
            : sortKey === 'meeting_asc'
              ? query.order('meeting_at', { ascending: true, nullsFirst: false }).order('created_at', { ascending: true })
              : query.order('meeting_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });

  return range ? await orderedQuery.range(range.from, range.to) : await orderedQuery;
}

/** Owner and current share list of one note. */
export async function getNoteSharing(noteId: string): Promise<{ user_id?: string | null; shared_users?: unknown } | null> {
  const { data, error } = await supabase.from('note').select('user_id, shared_users').eq('id', noteId).single();
  if (error) throw error;
  return data as { user_id?: string | null; shared_users?: unknown } | null;
}

/**
 * Owner-scoped read of a note's saved summary edit (null when none). Throws when the owner
 * cannot see the note, so a caller deciding whether it may replace the summary never mistakes
 * "unreadable" for "unedited" (U1/U9, DEC-0024).
 */
export async function readOwnedNoteSummaryEdit(input: { noteId: string; userId: string }): Promise<string | null> {
  const userId = requireOwnerId(input.userId);
  const { data, error } = await supabase
    .from('note')
    .select('summary_edit')
    .eq('id', input.noteId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Note not found for this owner.');
  const value = (data as { summary_edit?: unknown }).summary_edit;
  return typeof value === 'string' ? value : null;
}

/**
 * Owner-scoped conditional write: saves `text` as summary_edit only while the note has no saved
 * summary edit (null or empty), in one UPDATE. Resolves false when no row matched (an edit was
 * saved meanwhile, or the note is not the owner's), so the caller asks instead of overwriting.
 * A non-empty known value is not compared in the filter: PostgREST filters travel in the URL and a
 * long summary would exceed its length limit; the caller re-reads right before writing instead.
 */
export async function saveOwnedNoteSummaryEditIfUnsaved(input: {
  noteId: string;
  userId: string;
  text: string;
}): Promise<boolean> {
  const userId = requireOwnerId(input.userId);
  const { data, error } = await supabase
    .from('note')
    .update({ summary_edit: input.text })
    .eq('id', input.noteId)
    .eq('user_id', userId)
    .or('summary_edit.is.null,summary_edit.eq.')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/** Owner-scoped share-list write. Unlike updateOwnedNote it does not confirm a changed row (unchanged from the modal's old behavior). */
export async function setNoteSharedUsersAsOwner(input: { noteId: string; userId: string; sharedUsers: string[] }): Promise<void> {
  requireOwnerId(input.userId);
  const { error } = await supabase
    .from('note')
    .update({ shared_users: input.sharedUsers })
    .eq('id', input.noteId)
    .eq('user_id', input.userId);
  if (error) throw error;
}

/** Share-list write without an owner filter (the transcript editor's old behavior; the plan tracks tightening it). */
export async function setNoteSharedUsers(input: { noteId: string; sharedUsers: string[] }): Promise<void> {
  const { error } = await supabase.from('note').update({ shared_users: input.sharedUsers }).eq('id', input.noteId);
  if (error) throw error;
}

/**
 * Update a note and return the confirmed row id, or null when no row changed (RLS denied or note gone).
 * Pass userId to scope the write to the owner. The caller decides what a null result means for its message.
 */
export async function patchNoteReturningId(input: {
  noteId: string;
  patch: NotePatch;
}): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('note')
    .update(input.patch)
    .eq('id', input.noteId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null) ?? null;
}

/** Owner-scoped variant of patchNoteReturningId. A missing or blank userId throws instead of dropping the owner filter. */
export async function patchOwnedNoteReturningId(input: {
  noteId: string;
  userId: string;
  patch: NotePatch;
}): Promise<{ id: string } | null> {
  const userId = requireOwnerId(input.userId);
  const { data, error } = await supabase
    .from('note')
    .update(input.patch)
    .eq('id', input.noteId)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null) ?? null;
}

/** Translated transcript save shared by the three transcript editors. */
export async function saveNoteTranslations(input: {
  noteId: string;
  diarizationTranslations: unknown;
  transcriptionTranslations: unknown;
}): Promise<void> {
  const row = await patchNoteReturningId({
    noteId: input.noteId,
    patch: {
      diarization_translations: input.diarizationTranslations,
      transcription_translations: input.transcriptionTranslations,
    },
  });
  if (!row) throw new Error('Transcript translation save did not update the note.');
}

/** Owner-scoped delete that does not confirm a deleted row (Project page behavior). */
export async function deleteOwnedNote(input: { noteId: string; userId: string }): Promise<void> {
  requireOwnerId(input.userId);
  const { error } = await supabase.from('note').delete().eq('id', input.noteId).eq('user_id', input.userId);
  if (error) throw error;
}

/** Owner-scoped delete returning the deleted row id, or null when nothing was deleted (History page behavior). */
export async function deleteOwnedNoteReturningId(input: { noteId: string; userId: string }): Promise<{ id: string } | null> {
  requireOwnerId(input.userId);
  const { data, error } = await supabase
    .from('note')
    .delete()
    .eq('id', input.noteId)
    .eq('user_id', input.userId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null) ?? null;
}

export { selectAudioReferencePage } from './audioReferencePage';
