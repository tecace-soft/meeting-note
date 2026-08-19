// F8 A/B experiment: does injecting the user's PERSONAL MEMORY into speaker
// identification improve accuracy? The boss believes personal memory is already used
// for speaker ID; it is NOT (ingest uses only the saved-speaker roster). This script
// runs the REAL identifySpeakers producer on the curated golden cases in two arms:
//
//   arm A (prod)      roster only            -> personalMemory = null (byte-identical to prod)
//   arm B (what-if)   roster + personal mem  -> personalMemory = the owner's CURRENT prod memory
//
// Each arm runs N times (LLM is nondeterministic) and we compare mean accuracy /
// auto-apply precision / recall. If arm B shows no lift (or a precision drop), that is
// the evidence that memory does not help speaker ID and would only add noise.
//
// Requires real SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (to read the owner's memory)
// and GEMINI_API_KEY. Read-only. Run: `npm run eval:speaker-ab` (from workflow-server/).

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identifySpeakers } from '../src/memory.js';
import { containsMatch } from './lib/scoring.js';
import type { SpeakerIdGolden } from './lib/types.js';

config();

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, 'golden', 'speaker');
const RESULTS_DIR = join(HERE, 'results');
const AUTO_APPLY_CONFIDENCE = 0.8; // must match index.ts AUTO_IDENTIFY_CONFIDENCE
const RUNS = Math.max(1, Math.min(20, Number(process.env.SPEAKER_AB_RUNS) || 5));
const MAX_CASES = 20;

interface ArmScore {
  accuracy: number;
  precision: number;
  recall: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** Load every golden speaker case. */
function loadGolden(): SpeakerIdGolden[] {
  const files = readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .slice(0, MAX_CASES);
  return files.map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')) as SpeakerIdGolden);
}

/** Render a stored user_memory row into the active-items text the UI shows. */
function renderActiveMemory(memory: unknown): string {
  const obj = memory && typeof memory === 'object' ? (memory as Record<string, unknown>) : {};
  const items = Array.isArray(obj.items) ? obj.items : [];
  const lines: string[] = [];
  for (const raw of items) {
    const it = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (it.status === 'archived') continue;
    const text = typeof it.text === 'string' ? it.text.trim() : '';
    if (text) lines.push(`- ${text}`);
  }
  return lines.join('\n');
}

/** Owner user_id for a note, then that user's rendered active memory. Cached per user. */
async function memoryForNote(
  db: SupabaseClient,
  noteId: string | undefined,
  memoByUser: Map<string, string>,
): Promise<{ userId: string | null; text: string }> {
  if (!noteId) return { userId: null, text: '' };
  const { data: noteRow } = await db.from('note').select('user_id').eq('id', noteId).maybeSingle();
  const userId = (noteRow as { user_id?: string } | null)?.user_id ?? null;
  if (!userId) return { userId: null, text: '' };
  if (memoByUser.has(userId)) return { userId, text: memoByUser.get(userId) as string };
  const { data: memRow } = await db.from('user_memory').select('memory').eq('user_id', userId).maybeSingle();
  const text = renderActiveMemory((memRow as { memory?: unknown } | null)?.memory ?? null);
  memoByUser.set(userId, text);
  return { userId, text };
}

/** Score one identify run against ground truth, mirroring the ingest auto-apply rule. */
function scoreRun(
  suggestions: Array<{ label: string; name: string | null; confidence: number; isSelf: boolean }>,
  golden: SpeakerIdGolden,
): ArmScore {
  const byLabel = new Map(suggestions.map((s) => [s.label, s]));
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const exp of golden.expected) {
    const s = byLabel.get(exp.label);
    const applied = s && s.confidence >= AUTO_APPLY_CONFIDENCE
      ? (s.isSelf && golden.selfName ? golden.selfName : s.name)
      : null;
    if (applied && exp.name && containsMatch(exp.name, applied)) tp += 1;
    else if (applied) fp += 1;
    else if (exp.name) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const accuracy = golden.expected.length > 0 ? (tp + tn) / golden.expected.length : 0;
  return { accuracy, precision, recall, tp, fp, fn, tn };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Run one arm N times and average. personalMemory=null → arm A (prod); string → arm B. */
async function runArm(golden: SpeakerIdGolden, apiKey: string, personalMemory: string | null): Promise<ArmScore> {
  const runs: ArmScore[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const res = await identifySpeakers({
      apiKey,
      transcript: golden.transcript,
      labels: golden.labels,
      roster: golden.roster,
      selfName: golden.selfName ?? null,
      personalMemory,
    });
    if ('error' in res) {
      runs.push({ accuracy: 0, precision: 0, recall: 0, tp: 0, fp: 0, fn: golden.expected.length, tn: 0 });
      continue;
    }
    runs.push(scoreRun(res.suggestions, golden));
  }
  return {
    accuracy: mean(runs.map((r) => r.accuracy)),
    precision: mean(runs.map((r) => r.precision)),
    recall: mean(runs.map((r) => r.recall)),
    tp: mean(runs.map((r) => r.tp)),
    fp: mean(runs.map((r) => r.fp)),
    fn: mean(runs.map((r) => r.fn)),
    tn: mean(runs.map((r) => r.tn)),
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function delta(b: number, a: number): string {
  const d = (b - a) * 100;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(1)}pt`;
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write('GEMINI_API_KEY is required.\n');
    process.exit(1);
  }
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key || url.includes('your-project-ref') || key.includes('your-supabase')) {
    process.stderr.write('Real SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (this A/B reads the owner\'s prod memory).\n');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const golden = loadGolden();
  if (golden.length === 0) {
    process.stderr.write('No golden speaker cases found.\n');
    process.exit(1);
  }

  process.stdout.write(`\nSPEAKER-ID A/B — does personal memory help? (${RUNS} runs/arm, ${golden.length} cases)\n`);
  process.stdout.write('arm A = roster only (prod)   arm B = roster + owner personal memory\n\n');

  const memoByUser = new Map<string, string>();
  const rows: Array<{ name: string; memChars: number; a: ArmScore; b: ArmScore }> = [];

  for (const g of golden) {
    const { text: memText } = await memoryForNote(db, g.noteId, memoByUser);
    process.stdout.write(`• ${g.name}: memory ${memText ? `${memText.length} chars` : 'EMPTY (arm B == arm A)'} … `);
    const a = await runArm(g, apiKey, null);
    const b = await runArm(g, apiKey, memText || null);
    rows.push({ name: g.name, memChars: memText.length, a, b });
    process.stdout.write(`accA=${pct(a.accuracy)} accB=${pct(b.accuracy)} (${delta(b.accuracy, a.accuracy)})\n`);
  }

  // Aggregate (macro-average across cases).
  const agg = (pick: (r: ArmScore) => number, arm: 'a' | 'b'): number => mean(rows.map((r) => pick(r[arm])));

  process.stdout.write('\n─────────────────────────────────────────────────────────────\n');
  process.stdout.write('CASE                          accA   accB    Δacc   precA  precB   recA   recB\n');
  for (const r of rows) {
    process.stdout.write(
      `${r.name.padEnd(28).slice(0, 28)}  ${pct(r.a.accuracy).padStart(5)} ${pct(r.b.accuracy).padStart(6)} ${delta(r.b.accuracy, r.a.accuracy).padStart(7)}  ` +
      `${pct(r.a.precision).padStart(5)} ${pct(r.b.precision).padStart(6)}  ${pct(r.a.recall).padStart(5)} ${pct(r.b.recall).padStart(6)}\n`,
    );
  }
  const accA = agg((r) => r.accuracy, 'a'), accB = agg((r) => r.accuracy, 'b');
  const precA = agg((r) => r.precision, 'a'), precB = agg((r) => r.precision, 'b');
  const recA = agg((r) => r.recall, 'a'), recB = agg((r) => r.recall, 'b');
  process.stdout.write('─────────────────────────────────────────────────────────────\n');
  process.stdout.write(
    `${'AGGREGATE (macro-avg)'.padEnd(28)}  ${pct(accA).padStart(5)} ${pct(accB).padStart(6)} ${delta(accB, accA).padStart(7)}  ` +
    `${pct(precA).padStart(5)} ${pct(precB).padStart(6)}  ${pct(recA).padStart(5)} ${pct(recB).padStart(6)}\n\n`,
  );

  // Plain-language verdict for the boss.
  const dAcc = (accB - accA) * 100, dPrec = (precB - precA) * 100, dRec = (recB - recA) * 100;
  const noLift = dAcc <= 1 && dRec <= 1;
  const hurtsPrecision = dPrec < -1;
  process.stdout.write('VERDICT: ');
  if (noLift && !hurtsPrecision) {
    process.stdout.write(`no meaningful lift (Δacc ${dAcc.toFixed(1)}pt, Δrecall ${dRec.toFixed(1)}pt). Personal memory does not improve speaker ID.\n`);
  } else if (hurtsPrecision) {
    process.stdout.write(`arm B HURTS precision (Δprec ${dPrec.toFixed(1)}pt) — injecting memory adds false auto-applies.\n`);
  } else {
    process.stdout.write(`arm B shows a lift (Δacc ${dAcc.toFixed(1)}pt, Δrecall ${dRec.toFixed(1)}pt). Worth a closer look before dismissing.\n`);
  }
  process.stdout.write('NOTE: 4 curated golden cases (small N); all owned by the same self. A signal, not a definitive study.\n');

  // Snapshot for the record (includes the exact memory text injected, for audit).
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapPath = join(RESULTS_DIR, `speaker-ab-${stamp}.json`);
  writeFileSync(
    snapPath,
    JSON.stringify(
      {
        runsPerArm: RUNS,
        aggregate: { accA, accB, precA, precB, recA, recB, dAcc, dPrec, dRec },
        cases: rows,
        injectedMemory: Object.fromEntries(memoByUser),
      },
      null,
      2,
    ),
  );
  process.stdout.write(`snapshot: ${snapPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`speaker-ab failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
