// SELF AUTO-APPLY PRECISION by note size (read-only) — designs the wrong-self guard.
//
// At ingest, autoIdentifySpeakersAtIngest auto-applies a label as the owner ("self") when the
// model returns isSelf=true at conf >= AUTO_IDENTIFY_CONFIDENCE (0.8). The 2026-08-25 diagnosis
// found "wrong-self" cases (a teammate's label marked self at >=0.8, then auto-applied → the
// note is corrupted), concentrated in multi-speaker / over-segmented meetings. Hypothesis: the
// self prior is reliable in SMALL conversations but a coin-flip in crowded meetings.
//
// This measures SELF auto-apply PRECISION stratified by (a) the note's anonymous-label count and
// (b) the confidence threshold, so we can pick a robust guard (e.g. only auto-apply self when
// labels <= K, and/or raise the self threshold). Precision here = of labels the model marks
// isSelf at >=T, how many are TRULY the self (ground-truth name == selfName).
//
// Read-only. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY.
// Run: `npm run eval:self-precision`.
//
// Tunables (env):
//   SELF_USERS        comma-separated user_ids or "all" (default: discover from recent notes)
//   SELF_NOTES        notes per user (default 20)
//   SELF_MIN_NAMED    min distinct real names a note must have (default 2)
//   SELF_SELF_NAMES   JSON { "<userId>": "Display Name" } to pin self (else inferred)
//   SELF_SCAN_LIMIT   recent notes to scan for user discovery (default 500)

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { identifySpeakers, type SpeakerRosterEntry } from '../src/memory.js';
import { containsMatch } from './lib/scoring.js';
import { norm } from './lib/util.js';

config();

const NOTES = clampInt(process.env.SELF_NOTES, 20, 1, 60);
const MIN_NAMED = clampInt(process.env.SELF_MIN_NAMED, 2, 1, 10);
const SCAN_LIMIT = clampInt(process.env.SELF_SCAN_LIMIT, 500, 50, 5000);
const THRESHOLDS = [0.8, 0.9];
// Note-size buckets by distinct anonymous-label count (right-open): [1-2], [3], [4-5], [6+].
const SIZE_BUCKETS: Array<{ label: string; lo: number; hi: number }> = [
  { label: '2', lo: 2, hi: 3 },
  { label: '3', lo: 3, hi: 4 },
  { label: '4-5', lo: 4, hi: 6 },
  { label: '6+', lo: 6, hi: 999 },
];

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

interface Segment { speaker?: unknown; speakerKey?: unknown; text?: unknown }
interface NoteRow { id: string; user_id: string; created_at: string; diarization: unknown }
const isAnonName = (s: string): boolean =>
  /^speaker\s/i.test(s.trim()) || s.trim() === '' || /^unknown/i.test(s.trim());

interface Case { transcript: string; labels: string[]; expected: Map<string, string | null>; size: number }

function toCase(note: NoteRow): Case | null {
  const segs = Array.isArray(note.diarization) ? (note.diarization as Segment[]) : [];
  const keyed = segs.filter((s) => s && typeof s.text === 'string' && typeof s.speakerKey === 'string' && (s.speakerKey as string).trim());
  if (keyed.length === 0 || keyed.length < segs.length) return null;
  const expected = new Map<string, string | null>();
  const names = new Set<string>();
  for (const s of keyed) {
    const key = (s.speakerKey as string).trim();
    const display = typeof s.speaker === 'string' ? s.speaker.trim() : '';
    const real = display && !isAnonName(display) ? display : null;
    if (!expected.has(key)) expected.set(key, real);
    else if (real && !expected.get(key)) expected.set(key, real);
    if (real) names.add(norm(real));
  }
  if (names.size < MIN_NAMED) return null;
  const labels = Array.from(expected.keys());
  const transcript = keyed.map((s) => `${(s.speakerKey as string).trim()}: ${s.text as string}`).join('\n');
  return { transcript, labels, expected, size: labels.length };
}

async function loadRoster(db: SupabaseClient, userId: string): Promise<SpeakerRosterEntry[]> {
  const { data } = await db.from('speaker').select('id, name, profile').eq('user_id', userId);
  return ((data ?? []) as Array<{ id: string | number; name: string; profile: string | null }>)
    .filter((r) => r.name).map((r) => ({ speakerId: String(r.id), name: r.name, summary: r.profile ?? '' }));
}

async function loadCases(db: SupabaseClient, userId: string): Promise<Case[]> {
  const { data } = await db.from('note').select('id, user_id, created_at, diarization')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(NOTES * 5);
  const rows = (data ?? []) as NoteRow[];
  const cases: Case[] = [];
  for (const r of rows) { const c = toCase(r); if (c) cases.push(c); if (cases.length >= NOTES) break; }
  return cases;
}

async function discoverUsers(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from('note').select('id, user_id, created_at, diarization')
    .order('created_at', { ascending: false }).limit(SCAN_LIMIT);
  const rows = (data ?? []) as NoteRow[];
  const byUser = new Map<string, number>();
  for (const r of rows) if (r.user_id && toCase(r)) byUser.set(r.user_id, (byUser.get(r.user_id) || 0) + 1);
  return Array.from(byUser.entries()).filter(([, n]) => n >= MIN_NAMED).map(([u]) => u);
}

function inferSelf(cases: Case[]): string | null {
  const counts = new Map<string, { raw: string; n: number }>();
  for (const c of cases) {
    const seen = new Set<string>();
    for (const v of c.expected.values()) { if (!v) continue; const k = norm(v); if (seen.has(k)) continue; seen.add(k);
      const e = counts.get(k) ?? { raw: v, n: 0 }; e.n += 1; counts.set(k, e); }
  }
  let best: { raw: string; n: number } | null = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  return best && cases.length && best.n / cases.length >= 0.6 ? best.raw : null;
}

const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(0)}%` : '  -');

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey || !url || !key) { process.stderr.write('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY required.\n'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  let pinned: Record<string, string> = {};
  if (process.env.SELF_SELF_NAMES) { try { pinned = JSON.parse(process.env.SELF_SELF_NAMES); } catch { /* ignore */ } }
  const arg = (process.env.SELF_USERS || 'all').trim();
  const users = arg && arg !== 'all' ? arg.split(',').map((u) => u.trim()).filter(Boolean) : await discoverUsers(db);

  // cells[threshold][sizeBucket] = { applied, correct }; plus a self-present denominator.
  const cells = THRESHOLDS.map(() => SIZE_BUCKETS.map(() => ({ applied: 0, correct: 0 })));
  const selfPresentBySize = SIZE_BUCKETS.map(() => 0); // notes (in this size bucket) whose truth actually contains self

  process.stdout.write(`\nSELF AUTO-APPLY PRECISION by note size — users=${users.length}, notes/user<=${NOTES}\n`);

  for (const userId of users) {
    const cases = await loadCases(db, userId);
    if (cases.length === 0) continue;
    const roster = await loadRoster(db, userId);
    const selfName = pinned[userId] ?? inferSelf(cases);
    if (!selfName) continue;

    for (const c of cases) {
      const bi = SIZE_BUCKETS.findIndex((b) => c.size >= b.lo && c.size < b.hi);
      if (bi < 0) continue;
      const selfPresent = Array.from(c.expected.values()).some((v) => v && containsMatch(v, selfName));
      if (selfPresent) selfPresentBySize[bi] += 1;

      const res = await identifySpeakers({ apiKey, transcript: c.transcript, labels: c.labels, roster, selfName });
      const sugg = 'suggestions' in res ? res.suggestions : [];
      for (let ti = 0; ti < THRESHOLDS.length; ti += 1) {
        const T = THRESHOLDS[ti];
        for (const s of sugg) {
          if (!s.isSelf || s.confidence < T) continue;
          cells[ti][bi].applied += 1;
          const truth = c.expected.get(s.label) ?? null;
          if (truth && containsMatch(truth, selfName)) cells[ti][bi].correct += 1;
        }
      }
    }
    process.stdout.write(`• ${userId.slice(0, 8)}… self=${selfName} cases=${cases.length}\n`);
  }

  for (let ti = 0; ti < THRESHOLDS.length; ti += 1) {
    process.stdout.write(`\n── self auto-apply at conf >= ${THRESHOLDS[ti]} ──\n`);
    process.stdout.write('note-size   applied  correct  precision   (self-present notes)\n');
    let tApplied = 0, tCorrect = 0;
    for (let bi = 0; bi < SIZE_BUCKETS.length; bi += 1) {
      const cell = cells[ti][bi];
      tApplied += cell.applied; tCorrect += cell.correct;
      process.stdout.write(
        `${SIZE_BUCKETS[bi].label.padEnd(9)}   ${String(cell.applied).padStart(6)}   ${String(cell.correct).padStart(6)}   ` +
        `${pct(cell.correct, cell.applied).padStart(6)}       ${String(selfPresentBySize[bi]).padStart(4)}\n`,
      );
    }
    process.stdout.write(`TOTAL       ${String(tApplied).padStart(6)}   ${String(tCorrect).padStart(6)}   ${pct(tCorrect, tApplied).padStart(6)}\n`);
  }
  process.stdout.write('\nRead: a size bucket where precision is high = safe to auto-apply self; a bucket where precision\ncraters = where wrong-self corruption happens. The guard = auto-apply self only in safe buckets.\n');
}

main().catch((e) => { process.stderr.write(`self-precision failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
