// SPEAKER-ID ROOT-CAUSE DIAGNOSIS (read-only).
//
// The 2026-08-25 coverage data showed some users are FULLY covered (all their people are in
// the roster WITH rich profiles) yet still identify poorly (e.g. user 31d79bfe: 83% rich
// profiles, 0% roster gap, but ~14% backtest accuracy). So coverage is not their bottleneck.
// This script replays identify over a user's labeled notes and CLASSIFIES every label error to
// find the DOMINANT failure mode, testing two hypotheses:
//
//   H1 OVER-SEGMENTATION: one real person is split across several speakerKeys, so the identifier
//      must map more labels than there are people and ground truth has one person under many
//      keys. Measured per note: does any truth NAME occur under >1 speakerKey?
//   H2 LOW DISCRIMINABILITY: same-team people have similar profiles, so the model confuses one
//      roster member for another. Measured: of "confusion" errors (predicted a real but WRONG
//      name), how many predicted names are themselves ROSTER members (a within-roster mix-up)?
//
// Error types per label (ground truth = the display name the user gave that speakerKey):
//   correct     predicted name matches truth
//   abstain     truth has a name, model predicted null (a recall miss, not a wrong name)
//   confusion   model predicted a real name that is WRONG (the discriminability failure)
//   wrong-self  model marked isSelf on a label whose truth is NOT the self
//   false-name  truth was null (user left it anonymous) but model named it
//
// Read-only. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY.
// Run: `npm run eval:speaker-diagnose` (from workflow-server/).
//
// Tunables (env):
//   DIAG_USERS         comma-separated user_ids (default 31d79bfe... the well-covered failer)
//   DIAG_NOTES         notes per user (default 20)
//   DIAG_MIN_NAMED     min distinct real names a note must have (default 2)
//   DIAG_SELF_NAMES    JSON { "<userId>": "Display Name" } to pin self (else inferred)
//   DIAG_SHOW          per-label rows to print per user (default 40; 0 = none)

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { identifySpeakers, type SpeakerRosterEntry } from '../src/memory.js';
import { containsMatch } from './lib/scoring.js';
import { norm } from './lib/util.js';

config();

const DEFAULT_USER = '31d79bfe';
const NOTES = clampInt(process.env.DIAG_NOTES, 20, 1, 60);
const MIN_NAMED = clampInt(process.env.DIAG_MIN_NAMED, 2, 1, 10);
const SHOW = clampInt(process.env.DIAG_SHOW, 40, 0, 500);

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

interface Segment { speaker?: unknown; speakerKey?: unknown; text?: unknown }
interface NoteRow { id: string; user_id: string; created_at: string; diarization: unknown }

const isAnonName = (s: string): boolean =>
  /^speaker\s/i.test(s.trim()) || s.trim() === '' || s.trim() === 'Unknown Speaker' || /^unknown/i.test(s.trim());

interface DiagCase {
  noteId: string;
  transcript: string;
  labels: string[];
  expected: Map<string, string | null>; // speakerKey -> truth name (or null)
  overSegPersons: number; // truth names occurring under >1 speakerKey
  nTruthNames: number;
}

function toCase(note: NoteRow): DiagCase | null {
  const segs = Array.isArray(note.diarization) ? (note.diarization as Segment[]) : [];
  const keyed = segs.filter(
    (s) => s && typeof s.text === 'string' && typeof s.speakerKey === 'string' && (s.speakerKey as string).trim(),
  );
  if (keyed.length === 0 || keyed.length < segs.length) return null;

  const expected = new Map<string, string | null>();
  const nameToKeys = new Map<string, Set<string>>();
  for (const s of keyed) {
    const key = (s.speakerKey as string).trim();
    const display = typeof s.speaker === 'string' ? s.speaker.trim() : '';
    const real = display && !isAnonName(display) ? display : null;
    if (!expected.has(key)) expected.set(key, real);
    else if (real && !expected.get(key)) expected.set(key, real);
    if (real) {
      const nk = norm(real);
      const set = nameToKeys.get(nk) ?? new Set<string>();
      set.add(key);
      nameToKeys.set(nk, set);
    }
  }
  const labels = Array.from(expected.keys());
  const truthNames = Array.from(nameToKeys.keys());
  if (truthNames.length < MIN_NAMED) return null;
  const overSegPersons = Array.from(nameToKeys.values()).filter((keys) => keys.size > 1).length;

  const transcript = keyed.map((s) => `${(s.speakerKey as string).trim()}: ${s.text as string}`).join('\n');
  return { noteId: note.id, transcript, labels, expected, overSegPersons, nTruthNames: truthNames.length };
}

async function loadRoster(db: SupabaseClient, userId: string): Promise<SpeakerRosterEntry[]> {
  const { data } = await db.from('speaker').select('id, name, profile').eq('user_id', userId);
  return ((data ?? []) as Array<{ id: string | number; name: string; profile: string | null }>)
    .filter((r) => r.name)
    .map((r) => ({ speakerId: String(r.id), name: r.name, summary: r.profile ?? '' }));
}

async function loadCases(db: SupabaseClient, userId: string): Promise<DiagCase[]> {
  const { data } = await db
    .from('note')
    .select('id, user_id, created_at, diarization')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(NOTES * 5);
  const rows = (data ?? []) as NoteRow[];
  const cases: DiagCase[] = [];
  for (const r of rows) {
    const c = toCase(r);
    if (c) cases.push(c);
    if (cases.length >= NOTES) break;
  }
  return cases;
}

function inferSelf(cases: DiagCase[]): string | null {
  const counts = new Map<string, { raw: string; n: number }>();
  for (const c of cases) {
    const seen = new Set<string>();
    for (const v of c.expected.values()) {
      if (!v) continue;
      const k = norm(v);
      if (seen.has(k)) continue;
      seen.add(k);
      const e = counts.get(k) ?? { raw: v, n: 0 };
      e.n += 1;
      counts.set(k, e);
    }
  }
  let best: { raw: string; n: number } | null = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  if (best && cases.length && best.n / cases.length >= 0.6) return best.raw;
  return null;
}

const pct = (num: number, den: number): string => (den ? `${((num / den) * 100).toFixed(0)}%` : '  -');

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey || !url || !key) {
    process.stderr.write('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY required.\n');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  let pinned: Record<string, string> = {};
  if (process.env.DIAG_SELF_NAMES) {
    try { pinned = JSON.parse(process.env.DIAG_SELF_NAMES); } catch { /* ignore */ }
  }
  const users = (process.env.DIAG_USERS || DEFAULT_USER).split(',').map((u) => u.trim()).filter(Boolean);

  for (const userPrefix of users) {
    // Resolve full user_id from a prefix by scanning speakers (prefixes are convenient to type).
    const { data: sp } = await db.from('speaker').select('user_id').ilike('user_id', `${userPrefix}%`).limit(1);
    const userId = (sp?.[0] as { user_id: string } | undefined)?.user_id ?? userPrefix;

    const cases = await loadCases(db, userId);
    if (cases.length === 0) { process.stdout.write(`\n${userPrefix}: no qualifying notes\n`); continue; }
    const roster = await loadRoster(db, userId);
    const rosterKeys = new Set(roster.map((r) => norm(r.name)));
    const selfName = pinned[userId] ?? inferSelf(cases);

    let correct = 0, abstain = 0, confusion = 0, wrongSelf = 0, falseName = 0, totalTruth = 0, totalLabels = 0;
    let confusionInRoster = 0;
    let overSegNotes = 0, cleanNotes = 0;
    let overSegTruth = 0, overSegCorrect = 0, cleanTruth = 0, cleanCorrect = 0;
    const rows: string[] = [];

    process.stdout.write(`\n══ ${userPrefix} (self=${selfName ?? 'unknown'}, roster=${roster.length}, notes=${cases.length}) ══\n`);

    for (const c of cases) {
      const res = await identifySpeakers({ apiKey, transcript: c.transcript, labels: c.labels, roster, selfName });
      const byLabel = new Map(('suggestions' in res ? res.suggestions : []).map((s) => [s.label, s]));
      const noteOverSeg = c.overSegPersons > 0;
      if (noteOverSeg) overSegNotes += 1; else cleanNotes += 1;

      for (const label of c.labels) {
        totalLabels += 1;
        const truth = c.expected.get(label) ?? null;
        const s = byLabel.get(label);
        const pred = s ? (s.isSelf && selfName ? selfName : s.name) : null;
        let type = '';
        if (truth) {
          totalTruth += 1;
          if (noteOverSeg) overSegTruth += 1; else cleanTruth += 1;
          if (pred && containsMatch(truth, pred)) {
            type = 'correct'; correct += 1;
            if (noteOverSeg) overSegCorrect += 1; else cleanCorrect += 1;
          } else if (!pred) {
            type = 'abstain'; abstain += 1;
          } else if (s?.isSelf && selfName && !containsMatch(truth, selfName)) {
            type = 'wrong-self'; wrongSelf += 1; confusion += 1;
            if (rosterKeys.has(norm(pred))) confusionInRoster += 1;
          } else {
            type = 'confusion'; confusion += 1;
            if (rosterKeys.has(norm(pred))) confusionInRoster += 1;
          }
        } else {
          type = pred ? 'false-name' : 'correct(abstain)';
          if (pred) falseName += 1;
        }
        if (rows.length < SHOW) {
          rows.push(
            `  [${type.padEnd(15)}] ${label.padEnd(10)} truth=${(truth ?? '∅').slice(0, 20).padEnd(20)} ` +
            `pred=${(pred ?? '∅').slice(0, 20).padEnd(20)} conf=${(s?.confidence ?? 0).toFixed(2)}${s?.isSelf ? ' SELF' : ''}` +
            `${noteOverSeg ? ' [note-overseg]' : ''}`,
          );
        }
      }
    }

    if (SHOW > 0) process.stdout.write(rows.join('\n') + '\n');
    process.stdout.write('\n  ── error breakdown (labels with a real truth name) ──\n');
    process.stdout.write(`  truth labels: ${totalTruth}\n`);
    process.stdout.write(`    correct:    ${correct} (${pct(correct, totalTruth)})\n`);
    process.stdout.write(`    abstain:    ${abstain} (${pct(abstain, totalTruth)})   [recall miss — model gave up]\n`);
    process.stdout.write(`    confusion:  ${confusion} (${pct(confusion, totalTruth)})   [predicted WRONG real name — discriminability]\n`);
    process.stdout.write(`      ...of which predicted name is a ROSTER member: ${confusionInRoster} (${pct(confusionInRoster, confusion)}) [within-roster mix-up = H2]\n`);
    process.stdout.write(`      ...of which were wrong-self: ${wrongSelf}\n`);
    process.stdout.write(`  false-name (truth was anonymous, model named it): ${falseName}\n`);
    process.stdout.write('\n  ── H1 over-segmentation ──\n');
    process.stdout.write(`  notes over-segmented (a person under >1 label): ${overSegNotes}/${cases.length} (${pct(overSegNotes, cases.length)})\n`);
    process.stdout.write(`  accuracy on OVER-SEG notes: ${pct(overSegCorrect, overSegTruth)} (${overSegCorrect}/${overSegTruth})\n`);
    process.stdout.write(`  accuracy on CLEAN notes:    ${pct(cleanCorrect, cleanTruth)} (${cleanCorrect}/${cleanTruth})\n`);
    process.stdout.write('  If clean >> over-seg, H1 (over-segmentation) is a major cause. If confusion dominates and is within-roster, H2 (discriminability).\n');
  }
}

main().catch((error) => {
  process.stderr.write(`speaker-diagnose failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
