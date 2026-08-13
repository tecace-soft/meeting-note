// One-off backfill: populate note_insight.events (and refresh the full structured
// insight) for notes that predate the F4 events field (2026-08-13). Existing rows have
// events=[]; this re-extracts them.
//
// Robustness (a prior backfill attempt failed repeatedly — HTTP-200-unparseable was not
// retried [fixed in db7345d], long transcripts, and running everything at once tripping
// rate limits): bounded loop, SEQUENTIAL with pacing, per-note error isolation (one bad
// note never aborts the run), idempotent upsert, and a DRY_RUN that only counts.
//
// Run from workflow-server/:
//   DRY_RUN=1 npx tsx scripts/backfill-events.ts        # count only, no Gemini calls
//   BACKFILL_USER_ID=<oid> npx tsx scripts/backfill-events.ts   # scope to one user
//   BACKFILL_LIMIT=100 npx tsx scripts/backfill-events.ts       # cap notes this run

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { extractAndStoreInsight } from '../src/memory.js';

config();

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const GEMINI = process.env.GEMINI_API_KEY ?? '';
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = Math.min(Number(process.env.BACKFILL_LIMIT ?? '500') || 500, 2000); // hard cap (rule 1/8)
const USER_ID = process.env.BACKFILL_USER_ID?.trim() || null;
const DELAY_MS = 400; // gentle pacing between Gemini calls (prior failure mode: rate limits)

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

interface NoteRow {
  id: string;
  user_id: string | null;
  diarization: unknown;
  transcription: unknown;
}

// Minimal, faithful transcript build: prefer the named diarization (real speaker names →
// better owner attribution) over the frozen "Speaker A/B" transcription column.
function buildTranscript(note: NoteRow): { transcript: string; speakerContext: string | null } {
  const dia = Array.isArray(note.diarization) ? (note.diarization as Array<Record<string, unknown>>) : [];
  if (dia.length > 0) {
    const lines: string[] = [];
    const names = new Set<string>();
    for (const seg of dia) {
      const speaker = typeof seg.speaker === 'string' ? seg.speaker.trim() : '';
      const text = typeof seg.text === 'string' ? seg.text.trim() : '';
      if (!text) continue;
      lines.push(speaker ? `${speaker}: ${text}` : text);
      // Collect real names only (skip generic "Speaker A/1" labels) for speaker context.
      if (speaker && !/^Speaker\s+[A-Z0-9]+$/i.test(speaker)) names.add(speaker);
    }
    const speakerContext = names.size > 0 ? `Meeting participants (real names): ${[...names].join(', ')}.` : null;
    return { transcript: lines.join('\n'), speakerContext };
  }
  const t = typeof note.transcription === 'string' ? note.transcription : '';
  return { transcript: t, speakerContext: null };
}

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required.');
  if (!GEMINI && !DRY_RUN) throw new Error('GEMINI_API_KEY is required (unless DRY_RUN=1).');
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Notes that already have non-empty events → skip (idempotent re-runs).
  const doneIds = new Set<string>();
  const { data: insightRows, error: insightErr } = await supabase.from('note_insight').select('note_id, events');
  if (insightErr) throw insightErr;
  for (const row of (insightRows as Array<{ note_id: string; events: unknown }> | null) ?? []) {
    if (Array.isArray(row.events) && row.events.length > 0) doneIds.add(row.note_id);
  }
  log(`note_insight rows with events already: ${doneIds.size}`);

  // Candidate notes (newest first), optionally scoped to one user.
  let q = supabase
    .from('note')
    .select('id, user_id, diarization, transcription')
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (USER_ID) q = q.eq('user_id', USER_ID);
  const { data: notesData, error: notesErr } = await q;
  if (notesErr) throw notesErr;
  const notes = (notesData as NoteRow[] | null) ?? [];

  const todo = notes.filter((n) => n.id && !doneIds.has(n.id));
  log(`candidates: ${notes.length} fetched (limit ${LIMIT})${USER_ID ? ` for user ${USER_ID}` : ''}, ${todo.length} need events`);
  if (DRY_RUN) {
    log('DRY_RUN — no extraction performed.');
    return;
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i++) {
    const note = todo[i];
    const { transcript, speakerContext } = buildTranscript(note);
    if (!transcript.trim() || !note.user_id) {
      skipped++;
      log(`[${i + 1}/${todo.length}] ${note.id} SKIP (no transcript/user)`);
      continue;
    }
    try {
      const result = await extractAndStoreInsight({ supabase, apiKey: GEMINI, userId: note.user_id, noteId: note.id, transcript, speakerContext });
      if (result.ok) {
        ok++;
        log(`[${i + 1}/${todo.length}] ${note.id} OK`);
      } else {
        failed++;
        log(`[${i + 1}/${todo.length}] ${note.id} FAIL: ${result.reason ?? 'unknown'}`);
      }
    } catch (e) {
      // Isolate per-note failures — never abort the whole backfill for one bad note.
      failed++;
      log(`[${i + 1}/${todo.length}] ${note.id} ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (i < todo.length - 1) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }
  log(`\nBACKFILL DONE — ok ${ok}, skipped ${skipped}, failed ${failed}, total ${todo.length}`);
}

main().catch((e) => {
  const detail = e instanceof Error ? (e.stack ?? e.message) : JSON.stringify(e, null, 2);
  process.stderr.write(`backfill failed: ${detail}\n`);
  process.exit(1);
});
