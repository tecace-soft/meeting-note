// F5.5 speaker-ID BACKTEST against real, already-labeled meetings.
//
// Instead of waiting for live suggestion-feedback to trickle in, this replays the REAL
// `identifySpeakers` producer over each user's recent meetings whose speakers the user
// already named. Ground truth is those names; the anonymous label the model must resolve
// is `segment.speakerKey` (the immutable "Speaker A" set at ingest, preserved across
// renames). So we reconstruct exactly what ingest saw and score the suggestion.
//
// THE leakage guard (why this is not trivially 100%): the roster the identifier reads is
// the user's ACCUMULATED speaker profiles, which normally already contain THIS meeting's
// speakers (the roster was built after the meeting was labeled) — so the model could just
// read the answer off the roster. We therefore run two arms:
//
//   arm "full"      roster as-is (prod behavior; measures real end-to-end accuracy today)
//   arm "excluded"  roster with THIS meeting's ground-truth people removed (measures how
//                   well the model identifies a person it has NOT already profiled here —
//                   the honest generalization signal, and the closest cheap proxy for a
//                   first-time meeting)
//
// The gap between the two arms IS the roster's contribution (and the leakage). We also emit
// a per-confidence-bucket CALIBRATION table (self vs non-self) — the direct measurement of
// the "0.9 confidence but wrong on non-self speakers" overconfidence we saw in live logs.
//
// AUTO-APPLY POLICY comparison: the model output is scored under several auto-apply policies
// on the SAME suggestions (no re-query), so we can quantify the "immediate lever" — e.g.
// self-only auto-apply, or a higher non-self threshold — against today's uniform 0.8 rule.
//
// GROUND-TRUTH CAVEAT: a named speaker may have been AUTO-applied at ingest
// (`autoIdentifySpeakersAtIngest`, >=0.8) rather than user-confirmed. We cannot tell the two
// apart from the diarization alone, so the "full" arm accuracy is best read as an UPPER
// bound (partly self-agreement). Use BACKTEST_BEFORE_DATE to restrict to notes created
// before auto-identify shipped for a cleaner, purely user-labeled ground truth. The
// "excluded" arm and the calibration table are the trustworthy signals.
//
// Requires real SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY. Read-only.
// Run: `npm run eval:speaker-backtest` (from workflow-server/).
//
// Tunables (env):
//   BACKTEST_USERS         comma-separated user_ids, or "all" (default: discover from recent notes)
//   BACKTEST_NOTES_PER_USER  qualifying notes per user (default 12)
//   BACKTEST_MIN_NAMED     min distinct real-named speakers a note must have (default 2)
//   BACKTEST_RUNS          identify runs per note, averaged (default 1)
//   BACKTEST_ROSTER        "full" | "excluded" | "both" (default "both")
//   BACKTEST_SELF_NAMES    JSON { "<userId>": "Display Name" } to pin self (else inferred)
//   BACKTEST_BEFORE_DATE   ISO date; only notes created strictly before it (cleaner ground truth)
//   BACKTEST_SCAN_LIMIT    max recent notes to scan when discovering users (default 500)

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifySpeakers, type SpeakerRosterEntry, type SpeakerSuggestion } from '../src/memory.js';
import { gateSuggestionsWithAnchors } from '../src/speakerAnchors.js';
import { containsMatch } from './lib/scoring.js';
import { norm } from './lib/util.js';

config();

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, 'results');

const NOTES_PER_USER = clampInt(process.env.BACKTEST_NOTES_PER_USER, 12, 1, 50);
const MIN_NAMED = clampInt(process.env.BACKTEST_MIN_NAMED, 2, 1, 10);
const RUNS = clampInt(process.env.BACKTEST_RUNS, 1, 1, 10);
const SCAN_LIMIT = clampInt(process.env.BACKTEST_SCAN_LIMIT, 500, 50, 5000);
const ROSTER_MODE = ((process.env.BACKTEST_ROSTER || 'both').trim().toLowerCase()) as 'full' | 'excluded' | 'both';
const BEFORE_DATE = (process.env.BACKTEST_BEFORE_DATE || '').trim() || null;
// When set, ISOLATE one model (no fallback chain) so the run measures THAT model alone — the
// model-comparison A/B. Empty = prod default chain (resolveModels' primary + fallbacks).
const MODEL = (process.env.BACKTEST_MODEL || '').trim() || null;
// Thinking override for the isolated model. Unset = prod behavior (thinkingBudget 0). Set to
// -1 to OMIT thinkingConfig (let the model think) for models that reject 0 (gemini-3.5-flash-lite).
const THINK = process.env.BACKTEST_THINKING_BUDGET !== undefined && process.env.BACKTEST_THINKING_BUDGET !== ''
  ? Number(process.env.BACKTEST_THINKING_BUDGET) : null;
const CONF_BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.01]; // right-open edges

// Auto-apply policies compared on identical model output. A policy returns the name to
// auto-apply for a label, or null to leave it as a mere suggestion (not applied).
interface LabelRecord {
  conf: number;
  isSelf: boolean;
  suggestedName: string | null; // self resolved to selfName; else the roster name; null if model abstained
  expectedName: string | null; // ground truth; null = user left the label anonymous (abstain is correct)
}
type Policy = (r: LabelRecord) => string | null;
const POLICIES: Array<{ key: string; label: string; apply: Policy }> = [
  { key: 'uniform-0.8', label: 'uniform ≥0.8 (prod today)', apply: (r) => (r.suggestedName && r.conf >= 0.8 ? r.suggestedName : null) },
  { key: 'self-only-0.8', label: 'self-only ≥0.8 (lever)', apply: (r) => (r.suggestedName && r.isSelf && r.conf >= 0.8 ? r.suggestedName : null) },
  { key: 'self0.8-other0.95', label: 'self ≥0.8 / non-self ≥0.95', apply: (r) => (r.suggestedName && r.conf >= (r.isSelf ? 0.8 : 0.95) ? r.suggestedName : null) },
];

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

interface Segment { speaker: string; speakerKey?: string; text: string }
interface NoteRow { id: string; user_id: string; created_at: string; diarization: unknown }

interface BacktestCase {
  noteId: string;
  createdAt: string;
  transcript: string; // rendered with speakerKey labels (what ingest saw)
  labels: string[]; // distinct speakerKeys present
  expected: Map<string, string | null>; // speakerKey -> real name, or null (user left it anonymous)
  groundTruthNames: string[]; // distinct real names in this note (for roster exclusion + self)
}

const isAnonName = (s: string): boolean => /^speaker\s/i.test(s.trim()) || s.trim() === '' || s.trim() === 'Unknown Speaker';

function toCase(note: NoteRow): BacktestCase | null {
  const segs = Array.isArray(note.diarization) ? (note.diarization as Segment[]) : [];
  if (segs.length === 0) return null;
  // Every renamed segment must carry speakerKey, else we cannot recover the anonymous label
  // the model would have seen. Skip such (older) notes rather than guess.
  const keyed = segs.filter((s) => s && typeof s.text === 'string' && typeof s.speakerKey === 'string' && s.speakerKey.trim());
  if (keyed.length < segs.length) return null;

  const expected = new Map<string, string | null>();
  for (const s of keyed) {
    const key = (s.speakerKey as string).trim();
    const display = (s.speaker || '').trim();
    const real = !isAnonName(display) ? display : null;
    if (!expected.has(key)) expected.set(key, real);
    else if (real && !expected.get(key)) expected.set(key, real);
  }
  const labels = Array.from(expected.keys());
  const groundTruthNames = Array.from(new Set(Array.from(expected.values()).filter((v): v is string => !!v)));
  if (groundTruthNames.length < MIN_NAMED) return null;

  const transcript = keyed.map((s) => `${(s.speakerKey as string).trim()}: ${s.text}`).join('\n');
  return { noteId: note.id, createdAt: note.created_at, transcript, labels, expected, groundTruthNames };
}

/** Turn one identify result into per-label records (one per label in the case). */
function toRecords(suggestions: SpeakerSuggestion[], c: BacktestCase, selfName: string | null): LabelRecord[] {
  const byLabel = new Map(suggestions.map((s) => [s.label, s]));
  return c.labels.map((label) => {
    const s = byLabel.get(label);
    const suggestedName = s ? (s.isSelf && selfName ? selfName : s.name) : null;
    return { conf: s?.confidence ?? 0, isSelf: !!s?.isSelf, suggestedName, expectedName: c.expected.get(label) ?? null };
  });
}

interface PRF { accuracy: number; precision: number; recall: number; tp: number; fp: number; fn: number; tn: number }

function scoreUnder(records: LabelRecord[], policy: Policy): PRF {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of records) {
    const applied = policy(r);
    if (applied && r.expectedName && containsMatch(r.expectedName, applied)) tp += 1;
    else if (applied) fp += 1;
    else if (r.expectedName) fn += 1;
    else tn += 1;
  }
  const total = tp + fp + fn + tn;
  return {
    accuracy: total ? (tp + tn) / total : 0,
    precision: tp + fp ? tp / (tp + fp) : 1,
    recall: tp + fn ? tp / (tp + fn) : 1,
    tp, fp, fn, tn,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

// Paired anchor A/B: identify ONCE per run, then score the SAME model output both raw (off) and
// through the deterministic evidence-anchor layer (on). Pairing removes model stochasticity from
// the comparison AND halves the Gemini calls vs two separate runs.
interface ArmRecords { off: LabelRecord[]; on: LabelRecord[] }

async function collectRecords(c: BacktestCase, apiKey: string, roster: SpeakerRosterEntry[], selfName: string | null): Promise<ArmRecords> {
  const out: ArmRecords = { off: [], on: [] };
  for (let i = 0; i < RUNS; i += 1) {
    // MODEL set → isolate that one model (fallbackModels:[] so resolveModels returns just it).
    const res = await identifySpeakers({
      apiKey, transcript: c.transcript, labels: c.labels, roster, selfName,
      ...(MODEL ? { model: MODEL, fallbackModels: [] } : {}),
      ...(THINK !== null && Number.isFinite(THINK) ? { thinkingBudget: THINK } : {}),
    });
    // A failed call = the model produced nothing → toRecords yields an abstain for every label,
    // identically for both arms (the anchor layer over [] is still []).
    const raw: SpeakerSuggestion[] = 'error' in res ? [] : res.suggestions;
    const anchored = gateSuggestionsWithAnchors(raw, c.transcript, c.labels, roster, selfName);
    out.off.push(...toRecords(raw, c, selfName));
    out.on.push(...toRecords(anchored, c, selfName));
  }
  return out;
}

// Suggestion quality for the NON-SELF picks the user is actually shown (the boss's complaint is
// about garbage SUGGESTIONS, not auto-apply, which is already self-only). precision = of non-self
// names shown at/above the display floor, the fraction correct. confident-WRONG = non-self names
// asserted at >=0.8 that are wrong — the number the anchor layer must drive DOWN.
interface SuggQuality { shown: number; correct: number; precision: number; confShown: number; confWrong: number }
function suggestionQuality(records: LabelRecord[], floor = 0.5): SuggQuality {
  let shown = 0, correct = 0, confShown = 0, confWrong = 0;
  for (const r of records) {
    if (r.isSelf || !r.suggestedName) continue;
    const right = !!r.expectedName && containsMatch(r.expectedName, r.suggestedName);
    if (r.conf >= floor) { shown += 1; if (right) correct += 1; }
    if (r.conf >= 0.8) { confShown += 1; if (!right) confWrong += 1; }
  }
  return { shown, correct, precision: shown ? correct / shown : 1, confShown, confWrong };
}

async function loadRoster(db: SupabaseClient, userId: string): Promise<SpeakerRosterEntry[]> {
  const { data } = await db.from('speaker').select('id, name, profile').eq('user_id', userId);
  return ((data ?? []) as Array<{ id: string | number; name: string; profile: string | null }>)
    .filter((r) => r.name)
    .map((r) => ({ speakerId: String(r.id), name: r.name, summary: r.profile ?? '' }));
}

function excludeMeetingSpeakers(roster: SpeakerRosterEntry[], groundTruthNames: string[]): SpeakerRosterEntry[] {
  return roster.filter((r) => !groundTruthNames.some((gt) => containsMatch(gt, r.name)));
}

function resolveSelfName(userId: string, cases: BacktestCase[], pinned: Record<string, string>): { name: string | null; basis: string } {
  if (pinned[userId]) return { name: pinned[userId], basis: 'pinned' };
  const noteCount = new Map<string, string>(); // norm -> raw (first seen)
  const counts = new Map<string, number>();
  for (const c of cases) {
    for (const n of c.groundTruthNames) {
      const k = norm(n);
      counts.set(k, (counts.get(k) || 0) + 1);
      if (!noteCount.has(k)) noteCount.set(k, n);
    }
  }
  let bestKey: string | null = null, bestCount = 0;
  for (const [k, count] of counts) if (count > bestCount) { bestCount = count; bestKey = k; }
  if (!bestKey || cases.length === 0) return { name: null, basis: 'none' };
  const frac = bestCount / cases.length;
  const raw = noteCount.get(bestKey) as string;
  if (frac >= 0.6) return { name: raw, basis: `inferred (${bestCount}/${cases.length} notes)` };
  return { name: null, basis: `unresolved (top ${raw} only ${bestCount}/${cases.length})` };
}

async function loadUserCases(db: SupabaseClient, userId: string): Promise<BacktestCase[]> {
  let q = db.from('note').select('id, user_id, created_at, diarization').eq('user_id', userId).order('created_at', { ascending: false }).limit(NOTES_PER_USER * 5);
  if (BEFORE_DATE) q = q.lt('created_at', BEFORE_DATE);
  const { data } = await q;
  const rows = (data ?? []) as NoteRow[];
  const cases: BacktestCase[] = [];
  for (const r of rows) {
    const c = toCase(r);
    if (c) cases.push(c);
    if (cases.length >= NOTES_PER_USER) break;
  }
  return cases;
}

async function discoverUsers(db: SupabaseClient): Promise<string[]> {
  let q = db.from('note').select('id, user_id, created_at, diarization').order('created_at', { ascending: false }).limit(SCAN_LIMIT);
  if (BEFORE_DATE) q = q.lt('created_at', BEFORE_DATE);
  const { data } = await q;
  const rows = (data ?? []) as NoteRow[];
  const byUser = new Map<string, number>();
  for (const r of rows) if (toCase(r)) byUser.set(r.user_id, (byUser.get(r.user_id) || 0) + 1);
  return Array.from(byUser.entries()).filter(([, n]) => n >= MIN_NAMED).map(([u]) => u);
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey) { process.stderr.write('GEMINI_API_KEY is required.\n'); process.exit(1); }
  if (!url || !key || url.includes('your-project-ref') || key.includes('your-supabase')) {
    process.stderr.write('Real SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (reads prod notes + rosters, read-only).\n');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  let pinned: Record<string, string> = {};
  if (process.env.BACKTEST_SELF_NAMES) {
    try { pinned = JSON.parse(process.env.BACKTEST_SELF_NAMES); } catch { process.stderr.write('BACKTEST_SELF_NAMES is not valid JSON — ignoring.\n'); }
  }

  const usersArg = (process.env.BACKTEST_USERS || 'all').trim();
  const users = usersArg && usersArg !== 'all'
    ? usersArg.split(',').map((u) => u.trim()).filter(Boolean)
    : await discoverUsers(db);

  process.stdout.write(`\nSPEAKER-ID BACKTEST — replay identify over real labeled meetings\n`);
  process.stdout.write(`users=${users.length}  notes/user<=${NOTES_PER_USER}  min-named=${MIN_NAMED}  runs=${RUNS}  roster=${ROSTER_MODE}  model=${MODEL ?? 'prod-chain'}  thinking=${THINK === null ? '0(prod)' : (THINK < 0 ? 'model-decides' : THINK)}${BEFORE_DATE ? `  before=${BEFORE_DATE}` : ''}\n\n`);

  const doFull = ROSTER_MODE === 'full' || ROSTER_MODE === 'both';
  const doExcl = ROSTER_MODE === 'excluded' || ROSTER_MODE === 'both';

  const full: ArmRecords = { off: [], on: [] };
  const excl: ArmRecords = { off: [], on: [] };
  const perUser: Array<{ userId: string; basis: string; cases: number; full: PRF | null; excl: PRF | null }> = [];
  const prodPolicy = POLICIES[0].apply;

  for (const userId of users) {
    const cases = await loadUserCases(db, userId);
    if (cases.length === 0) { process.stdout.write(`• ${userId.slice(0, 8)}… no qualifying notes\n`); continue; }
    const roster = await loadRoster(db, userId);
    const { name: selfName, basis } = resolveSelfName(userId, cases, pinned);

    const uFull: ArmRecords = { off: [], on: [] };
    const uExcl: ArmRecords = { off: [], on: [] };
    for (const c of cases) {
      if (doFull) { const r = await collectRecords(c, apiKey, roster, selfName); uFull.off.push(...r.off); uFull.on.push(...r.on); }
      if (doExcl) { const r = await collectRecords(c, apiKey, excludeMeetingSpeakers(roster, c.groundTruthNames), selfName); uExcl.off.push(...r.off); uExcl.on.push(...r.on); }
    }
    full.off.push(...uFull.off); full.on.push(...uFull.on);
    excl.off.push(...uExcl.off); excl.on.push(...uExcl.on);
    const f = doFull ? scoreUnder(uFull.off, prodPolicy) : null;
    const e = doExcl ? scoreUnder(uExcl.off, prodPolicy) : null;
    perUser.push({ userId, basis, cases: cases.length, full: f, excl: e });
    process.stdout.write(
      `• ${userId.slice(0, 8)}…  self=${basis}  cases=${cases.length}  ` +
      (f ? `full acc=${pct(f.accuracy)} rec=${pct(f.recall)} prec=${pct(f.precision)}  ` : '') +
      (e ? `excl acc=${pct(e.accuracy)} rec=${pct(e.recall)} prec=${pct(e.precision)}` : '') + '\n',
    );
  }

  // ---- ANCHOR A/B: aggregate under the prod policy, off vs on (micro-avg over all labels) ----
  process.stdout.write('\n──────────────────────────────────────────────────────────────\n');
  process.stdout.write(`ANCHOR A/B — deterministic evidence-anchor layer OFF vs ON (${perUser.length} users)\n`);
  const line = (tag: string, s: PRF) => `  ${tag.padEnd(26)} acc ${pct(s.accuracy)}  recall ${pct(s.recall)}  precision ${pct(s.precision)}\n`;
  if (doFull) {
    process.stdout.write('full roster (prod today):\n');
    process.stdout.write(line('OFF (raw model)', scoreUnder(full.off, prodPolicy)));
    process.stdout.write(line('ON  (anchored)', scoreUnder(full.on, prodPolicy)));
  }
  if (doExcl) {
    process.stdout.write('meeting excluded (general):\n');
    process.stdout.write(line('OFF (raw model)', scoreUnder(excl.off, prodPolicy)));
    process.stdout.write(line('ON  (anchored)', scoreUnder(excl.on, prodPolicy)));
  }
  process.stdout.write('  GATE: self recall must NOT drop OFF→ON (the anchor layer never touches the self path).\n');

  // ---- SUGGESTION QUALITY (non-self) — the headline the anchor layer targets ----
  process.stdout.write('\nSUGGESTION QUALITY (non-self picks shown to the user)\n');
  process.stdout.write('arm / anchors     shown(>=0.5)  precision   confident(>=0.8)  confident-WRONG\n');
  const sqRow = (tag: string, q: SuggQuality) =>
    `${tag.padEnd(18)}${String(q.shown).padStart(9)}   ${pct(q.precision).padStart(7)}   ${String(q.confShown).padStart(12)}   ${String(q.confWrong).padStart(13)}\n`;
  const fullOffSQ = suggestionQuality(full.off), fullOnSQ = suggestionQuality(full.on);
  const exclOffSQ = suggestionQuality(excl.off), exclOnSQ = suggestionQuality(excl.on);
  if (doFull) { process.stdout.write(sqRow('full  OFF', fullOffSQ)); process.stdout.write(sqRow('full  ON', fullOnSQ)); }
  if (doExcl) { process.stdout.write(sqRow('excl  OFF', exclOffSQ)); process.stdout.write(sqRow('excl  ON', exclOnSQ)); }
  process.stdout.write('  GATE: confident-WRONG should DROP and precision hold/rise OFF→ON.\n');

  // ---- Calibration (full arm, ON = the anchored proposal) ----
  const src = doFull ? full.on : excl.on;
  const calib = CONF_BUCKETS.slice(0, -1).map(() => ({ self: { n: 0, ok: 0 }, other: { n: 0, ok: 0 } }));
  for (const r of src) {
    if (!r.suggestedName) continue;
    const bi = CONF_BUCKETS.findIndex((edge, i) => i < CONF_BUCKETS.length - 1 && r.conf >= edge && r.conf < CONF_BUCKETS[i + 1]);
    if (bi < 0) continue;
    const cell = r.isSelf ? calib[bi].self : calib[bi].other;
    cell.n += 1;
    if (r.expectedName && containsMatch(r.expectedName, r.suggestedName)) cell.ok += 1;
  }
  process.stdout.write(`\nCALIBRATION — empirical accuracy per stated-confidence bucket (${doFull ? 'full' : 'excluded'} arm, anchors ON)\n`);
  process.stdout.write('bucket        self acc (n)        non-self acc (n)\n');
  for (let i = 0; i < calib.length; i += 1) {
    const lo = CONF_BUCKETS[i], hi = CONF_BUCKETS[i + 1];
    const s = calib[i].self, o = calib[i].other;
    process.stdout.write(`${lo.toFixed(1)}-${(hi > 1 ? 1 : hi).toFixed(2)}    ${(s.n ? pct(s.ok / s.n) : '  -  ').padStart(7)} (${String(s.n).padStart(3)})       ${(o.n ? pct(o.ok / o.n) : '  -  ').padStart(7)} (${String(o.n).padStart(3)})\n`);
  }
  process.stdout.write('  Well-calibrated = empirical accuracy ≈ the bucket; a high bucket far below 100% is overconfidence.\n');

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const modelTag = MODEL ? `-${MODEL.replace(/[^a-z0-9.]/gi, '_')}` : '';
  const snapPath = join(RESULTS_DIR, `speaker-backtest${modelTag}-${stamp}.json`);
  writeFileSync(snapPath, JSON.stringify({
    params: { NOTES_PER_USER, MIN_NAMED, RUNS, ROSTER_MODE, BEFORE_DATE, MODEL },
    anchorAB: {
      full: { off: scoreUnder(full.off, prodPolicy), on: scoreUnder(full.on, prodPolicy) },
      excluded: doExcl ? { off: scoreUnder(excl.off, prodPolicy), on: scoreUnder(excl.on, prodPolicy) } : null,
    },
    suggestionQuality: {
      full: { off: fullOffSQ, on: fullOnSQ },
      excluded: doExcl ? { off: exclOffSQ, on: exclOnSQ } : null,
    },
    calibration: calib.map((c, i) => ({ bucket: `${CONF_BUCKETS[i]}-${CONF_BUCKETS[i + 1]}`, ...c })),
    users: perUser.map((u) => ({ userId: u.userId, selfBasis: u.basis, cases: u.cases, full: u.full, excluded: u.excl })),
  }, null, 2));
  process.stdout.write(`\nsnapshot: ${snapPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`speaker-backtest failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
