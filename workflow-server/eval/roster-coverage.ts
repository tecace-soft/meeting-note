// ROSTER COVERAGE measurement (read-only, diagnostic).
//
// The speaker identifier maps anonymous labels to people by comparing them to the user's
// `speaker` roster (name + profile). The 2026-08-25 backtest showed roster presence is worth
// +16pt recall — so "coverage" (how many of the people a user actually meets are in their
// roster, WITH a usable profile) is the real accuracy lever, not data quantity or prompt tuning.
//
// This script quantifies the current state per user, read-only:
//   - roster size, how many rows have a NON-EMPTY / RICH profile (profile drives matching)
//   - COVERAGE GAP: distinct real (non-anonymous) speaker NAMES that appear in the user's
//     already-labeled notes but have NO matching `speaker` row = people the user has named in
//     meetings yet the identifier can't leverage next time (the accumulate path only UPDATES
//     existing rows, it never CREATES one — see src/lib/accumulateSpeakerProfile.ts).
//   - of the names that DO have a row, how many have an empty profile (row exists, weak match).
//
// Requires real SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Reads note.diarization + speaker.
// Run: `npm run eval:roster-coverage` (from workflow-server/).
//
// Tunables (env):
//   ROSTER_SCAN_LIMIT   max recent notes to scan (default 1000)
//   ROSTER_MIN_PROFILE  chars for a profile to count as "rich" (default 40)

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { norm } from './lib/util.js';

config();

const SCAN_LIMIT = clampInt(process.env.ROSTER_SCAN_LIMIT, 1000, 100, 10000);
const MIN_PROFILE = clampInt(process.env.ROSTER_MIN_PROFILE, 40, 0, 5000);

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

interface Segment { speaker?: unknown; speakerKey?: unknown; text?: unknown }
interface NoteRow { id: string; user_id: string; diarization: unknown }
interface SpeakerRow { id: string | number; name: string; profile: string | null; user_id: string }

const isAnonName = (s: string): boolean =>
  /^speaker\s/i.test(s.trim()) || s.trim() === '' || s.trim() === 'Unknown Speaker' || /^unknown/i.test(s.trim());

const pct = (num: number, den: number): string => (den ? `${((num / den) * 100).toFixed(0)}%` : '  -');

/** Distinct real (non-anonymous) speaker display names across a user's notes. */
function namedSpeakersInNotes(notes: NoteRow[]): Set<string> {
  const names = new Set<string>();
  for (const note of notes) {
    const segs = Array.isArray(note.diarization) ? (note.diarization as Segment[]) : [];
    for (const s of segs) {
      const display = typeof s.speaker === 'string' ? s.speaker.trim() : '';
      if (display && !isAnonName(display)) names.add(display);
    }
  }
  return names;
}

async function loadAllNotes(db: SupabaseClient): Promise<NoteRow[]> {
  const { data } = await db
    .from('note')
    .select('id, user_id, diarization')
    .order('created_at', { ascending: false })
    .limit(SCAN_LIMIT);
  return (data ?? []) as NoteRow[];
}

async function loadAllSpeakers(db: SupabaseClient): Promise<SpeakerRow[]> {
  const { data } = await db.from('speaker').select('id, name, profile, user_id');
  return (data ?? []) as SpeakerRow[];
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key || url.includes('your-project-ref') || key.includes('your-supabase')) {
    process.stderr.write('Real SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (read-only).\n');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const [notes, speakers] = await Promise.all([loadAllNotes(db), loadAllSpeakers(db)]);

  // Group by user.
  const notesByUser = new Map<string, NoteRow[]>();
  for (const n of notes) {
    const arr = notesByUser.get(n.user_id) ?? [];
    arr.push(n);
    notesByUser.set(n.user_id, arr);
  }
  const rosterByUser = new Map<string, SpeakerRow[]>();
  for (const s of speakers) {
    const arr = rosterByUser.get(s.user_id) ?? [];
    arr.push(s);
    rosterByUser.set(s.user_id, arr);
  }

  process.stdout.write(`\nROSTER COVERAGE — per user (notes scanned=${notes.length}, speakers=${speakers.length}, rich>=${MIN_PROFILE} chars)\n\n`);
  process.stdout.write('user       notes  roster  rich-prof   named-in-notes  in-roster  MISSING(gap)  matched-but-empty\n');

  let totNamed = 0, totInRoster = 0, totMissing = 0, totRich = 0, totRoster = 0;
  const users = Array.from(new Set([...notesByUser.keys(), ...rosterByUser.keys()]))
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  for (const userId of users) {
    const userNotes = notesByUser.get(userId) ?? [];
    const roster = rosterByUser.get(userId) ?? [];
    const rosterNames = roster.map((r) => ({ key: norm(r.name), rich: (r.profile ?? '').trim().length >= MIN_PROFILE }));
    const rosterKeySet = new Set(rosterNames.map((r) => r.key));
    const richCount = rosterNames.filter((r) => r.rich).length;

    const named = namedSpeakersInNotes(userNotes);
    let inRoster = 0, missing = 0, matchedButEmpty = 0;
    for (const name of named) {
      const k = norm(name);
      if (rosterKeySet.has(k)) {
        inRoster += 1;
        const row = rosterNames.find((r) => r.key === k);
        if (row && !row.rich) matchedButEmpty += 1;
      } else {
        missing += 1;
      }
    }

    totNamed += named.size; totInRoster += inRoster; totMissing += missing;
    totRich += richCount; totRoster += roster.length;

    process.stdout.write(
      `${userId.slice(0, 8)}  ${String(userNotes.length).padStart(5)}  ${String(roster.length).padStart(6)}  ` +
      `${String(richCount).padStart(4)} ${pct(richCount, roster.length).padStart(4)}   ${String(named.size).padStart(12)}  ${String(inRoster).padStart(9)}  ` +
      `${String(missing).padStart(6)} ${pct(missing, named.size).padStart(5)}  ${String(matchedButEmpty).padStart(15)}\n`,
    );
  }

  process.stdout.write('\n──────────────────────────────────────────────────────────────\n');
  process.stdout.write(`AGGREGATE\n`);
  process.stdout.write(`  roster rows: ${totRoster}, of which rich profile (>=${MIN_PROFILE} chars): ${totRich} (${pct(totRich, totRoster)})\n`);
  process.stdout.write(`  named speakers seen in notes: ${totNamed}\n`);
  process.stdout.write(`  ...already in roster: ${totInRoster} (${pct(totInRoster, totNamed)})\n`);
  process.stdout.write(`  ...MISSING from roster (coverage gap): ${totMissing} (${pct(totMissing, totNamed)})\n`);
  process.stdout.write(`\nRead: a high MISSING% means people the user has named in meetings are NOT in the roster,\nso the identifier cannot recognize them next time. matched-but-empty = row exists but no profile\n(weak match). Both are the coverage levers.\n`);
}

main().catch((error) => {
  process.stderr.write(`roster-coverage failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
