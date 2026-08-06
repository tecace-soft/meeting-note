import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/supabaseConfig';
import { getSegmentText, type TranscriptSegment } from './transcriptSegments';
import type { IdentifyAuth } from './identifySpeakers';

// F1c: per-user personal memory — a durable, view-agnostic context base
// aggregated across all of a user's meetings. The `update-user-memory` edge
// function does the LLM merge; this module reads the current base, calls the
// function after a summary, and writes the merged result back (best-effort,
// deduped per note). Mirrors F1a's accumulateSpeakerProfile flow.

export interface MemoryActionItem {
  text: string;
  assigned_by: string | null;
  source_note_id: string | null;
  confidence: number;
}
export interface MemoryCollaborator {
  name: string;
  speaker_id: string | null;
  meeting_count: number;
  last_seen: string | null;
  confidence: number;
}
export interface MemoryProject {
  name: string;
  status: string | null;
  confidence: number;
}
export interface MemoryTopic {
  topic: string;
  confidence: number;
}
export interface UserMemory {
  open_action_items: MemoryActionItem[];
  collaborators: MemoryCollaborator[];
  active_projects: MemoryProject[];
  recurring_topics: MemoryTopic[];
}

export const EMPTY_USER_MEMORY: UserMemory = {
  open_action_items: [],
  collaborators: [],
  active_projects: [],
  recurring_topics: [],
};

interface UserMemoryRow {
  memory: UserMemory | null;
  processed_note_ids: string[] | null;
}

/** Read the caller's memory row (RLS-scoped to their user_id). Returns null when none exists yet. */
export async function fetchUserMemory(
  userId: string
): Promise<{ memory: UserMemory; processedNoteIds: string[] } | null> {
  const { data, error } = await supabase
    .from('user_memory')
    .select('memory, processed_note_ids')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as UserMemoryRow;
  return {
    memory: coerceMemory(row.memory),
    processedNoteIds: Array.isArray(row.processed_note_ids) ? row.processed_note_ids : [],
  };
}

/** Permanently delete the caller's memory (the F1c "user can delete" control). */
export async function clearUserMemory(userId: string): Promise<void> {
  const { error } = await supabase.from('user_memory').delete().eq('user_id', userId);
  if (error) throw error;
}

interface UpdateMemoryResponse {
  memory?: unknown;
  error?: string;
}

async function invokeUpdateUserMemory(
  body: { transcriptText: string; selfName: string | null; noteId: string | null; existingMemory: UserMemory },
  auth: IdentifyAuth
): Promise<UserMemory> {
  const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/update-user-memory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${auth.appToken ?? SUPABASE_ANON_KEY}`,
      ...(auth.msToken ? { 'x-ms-access-token': auth.msToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: UpdateMemoryResponse;
  try {
    parsed = raw ? (JSON.parse(raw) as UpdateMemoryResponse) : {};
  } catch {
    parsed = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) throw new Error(parsed.error || raw || `HTTP ${response.status}`);
  return coerceMemory(parsed.memory);
}

/**
 * F1c — fold ONE note's transcript into the user's personal memory after its
 * summary is generated. Best-effort: the caller runs this in the background and
 * logs failures. Deduped per note via processed_note_ids (durable), so a resumed
 * or repeated summary never double-counts. Returns the merged memory, or null
 * when nothing was done (skipped/deduped).
 */
export async function updateUserMemoryFromNote(params: {
  userId: string;
  noteId: string;
  segments: TranscriptSegment[];
  selfName: string | null;
  auth: IdentifyAuth;
}): Promise<UserMemory | null> {
  const { userId, noteId, segments, selfName, auth } = params;
  if (!userId || !noteId || segments.length === 0) return null;

  const existing = await fetchUserMemory(userId);
  const existingMemory = existing?.memory ?? EMPTY_USER_MEMORY;
  const processedNoteIds = existing?.processedNoteIds ?? [];
  if (processedNoteIds.includes(noteId)) return null; // already folded in

  const transcriptText = segments
    .map((s) => `${s.speaker}: ${getSegmentText(s, 'original')}`)
    .join('\n')
    .trim();
  if (!transcriptText) return null;

  const merged = await invokeUpdateUserMemory(
    { transcriptText, selfName, noteId, existingMemory },
    auth
  );

  const nextProcessed = [...processedNoteIds, noteId].slice(-500); // cap the dedup list
  const { error } = await supabase
    .from('user_memory')
    .upsert(
      {
        user_id: userId,
        memory: merged,
        processed_note_ids: nextProcessed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
  if (error) throw error;

  return merged;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clamp01(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Defensive client-side coercion so a malformed row/response can never break the UI. */
function coerceMemory(input: unknown): UserMemory {
  const o = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  const optS = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

  return {
    open_action_items: toArray(o.open_action_items)
      .map((raw) => {
        const it = obj(raw);
        const text = s(it.text).trim();
        return text
          ? {
              text,
              assigned_by: optS(it.assigned_by),
              source_note_id: optS(it.source_note_id),
              confidence: clamp01(it.confidence),
            }
          : null;
      })
      .filter((x): x is MemoryActionItem => x !== null),
    collaborators: toArray(o.collaborators)
      .map((raw) => {
        const it = obj(raw);
        const name = s(it.name).trim();
        return name
          ? {
              name,
              speaker_id: optS(it.speaker_id),
              meeting_count: typeof it.meeting_count === 'number' && Number.isFinite(it.meeting_count) ? it.meeting_count : 1,
              last_seen: optS(it.last_seen),
              confidence: clamp01(it.confidence),
            }
          : null;
      })
      .filter((x): x is MemoryCollaborator => x !== null),
    active_projects: toArray(o.active_projects)
      .map((raw) => {
        const it = obj(raw);
        const name = s(it.name).trim();
        return name ? { name, status: optS(it.status), confidence: clamp01(it.confidence) } : null;
      })
      .filter((x): x is MemoryProject => x !== null),
    recurring_topics: toArray(o.recurring_topics)
      .map((raw) => {
        const it = obj(raw);
        const topic = s(it.topic).trim();
        return topic ? { topic, confidence: clamp01(it.confidence) } : null;
      })
      .filter((x): x is MemoryTopic => x !== null),
  };
}
