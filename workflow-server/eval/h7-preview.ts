// H7 PREVIEW (read-only, NO LLM) — what would cold-start bootstrap surface on REAL transcripts?
//
// discoverBootstrapNames is pure regex, so we can run it over the user's actual diarized notes and
// see (a) how OFTEN H7 fires (its real-world trigger rate — self-intros are rare in recurring teams,
// common in first meetings), (b) WHAT names it surfaces (are they real people or role-noun garbage —
// a precision preview), and (c) whether the stoplist changes the outcome on real data. This is the
// "measure first" check the backtest cannot give (the backtest corpus has ~no self-intros).
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Run: `npm run eval:h7-preview`.
// Tunables: H7_USERS (csv or "all"), H7_NOTES_PER_USER (40), H7_SCAN_LIMIT (400).

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { discoverBootstrapNames } from '../src/speakerAnchors.js';
import { parseTurns } from '../src/speakerAnchors.js';

config();

const NOTES_PER_USER = clampInt(process.env.H7_NOTES_PER_USER, 40, 2, 200);
const SCAN_LIMIT = clampInt(process.env.H7_SCAN_LIMIT, 400, 50, 5000);

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

interface Segment { speaker?: unknown; speakerKey?: unknown; text?: unknown }
interface NoteRow { id: string; user_id: string; created_at: string; diarization: unknown }

const isAnonName = (s: string): boolean => /^speaker\s/i.test(s.trim()) || s.trim() === '' || /^unknown/i.test(s.trim());

// Build the "speakerKey: text" transcript + label list + the note's ground-truth names.
function toTranscript(note: NoteRow): { transcript: string; labels: string[]; names: string[] } | null {
  const segs = Array.isArray(note.diarization) ? (note.diarization as Segment[]) : [];
  const keyed = segs.filter((s) => s && typeof s.text === 'string' && typeof s.speakerKey === 'string' && (s.speakerKey as string).trim());
  if (keyed.length === 0) return null;
  const labels = [...new Set(keyed.map((s) => (s.speakerKey as string).trim()))];
  const names = [...new Set(keyed.map((s) => (typeof s.speaker === 'string' ? (s.speaker as string).trim() : '')).filter((n) => n && !isAnonName(n)))];
  const transcript = keyed.map((s) => `${(s.speakerKey as string).trim()}: ${s.text as string}`).join('\n');
  return { transcript, labels, names };
}

async function loadRosterNames(db: SupabaseClient, userId: string): Promise<string[]> {
  const { data } = await db.from('speaker').select('name').eq('user_id', userId);
  return ((data ?? []) as Array<{ name: string | null }>).map((r) => r.name ?? '').filter(Boolean);
}

async function loadNotes(db: SupabaseClient, userId: string): Promise<NoteRow[]> {
  const { data } = await db.from('note').select('id, user_id, created_at, diarization')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(NOTES_PER_USER);
  return (data ?? []) as NoteRow[];
}

async function discoverUsers(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from('note').select('id, user_id, created_at, diarization').order('created_at', { ascending: false }).limit(SCAN_LIMIT);
  const rows = (data ?? []) as NoteRow[];
  const seen = new Set<string>();
  for (const r of rows) if (r.user_id && toTranscript(r)) seen.add(r.user_id);
  return [...seen];
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) { process.stderr.write('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.\n'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const arg = (process.env.H7_USERS || 'all').trim();
  const users = arg && arg !== 'all' ? arg.split(',').map((u) => u.trim()).filter(Boolean) : await discoverUsers(db);

  process.stdout.write(`\nH7 PREVIEW (real transcripts, no LLM) — users=${users.length}  notes/user<=${NOTES_PER_USER}\n`);

  let scanned = 0, triggered = 0, stoplistDiffered = 0;
  const surfaced: string[] = [];

  for (const userPrefix of users) {
    // Resolve a prefix to the full user_id via the speaker table (prefixes are convenient to type).
    const { data: sp } = await db.from('speaker').select('user_id').ilike('user_id', `${userPrefix}%`).limit(1);
    const userId = (sp?.[0] as { user_id: string } | undefined)?.user_id ?? userPrefix;

    const notes = await loadNotes(db, userId);
    const rosterNames = await loadRosterNames(db, userId);
    // self = the name present in the most notes (owner is in ~all their meetings); used only as a
    // known name so a self-intro by the owner is not mistaken for a NEW person.
    const nameNoteCount = new Map<string, number>();
    for (const n of notes) { const t = toTranscript(n); if (t) for (const nm of new Set(t.names)) nameNoteCount.set(nm, (nameNoteCount.get(nm) ?? 0) + 1); }
    let self: string | null = null, selfN = 0;
    for (const [nm, c] of nameNoteCount) if (c > selfN) { selfN = c; self = nm; }
    const known = [...new Set([...rosterNames, ...(self ? [self] : [])])];

    for (const n of notes) {
      const t = toTranscript(n);
      if (!t) continue;
      scanned += 1;
      const turns = parseTurns(t.transcript, t.labels);
      const withStop = discoverBootstrapNames(turns, known, { stoplist: true });
      const noStop = discoverBootstrapNames(turns, known, { stoplist: false });
      if (withStop.newNames.length === 0 && noStop.newNames.length === 0) continue;
      triggered += 1;
      const differ = JSON.stringify(withStop.newNames) !== JSON.stringify(noStop.newNames);
      if (differ) stoplistDiffered += 1;
      for (const nm of withStop.newNames) surfaced.push(nm);
      const assignStr = [...withStop.assignment.entries()].map(([l, nm]) => `${l}→${nm}`).join(', ') || '(none)';
      const snippet = t.transcript.replace(/\s+/g, ' ').slice(0, 70);
      process.stdout.write(
        `\n• ${userPrefix.slice(0, 8)}…  ${n.created_at.slice(0, 10)}  "${snippet}…"\n` +
        `    stoplist ON : [${withStop.newNames.join(', ') || '—'}]   assign: ${assignStr}\n` +
        (differ ? `    stoplist OFF: [${noStop.newNames.join(', ')}]   ← DIFFERS (role-noun leak blocked by stoplist)\n` : ''),
      );
    }
  }

  process.stdout.write('\n──────────────────────────────────────────────────────────────\n');
  process.stdout.write(`SUMMARY: ${triggered}/${scanned} notes triggered H7 (${scanned ? ((triggered / scanned) * 100).toFixed(1) : '0'}%).\n`);
  process.stdout.write(`  stoplist changed the outcome on ${stoplistDiffered} note(s).\n`);
  process.stdout.write(`  names surfaced (stoplist on): ${surfaced.length ? [...new Set(surfaced)].join(', ') : '(none)'}\n`);
  process.stdout.write('  Read: real personal NAMES that the roster lacked = H7 works on real cold-start.\n');
  process.stdout.write('        role-noun / garbage names = tighten the stoplist or corroboration before shipping.\n');
}

main().catch((e) => { process.stderr.write(`h7-preview failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
