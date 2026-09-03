import { supabase } from '../config/supabaseConfig';

// F1' (dynamic relational memory): per-user personal memory as a list of
// natural-language MEMORY ITEMS aggregated across all of a user's meetings.
// READ-ONLY client module: reads the current memory row and coerces it (v1 buckets
// or v2 items) into display items for the "My Memory" screen, plus a delete control.
// The write path (fold-after-summary) now lives server-side in the workflow-server
// (foldNoteIntoMemory); the old client-driven `update-user-memory` edge function was
// superseded and removed.

export interface MemoryItem {
  id: string;
  text: string;
  entities: string[];
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  sourceNoteIds: string[];
}

/** The persisted memory shape (version 2). Older rows may still be the F1c bucket shape until re-processed. */
export interface UserMemory {
  version: 2;
  items: MemoryItem[];
}

interface UserMemoryRow {
  memory: unknown;
  processed_note_ids: string[] | null;
}

/**
 * Read the caller's memory row (RLS-scoped to their user_id). Returns the raw
 * stored memory (passed to the edge function untouched so it can migrate v1),
 * plus the active items for display, and the dedup list. Null when none exists.
 */
export async function fetchUserMemory(
  userId: string
): Promise<{ rawMemory: unknown; items: MemoryItem[]; processedNoteIds: string[] } | null> {
  const { data, error } = await supabase
    .from('user_memory')
    .select('memory, processed_note_ids')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as UserMemoryRow;
  return {
    rawMemory: row.memory ?? null,
    items: toActiveMemoryItems(row.memory),
    processedNoteIds: Array.isArray(row.processed_note_ids) ? row.processed_note_ids : [],
  };
}

/** Permanently delete the caller's memory (the "user can delete" control). */
export async function clearUserMemory(userId: string): Promise<void> {
  const { error } = await supabase.from('user_memory').delete().eq('user_id', userId);
  if (error) throw error;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function s(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function isV2(input: unknown): boolean {
  const o = asObject(input);
  return o.version === 2 && Array.isArray(o.items);
}

/** Defensive client-side coercion of a v2 memory response so a malformed row/response can never break the UI. */
function coerceMemory(input: unknown): UserMemory {
  const now = new Date().toISOString();
  if (isV2(input)) {
    const items = toArray(asObject(input).items)
      .map((raw) => normalizeItem(raw, now))
      .filter((x): x is MemoryItem => x !== null);
    return { version: 2, items };
  }
  // A v1 payload (or garbage) coerces to seed items so nothing is lost in the UI.
  return { version: 2, items: foldV1ToItems(input, now) };
}

function normalizeItem(raw: unknown, now: string): MemoryItem | null {
  const o = asObject(raw);
  const text = s(o.text).slice(0, 600);
  if (!text) return null;
  const id = s(o.id).slice(0, 80) || `local-${Math.abs(hashString(text))}`;
  const status: MemoryItem['status'] = o.status === 'archived' ? 'archived' : 'active';
  const createdAt = s(o.createdAt) || now;
  const updatedAt = s(o.updatedAt) || createdAt;
  const entities = toArray(o.entities).map((e) => s(e).slice(0, 80)).filter(Boolean).slice(0, 12);
  const sourceNoteIds = toArray(o.sourceNoteIds).map((e) => s(e).slice(0, 80)).filter(Boolean).slice(0, 50);
  return { id, text, entities, status, createdAt, updatedAt, sourceNoteIds };
}

/** Client-side v1 -> display-items fold, mirroring the edge function, so pre-migration rows still render. */
function foldV1ToItems(input: unknown, now: string): MemoryItem[] {
  const o = asObject(input);
  const items: MemoryItem[] = [];
  const push = (text: string, entities: string[]) => {
    const t = text.trim().slice(0, 600);
    if (!t) return;
    items.push({
      id: `local-${Math.abs(hashString(t))}`,
      text: t,
      entities: entities.filter(Boolean).slice(0, 12),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      sourceNoteIds: [],
    });
  };
  const clean = (x: string): string => x.replace(/[\s.]+$/, '');
  for (const raw of toArray(o.open_action_items)) {
    const it = asObject(raw);
    const text = s(it.text);
    if (!text) continue;
    const by = s(it.assigned_by);
    const suffix = by && by.toLowerCase() !== 'self' ? ` (assigned by ${by})` : '';
    push(`Open commitment: ${clean(text)}${suffix}.`, by && by.toLowerCase() !== 'self' ? [by] : []);
  }
  for (const raw of toArray(o.collaborators)) {
    const it = asObject(raw);
    const name = s(it.name);
    if (!name) continue;
    const mc = typeof it.meeting_count === 'number' && it.meeting_count > 1 ? ` (seen across ${Math.floor(it.meeting_count)} meetings)` : '';
    push(`${clean(name)} is a recurring collaborator of the user${mc}.`, [name]);
  }
  for (const raw of toArray(o.active_projects)) {
    const it = asObject(raw);
    const name = s(it.name);
    if (!name) continue;
    const status = s(it.status);
    push(`Active project "${clean(name)}"${status ? ` — ${clean(status)}` : ''}.`, [name]);
  }
  for (const raw of toArray(o.recurring_topics)) {
    const it = asObject(raw);
    const topic = s(it.topic);
    if (!topic) continue;
    push(`Recurring topic: ${clean(topic)}.`, [topic]);
  }
  return items;
}

/** Active items for display, most-recently-updated first. Handles both v2 and legacy v1 rows. */
export function toActiveMemoryItems(input: unknown): MemoryItem[] {
  return coerceMemory(input)
    .items.filter((i) => i.status === 'active')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function hashString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h << 5) - h + value.charCodeAt(i);
    h |= 0;
  }
  return h;
}
