import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getEnv } from './env.js';
import { normalizeTranscript, uniqueSpeakersFromSegments } from './transcript.js';

export interface NoteRow {
  id: string;
  user_id?: string | null;
  name?: string | null;
  user_name?: string | null;
  summary?: string | null;
  summary_edit?: string | null;
  transcription?: string | null;
  diarization?: unknown;
  shared_users?: unknown;
  tags?: unknown;
  projects?: Array<string | number> | null;
  chat_id?: string | null;
  created_at?: string | null;
  meeting_at?: string | null;
}

export interface SpeakerRow {
  id: string;
  user_id?: string | null;
  name: string;
  profile?: string | null;
  created_at?: string | null;
}

export interface ProjectRow {
  id: string;
  user_id?: string | null;
  name: string;
  notes?: Array<string | number> | null;
  created_at?: string | null;
}

export interface DataContext {
  supabase: SupabaseClient;
  userId?: string;
}

export const NOTE_METADATA_SELECT = 'id, user_id, name, user_name, tags, projects, chat_id, created_at, meeting_at';
export const NOTE_SUMMARY_SELECT = `${NOTE_METADATA_SELECT}, summary, summary_edit`;
export const NOTE_TRANSCRIPT_SELECT = `${NOTE_SUMMARY_SELECT}, transcription, diarization`;
// For the speaker-segment scan: metadata + diarization ONLY (no full `transcription`
// plain text, no summary). Scanning many notes for one speaker only needs diarization,
// so this roughly halves the bytes pulled per note vs NOTE_TRANSCRIPT_SELECT.
export const NOTE_SPEAKER_SCAN_SELECT = 'id, user_id, name, user_name, created_at, meeting_at, diarization';

let context: DataContext | null = null;
const requestUserIdStorage = new AsyncLocalStorage<string | undefined>();

export function getDataContext(): DataContext {
  if (context) return context;
  const env = getEnv();
  context = {
    supabase: createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    userId: env.meetingNoteUserId,
  };
  return context;
}

export function getScopedUserId(): string | undefined {
  return requestUserIdStorage.getStore() ?? getDataContext().userId;
}

export async function runWithScopedUserId<T>(userId: string | undefined, callback: () => Promise<T>): Promise<T> {
  return requestUserIdStorage.run(userId, callback);
}

function applyUserScope<T>(query: T, userId: string | undefined): T {
  if (!userId) return query;
  return (query as { eq: (column: string, value: string) => T }).eq('user_id', userId);
}

// Only oid / numeric-id shaped tokens are ever interpolated into a PostgREST filter
// string. Anything else is skipped defensively so a stray value can never break (or widen)
// the filter. userIds are Microsoft oids (uuid), project ids are numeric or uuid.
const SAFE_FILTER_TOKEN = /^[A-Za-z0-9_-]+$/;
// Bound the OR-filter size (Power of Ten rule 2). A user shared on more projects than this
// is not expected; extras are dropped (logged by the caller path if ever hit).
const MAX_SHARED_PROJECTS_IN_SCOPE = 200;

// Build the PostgREST `or=` expression that mirrors the app's note_owner_select RLS. MCP runs
// as service_role (RLS bypassed), so the SAME visibility rule must be reproduced here or it
// drifts from the app (M3). Three branches, matching the migration exactly:
//   1. own the note                         user_id = me
//   2. be in the note's shared_users        shared_users @> {me}
//   3. the note is in a project that ITS OWNER shared with me
//        project.user_id = note.user_id AND project.shared_users @> {me} AND note.projects ∋ project.id
// Branch 3 is the one the old two-branch filter missed, so project-shared notes were invisible
// over MCP. Grouping the shared projects by owner reproduces the "project owned by the note's
// owner" constraint precisely (a per-owner `and(user_id.eq.OWNER, projects.ov.{their ids})`),
// and keeps the filter to a handful of terms.
// Resolve the PostgREST `or=` filter STRING for a user (or null when there is no scoped user,
// i.e. the trusted static-key path that sees everything). Returns a plain string so callers can
// `await` it WITHOUT touching the query builder — awaiting the builder itself would execute the
// query (it is a thenable) and drop the chain.
export async function noteAccessFilter(userId: string | undefined): Promise<string | null> {
  if (!userId || !SAFE_FILTER_TOKEN.test(userId)) return null;
  return noteAccessOrExpression(userId);
}

async function noteAccessOrExpression(userId: string): Promise<string> {
  const terms = [`user_id.eq.${userId}`, `shared_users.cs.{${userId}}`];
  try {
    const { supabase } = getDataContext();
    const { data, error } = await supabase
      .from('project')
      .select('id, user_id')
      .contains('shared_users', [userId])
      .limit(MAX_SHARED_PROJECTS_IN_SCOPE);
    if (error) throw error;
    const idsByOwner = new Map<string, string[]>();
    for (const row of (data as Array<{ id: unknown; user_id: unknown }>) ?? []) {
      const owner = typeof row.user_id === 'string' ? row.user_id : '';
      const projectId = row.id == null ? '' : String(row.id);
      if (!SAFE_FILTER_TOKEN.test(owner) || !SAFE_FILTER_TOKEN.test(projectId)) continue;
      const list = idsByOwner.get(owner) ?? [];
      list.push(projectId);
      idsByOwner.set(owner, list);
    }
    for (const [owner, ids] of idsByOwner) {
      if (ids.length > 0) terms.push(`and(user_id.eq.${owner},projects.ov.{${ids.join(',')}})`);
    }
  } catch (error) {
    // Fail SAFE: on any lookup error keep the two direct-access branches (never widen, never
    // throw the whole tool call). Worst case degrades to the pre-M3 behavior for this request.
    // Log it so a PERSISTENT failure (which silently narrows every user's shared-project
    // visibility) is observable instead of invisible.
    console.warn(`[noteAccessOrExpression] shared-project lookup failed, degrading to direct-access only: ${error instanceof Error ? error.message : String(error)}`);
  }
  return terms.join(',');
}

// Apply a pre-resolved note-access filter (from noteAccessFilter). Sync + never awaits the
// builder, so the query chain stays intact. Null filter (no scoped user) = no scoping.
export function applyNoteAccessScope<T>(query: T, orFilter: string | null): T {
  if (!orFilter) return query;
  return (query as { or: (filters: string) => T }).or(orFilter);
}

export function toIdValue(id: string): string | number {
  const asNumber = Number(id);
  return Number.isNaN(asNumber) ? id : asNumber;
}

export function getNoteTitle(note: NoteRow): string {
  return note.name?.trim() || note.user_name?.trim() || 'Untitled note';
}

export function getNoteSummary(note: NoteRow): string {
  return (note.summary_edit?.trim() || note.summary?.trim() || '').trim();
}

export function getNoteTranscriptText(note: NoteRow): string {
  const plain = note.transcription?.trim();
  if (plain) return plain;
  const segments = normalizeTranscript(note.diarization);
  return segments.length ? segments.map((s) => `${s.speaker}: ${s.text}`).join('\n\n') : '';
}

export function getNoteTags(note: NoteRow): string[] {
  const raw = note.tags;
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === 'string' ? item : String((item as Record<string, unknown>)?.label ?? item ?? '')))
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      return getNoteTags({ ...note, tags: JSON.parse(trimmed) as unknown });
    } catch {
      return trimmed.split(',').map((tag) => tag.trim()).filter(Boolean);
    }
  }
  return [];
}

export function summarizeNote(note: NoteRow) {
  const hasTranscriptionField = Object.prototype.hasOwnProperty.call(note, 'transcription');
  const hasDiarizationField = Object.prototype.hasOwnProperty.call(note, 'diarization');
  // Whether transcript/speaker availability was actually looked up. When a list
  // query selects only metadata/summary columns, the transcript columns are
  // absent and we must NOT claim they are empty. Reporting hasTranscript:false /
  // speakers:[] in that case made Claude wrongly conclude "this meeting has no
  // transcript." Report null (unknown) instead, so callers fetch when needed.
  const transcriptChecked = hasTranscriptionField || hasDiarizationField;
  const base = {
    id: note.id,
    title: getNoteTitle(note),
    createdAt: note.created_at ?? null,
    meetingAt: note.meeting_at ?? null,
    tags: getNoteTags(note),
    projects: note.projects ?? [],
    chatId: note.chat_id ?? null,
    hasSummary: Boolean(getNoteSummary(note)),
  };

  if (!transcriptChecked) {
    return {
      ...base,
      transcriptChecked: false as const,
      speakers: null,
      hasPlainTranscript: null,
      hasDiarizedTranscript: null,
      transcriptCharacters: null,
    };
  }

  const segments = hasDiarizationField ? normalizeTranscript(note.diarization) : [];
  const transcriptText = note.transcription?.trim() ?? (hasDiarizationField ? getNoteTranscriptText(note) : '');
  return {
    ...base,
    transcriptChecked: true as const,
    speakers: uniqueSpeakersFromSegments(segments),
    hasPlainTranscript: Boolean(note.transcription?.trim()),
    hasDiarizedTranscript: segments.length > 0,
    transcriptCharacters: transcriptText.length,
  };
}

export async function fetchNote(noteId: string, select = NOTE_TRANSCRIPT_SELECT): Promise<NoteRow | null> {
  const { supabase } = getDataContext();
  const userId = getScopedUserId();
  let query = supabase.from('note').select(select).eq('id', noteId).limit(1);
  query = applyNoteAccessScope(query, await noteAccessFilter(userId));
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as NoteRow | null) ?? null;
}

export async function fetchSpeakerByIdOrName(input: { speakerId?: string; speakerName?: string }): Promise<SpeakerRow | null> {
  const { supabase } = getDataContext();
  const userId = getScopedUserId();
  let query = supabase.from('speaker').select('id, user_id, name, profile, created_at').limit(1);
  query = input.speakerId ? query.eq('id', input.speakerId) : query.ilike('name', input.speakerName ?? '');
  query = applyUserScope(query, userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as SpeakerRow | null) ?? null;
}

export async function fetchProject(projectId: string): Promise<ProjectRow | null> {
  const { supabase } = getDataContext();
  const userId = getScopedUserId();
  let query = supabase.from('project').select('id, user_id, name, notes, created_at').eq('id', projectId).limit(1);
  query = applyUserScope(query, userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as ProjectRow | null) ?? null;
}
