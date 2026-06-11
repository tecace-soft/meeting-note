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

export type McpScope = 'notes:metadata' | 'notes:summary' | 'notes:transcript';

export interface RequestAuthContext {
  userId?: string;
  authMethod?: 'personal-token' | 'oauth' | 'static-dev' | 'env-dev';
  tokenId?: string;
  scopes?: McpScope[];
}

let context: DataContext | null = null;
const requestAuthStorage = new AsyncLocalStorage<RequestAuthContext>();

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
  return requestAuthStorage.getStore()?.userId ?? getDataContext().userId;
}

export function getScopedAuthContext(): RequestAuthContext {
  const userId = getScopedUserId();
  return {
    userId,
    ...requestAuthStorage.getStore(),
  };
}

export function hasMcpScope(scope: McpScope): boolean {
  const scopes = getScopedAuthContext().scopes;
  return !scopes || scopes.includes(scope);
}

export async function runWithScopedUserId<T>(userId: string | undefined, callback: () => Promise<T>): Promise<T> {
  return runWithScopedAuthContext({ userId }, callback);
}

export async function runWithScopedAuthContext<T>(
  authContext: RequestAuthContext,
  callback: () => Promise<T>,
): Promise<T> {
  return requestAuthStorage.run(authContext, callback);
}

function applyUserScope<T>(query: T, userId: string | undefined): T {
  if (!userId) return query;
  return (query as { eq: (column: string, value: string) => T }).eq('user_id', userId);
}

export function applyNoteAccessScope<T>(query: T, userId: string | undefined): T {
  if (!userId) return query;
  return (query as { or: (filters: string) => T }).or(`user_id.eq.${userId},shared_users.cs.{${userId}}`);
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
  const segments = normalizeTranscript(note.diarization);
  const transcriptText = getNoteTranscriptText(note);
  return {
    id: note.id,
    title: getNoteTitle(note),
    createdAt: note.created_at ?? null,
    meetingAt: note.meeting_at ?? null,
    tags: getNoteTags(note),
    projects: note.projects ?? [],
    chatId: note.chat_id ?? null,
    speakers: uniqueSpeakersFromSegments(segments),
    hasSummary: Boolean(getNoteSummary(note)),
    hasPlainTranscript: Boolean(note.transcription?.trim()),
    hasDiarizedTranscript: segments.length > 0,
    transcriptCharacters: transcriptText.length,
  };
}

export async function fetchNote(noteId: string): Promise<NoteRow | null> {
  const { supabase } = getDataContext();
  const userId = getScopedUserId();
  let query = supabase.from('note').select('*').eq('id', noteId).limit(1);
  query = applyNoteAccessScope(query, userId);
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
