import type { SupabaseClient } from '@supabase/supabase-js';

/** Minimal note shape needed to decide whether a note still uses an audio file. */
export interface NoteAudioRef {
  id: string;
  name: string | null;
  audio_file: string | null;
  audio_file_id: string | null;
}

/** Minimal file shape (public.file row) identifying a storage object. */
export interface AudioFileIdentity {
  id: string;
  bucket: string;
  storage_path: string;
}

export const NOTE_REF_PAGE_SIZE = 1000;
export const NOTE_REF_MAX_PAGES = 20;
export const NOTE_REF_QUERY_TIMEOUT_MS = 15000;

const OBJECT_URL_RE = /\/storage\/v1\/object\/(?:sign|public|authenticated)\/([^/?#]+)\/([^?#]+)/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePath(path: string): string {
  return safeDecode(path).replace(/^\/+/, '');
}

/**
 * Extract {bucket, path} from a Supabase storage sign/public/authenticated URL.
 * The query string (?token=...) and fragment are ignored; the path is URL-decoded.
 * Returns null for anything that is not a recognizable storage object URL.
 */
export function parseStorageObjectUrl(url: string | null | undefined): { bucket: string; path: string } | null {
  if (typeof url !== 'string' || !url) return null;
  const match = OBJECT_URL_RE.exec(url);
  if (!match) return null;
  const bucket = safeDecode(match[1]);
  const path = normalizePath(match[2]);
  if (!bucket || !path) return null;
  return { bucket, path };
}

/** True when a note points at the file, via FK or via its stored audio URL. */
export function noteReferencesFile(note: NoteAudioRef, file: AudioFileIdentity): boolean {
  if (!file.id || !file.storage_path || !file.bucket) return false;
  if (note.audio_file_id && note.audio_file_id === file.id) return true;
  const parsed = parseStorageObjectUrl(note.audio_file);
  if (!parsed) return false;
  return parsed.bucket === file.bucket && parsed.path === normalizePath(file.storage_path);
}

/** Pure: notes (from a list) that still reference the given file. */
export function findReferencingNotes(notes: NoteAudioRef[], file: AudioFileIdentity): NoteAudioRef[] {
  return notes.filter((note) => noteReferencesFile(note, file));
}

/**
 * Fetch ALL of the user's notes that have an audio reference (paged, stable
 * order) and return those that use the file.
 *
 * Why paging + exact count instead of a big limit(): PostgREST silently caps
 * responses at the project max_rows, so response length cannot reveal
 * truncation. We request count:'exact' and keep reading (from = rows read so far,
 * so a smaller server cap just means more pages) until read === count.
 * Fail-closed on: query error, timeout, missing/changed count, an empty page
 * before reaching count, or exceeding the page cap.
 */
export async function fetchReferencingNotes(
  client: SupabaseClient,
  userId: string,
  file: AudioFileIdentity,
  timeoutMs: number = NOTE_REF_QUERY_TIMEOUT_MS,
): Promise<NoteAudioRef[]> {
  if (!userId) throw new Error('Missing user id for reference check.');
  if (!file.id || !file.storage_path) throw new Error('Invalid file for reference check.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const notes: NoteAudioRef[] = [];
    let total: number | null = null;
    for (let page = 0; page < NOTE_REF_MAX_PAGES; page += 1) {
      const from = notes.length;
      const { data, error, count } = await client
        .from('note')
        .select('id, name, audio_file, audio_file_id', { count: 'exact' })
        .eq('user_id', userId)
        .or('audio_file_id.not.is.null,audio_file.not.is.null')
        .order('id', { ascending: true })
        .range(from, from + NOTE_REF_PAGE_SIZE - 1)
        .abortSignal(controller.signal);
      if (error) throw error;
      if (typeof count !== 'number') throw new Error('Reference check returned no exact count.');
      if (total !== null && count !== total) throw new Error('Note set changed during reference check.');
      total = count;
      const rows = (data ?? []) as NoteAudioRef[];
      notes.push(...rows);
      if (notes.length >= total) return findReferencingNotes(notes, file);
      if (rows.length === 0) throw new Error('Reference check page was empty before reaching total.');
    }
    throw new Error('Too many notes to verify audio references safely.');
  } finally {
    clearTimeout(timer);
  }
}

/** Thrown when deletion is refused because notes still use the audio. */
export class AudioInUseError extends Error {
  readonly noteTitles: string[];
  constructor(noteTitles: string[]) {
    super('Audio file is still referenced by notes.');
    this.name = 'AudioInUseError';
    this.noteTitles = noteTitles;
  }
}

/** Thrown when the reference lookup itself failed (deletion must not proceed). */
export class ReferenceCheckError extends Error {
  readonly originalError: unknown;
  constructor(cause: unknown) {
    super('Could not verify audio references.');
    this.name = 'ReferenceCheckError';
    this.originalError = cause;
  }
}

export function formatNoteTitles(notes: NoteAudioRef[], untitled: string, max = 3): string[] {
  const titles = notes.map((n) => (n.name && n.name.trim()) || untitled);
  return titles.length > max ? [...titles.slice(0, max), `+${titles.length - max}`] : titles;
}
