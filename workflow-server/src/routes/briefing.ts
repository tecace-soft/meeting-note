import type { IncomingMessage, ServerResponse } from 'node:http';
import { supabase } from '../db/supabaseClient.js';
import { getBearerToken, sendJson } from '../http/shared.js';
import { getMicrosoftUserId } from '../http/identity.js';
import { renderMemoryItemsForBriefing, type BriefingMemoryItem } from '../memory.js';

// Step-2 (memory value surface): the deterministic MEETING BRIEFING for the records tab.
// Assembles, with NO LLM (cost 0, drift 0), two robust memory-derived views scoped to the
// authenticated user: (1) durable cross-meeting context from user_memory (active items),
// (2) recent MEETING-LEVEL decisions/events from note_insight for the newest notes. It
// deliberately OMITS action items / owner attribution — those depend on speaker-ID, which is
// measured-unreliable, so surfacing "your commitments" here would amplify a weak signal.
const BRIEFING_MEMORY_LIMIT = 8;

const BRIEFING_RECENT_NOTES = 8;

const BRIEFING_MAX_PER_NOTE = 6;

interface BriefingDecision { text: string; rationale: string }

interface BriefingEvent { cause: string; effect: string }

interface BriefingRecentNote {
  noteId: string;
  noteName: string;
  date: string;
  decisions: BriefingDecision[];
  events: BriefingEvent[];
}

function briefingStr(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function coerceBriefingDecisions(raw: unknown): BriefingDecision[] {
  if (!Array.isArray(raw)) return [];
  const out: BriefingDecision[] = [];
  for (const d of raw) {
    const o = d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
    const text = briefingStr(o.text);
    if (!text) continue;
    out.push({ text, rationale: briefingStr(o.rationale) });
    if (out.length >= BRIEFING_MAX_PER_NOTE) break;
  }
  return out;
}

export function coerceBriefingEvents(raw: unknown): BriefingEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: BriefingEvent[] = [];
  for (const e of raw) {
    const o = e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
    const cause = briefingStr(o.cause);
    const effect = briefingStr(o.effect);
    if (!cause && !effect) continue;
    out.push({ cause, effect });
    if (out.length >= BRIEFING_MAX_PER_NOTE) break;
  }
  return out;
}

async function meetingBriefing(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Auth: derive the user from the Microsoft Graph token; never trust a client-supplied id.
  const userId = await getMicrosoftUserId(getBearerToken(req));

  // (1) durable cross-meeting context (active user_memory items).
  const { data: memRow, error: memError } = await supabase
    .from('user_memory')
    .select('memory')
    .eq('user_id', userId)
    .maybeSingle();
  if (memError) throw memError;
  const memoryItems: BriefingMemoryItem[] = renderMemoryItemsForBriefing(
    (memRow as { memory?: unknown } | null)?.memory ?? null,
    BRIEFING_MEMORY_LIMIT,
  );

  // (2) recent MEETING-LEVEL decisions/events from the user's own newest notes. Owner-free
  // by construction (no actions column read), so speaker-ID accuracy cannot corrupt it.
  const { data: noteRows, error: noteError } = await supabase
    .from('note')
    .select('id, name, meeting_at, created_at')
    .eq('user_id', userId)
    .order('meeting_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(BRIEFING_RECENT_NOTES);
  if (noteError) throw noteError;
  const notes = (noteRows ?? []) as { id: string; name?: unknown; meeting_at?: unknown; created_at?: unknown }[];
  const noteIds = notes.map((n) => n.id).filter((id): id is string => typeof id === 'string' && id.length > 0);

  const insightByNote = new Map<string, { decisions?: unknown; events?: unknown }>();
  if (noteIds.length) {
    const { data: insightRows, error: insightError } = await supabase
      .from('note_insight')
      .select('note_id, decisions, events')
      .in('note_id', noteIds);
    if (insightError) throw insightError;
    for (const row of (insightRows ?? []) as { note_id?: unknown; decisions?: unknown; events?: unknown }[]) {
      if (typeof row.note_id === 'string') insightByNote.set(row.note_id, { decisions: row.decisions, events: row.events });
    }
  }

  const recent: BriefingRecentNote[] = [];
  for (const n of notes) {
    const ins = insightByNote.get(n.id);
    const decisions = coerceBriefingDecisions(ins?.decisions);
    const events = coerceBriefingEvents(ins?.events);
    if (!decisions.length && !events.length) continue; // skip notes with nothing meeting-level to show
    recent.push({
      noteId: n.id,
      noteName: briefingStr(n.name, 200) || 'Untitled',
      date: briefingStr(n.meeting_at, 40) || briefingStr(n.created_at, 40),
      decisions,
      events,
    });
  }

  sendJson(res, 200, { memoryItems, recent, generatedAt: new Date().toISOString() });
}

export async function handleBriefingRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== 'GET' || url.pathname !== '/meeting-briefing') return false;
  await meetingBriefing(req, res); return true;
}
