// Read-only probe for the Step-2 meeting-briefing assembly. It replicates the
// GET /meeting-briefing server logic (minus the Microsoft-token auth) against real prod
// data for a given user, so we can confirm the deterministic briefing actually populates
// before deploying. NO writes, NO LLM. Run: npx tsx eval/briefing-probe.ts [userId]
// (with no userId it uses the most recent note's owner).

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { renderMemoryItemsForBriefing } from '../src/memory.js';

config();

const MEMORY_LIMIT = 8;
const RECENT_NOTES = 8;
const MAX_PER_NOTE = 6;

function str(v: unknown, max = 400): string { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

function decisions(raw: unknown): { text: string; rationale: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { text: string; rationale: string }[] = [];
  for (const d of raw) {
    const o = d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
    const text = str(o.text);
    if (!text) continue;
    out.push({ text, rationale: str(o.rationale) });
    if (out.length >= MAX_PER_NOTE) break;
  }
  return out;
}

function events(raw: unknown): { cause: string; effect: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { cause: string; effect: string }[] = [];
  for (const e of raw) {
    const o = e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
    const cause = str(o.cause); const effect = str(o.effect);
    if (!cause && !effect) continue;
    out.push({ cause, effect });
    if (out.length >= MAX_PER_NOTE) break;
  }
  return out;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) { process.stderr.write('Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.\n'); process.exit(1); }
  const db: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });

  let userId = process.argv[2]?.trim();
  if (!userId) {
    const { data } = await db.from('note').select('user_id').order('created_at', { ascending: false }).limit(1).maybeSingle();
    userId = (data as { user_id?: string } | null)?.user_id;
  }
  if (!userId) { process.stderr.write('No userId (and no notes to infer one).\n'); process.exit(1); }
  process.stdout.write(`\n════ briefing probe for user ${userId} ════\n`);

  const { data: memRow } = await db.from('user_memory').select('memory').eq('user_id', userId).maybeSingle();
  const memoryItems = renderMemoryItemsForBriefing((memRow as { memory?: unknown } | null)?.memory ?? null, MEMORY_LIMIT);

  const { data: noteRows } = await db.from('note')
    .select('id, name, meeting_at, created_at')
    .eq('user_id', userId)
    .order('meeting_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(RECENT_NOTES);
  const notes = (noteRows ?? []) as { id: string; name?: unknown; meeting_at?: unknown; created_at?: unknown }[];
  const noteIds = notes.map((n) => n.id).filter((id): id is string => typeof id === 'string' && id.length > 0);

  const insightByNote = new Map<string, { decisions?: unknown; events?: unknown }>();
  if (noteIds.length) {
    const { data: insightRows } = await db.from('note_insight').select('note_id, decisions, events').in('note_id', noteIds);
    for (const row of (insightRows ?? []) as { note_id?: unknown; decisions?: unknown; events?: unknown }[]) {
      if (typeof row.note_id === 'string') insightByNote.set(row.note_id, { decisions: row.decisions, events: row.events });
    }
  }

  process.stdout.write(`\n── Ongoing context (${memoryItems.length} memory items) ──\n`);
  memoryItems.forEach((m) => process.stdout.write(`  • ${m.text}\n`));

  process.stdout.write(`\n── Recent decisions & events (from ${notes.length} newest notes) ──\n`);
  let shown = 0;
  for (const n of notes) {
    const ins = insightByNote.get(n.id);
    const ds = decisions(ins?.decisions); const es = events(ins?.events);
    if (!ds.length && !es.length) continue;
    shown += 1;
    process.stdout.write(`  [${str(n.name, 80) || 'Untitled'}] ${str(n.meeting_at, 10) || str(n.created_at, 10)}\n`);
    ds.forEach((d) => process.stdout.write(`     - ${d.text}${d.rationale ? `  (why: ${d.rationale})` : ''}\n`));
    es.forEach((e) => process.stdout.write(`     - ${e.cause && e.effect ? `${e.cause} → ${e.effect}` : e.effect || e.cause}\n`));
  }
  if (!shown) process.stdout.write('  (no notes with meeting-level decisions/events)\n');
  process.stdout.write(`\nVERDICT: briefing ${memoryItems.length || shown ? 'POPULATES' : 'is EMPTY'} for this user.\n`);
}

main().catch((e) => { process.stderr.write(`briefing-probe failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
