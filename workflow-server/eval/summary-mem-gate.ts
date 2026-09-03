// STEP-0 GATE: does the already-live personal-memory injection improve summaries
// (cross-meeting continuity) WITHOUT introducing fact-drift? Golden set of OFF-vs-ON
// summary pairs, no human in the loop. Decisions locked 2026-09-03:
//   - judge = gemini-2.5-flash (flash-lite saturates at 75, can't discriminate)
//   - golden = real Andrew notes (do-no-harm arm) + synthetic cross-meeting (mechanism arm)
//   - VARIANCE-AWARE: prod generates at temp 0.1, so a single OFF/ON pair is a noisy
//     estimate. We generate each arm GEN_RUNS times and average the flash-judge continuity
//     → estimate the EXPECTED lift, and print the spread so noise is visible.
//   - DRIFT: the judge's bulk drift COUNT is noisy (nitpicks real summaries), but it (and a
//     plain substring test) reliably catch a SPECIFIC forbidden fact. So drift-guard cases
//     carry an explicit `forbidden` list and we test for those verbatim; bulk drift is info-only.
//
// GATE PASSES when: synthetic mechanism cases show mean continuity lift >= LIFT_MIN; real
// cases do not regress; drift-guard cases never surface a forbidden prior-decision specific.
// Reuses the real summary prompt + model path (temp 0.1, as prod). Read-only DB. Writes a snapshot.
// Run: `npm run eval:summary-mem-gate`   (GEN_RUNS / EVAL_JUDGE_MODEL overridable via env)

import { config } from 'dotenv';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildSummaryPrompt } from '../src/prompts.js';
import { callJsonModel, renderMemoryForContext } from '../src/memory.js';
import { callGemini } from '../src/gemini.js';

config();

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden', 'summary-mem');
const MAX_CASES = 20; // Power-of-Ten rule 1: bounded

const GEN_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.5-flash-lite';
const GEN_FALLBACK = 'gemini-3.1-flash-lite';
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'gemini-2.5-flash';
const GEN_RUNS = Math.min(8, Math.max(1, Number(process.env.GEN_RUNS || '6'))); // bounded avg over gen variance (6 stabilizes small synthetic cases)
const SUMMARY_RULES =
  'Write structured, actionable meeting notes in markdown: a short overview, key decisions, action items (with owner when stated), and open questions.';

// Gate thresholds.
const LIFT_MIN = 10; // synthetic mechanism: mean continuity lift required
const REG_TOL = 15; // real do-no-harm: mean continuity may dip at most this
const FORBID_MAX = 0; // drift-guard: forbidden specifics allowed in ZERO of the ON summaries

interface GoldenCase {
  name: string; kind: 'synthetic' | 'real'; expectHelps: boolean; driftGuard?: boolean;
  forbidden?: string[]; outputLanguage?: 'en' | 'ko'; transcript?: string; memory?: string; noteId?: string;
}
interface Seg { speaker?: string; original?: string; text?: string; translated?: string }
function segText(s: Seg): string { return (s.original ?? s.text ?? s.translated ?? '').trim(); }

function loadGolden(): GoldenCase[] {
  let files: string[];
  try { files = readdirSync(GOLDEN).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.slice(0, MAX_CASES).map((f) => JSON.parse(readFileSync(join(GOLDEN, f), 'utf8')) as GoldenCase);
}

interface Parsed { summary: string }
function parseSummary(text: string): Parsed | null {
  try {
    const o = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')) as Record<string, unknown>;
    return typeof o.summary === 'string' ? { summary: o.summary } : null;
  } catch { return null; }
}
async function generate(apiKey: string, prompt: string): Promise<string | null> {
  const res = await callJsonModel<Parsed>({ apiKey, models: [GEN_MODEL, GEN_FALLBACK], systemPrompt: '', userPrompt: prompt, parse: parseSummary, maxOutputTokens: 16384 });
  return 'error' in res ? null : res.value.summary;
}

interface JudgeOut { continuity: number; drift: number }
function stripFence(s: string): string { return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''); }
async function judge(apiKey: string, transcript: string, memory: string, summary: string): Promise<JudgeOut | null> {
  const prompt = `You are grading a meeting-summary system on TWO independent axes. You are given the meeting TRANSCRIPT, the user's BACKGROUND MEMORY (their confirmed prior context from earlier meetings — this is LEGITIMATE grounding, exactly as trustworthy as the transcript), and a SUMMARY.

1. CONTINUITY (0-100): how well does the summary surface the ongoing-work context that connects this meeting to the user's broader work — the recurring people, projects, and prior decisions — and correctly RESOLVE the transcript's vague references ("the migration", "the quota thing", bare first names, in-group acronyms like "the AX thing"/"FDE") to what they actually are, USING the background memory? Reward a summary that uses the memory to make ambiguous references clear and grounded. Do NOT reward length. A summary that leaves references vague when the memory could have resolved them scores LOW.
2. DRIFT: count of specific claims (person/number/date/decision/action) supported by NEITHER the transcript NOR the background memory. Correctly resolving a reference using the memory is NOT drift. Asserting a specific the memory does not contain (e.g. a made-up number) IS drift.

TRANSCRIPT:
'''
${transcript.slice(0, 24000)}
'''

BACKGROUND MEMORY:
'''
${memory.slice(0, 4000)}
'''

SUMMARY:
'''
${summary.slice(0, 8000)}
'''

Return ONLY JSON: {"continuity": <int 0-100>, "drift": <int count>}`;
  const res = await callGemini({ apiKey, model: JUDGE_MODEL, parts: [{ text: prompt }], responseMimeType: 'application/json', maxOutputTokens: 1024, temperature: 0, thinkingBudget: 0 });
  try {
    const o = JSON.parse(stripFence(res.text)) as Record<string, unknown>;
    const continuity = typeof o.continuity === 'number' ? o.continuity : NaN;
    const drift = typeof o.drift === 'number' ? o.drift : (Array.isArray(o.drift) ? o.drift.length : NaN);
    return Number.isFinite(continuity) ? { continuity, drift: Number.isFinite(drift) ? drift : 0 } : null;
  } catch { return null; }
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function spread(xs: number[]): number { return xs.length ? Math.max(...xs) - Math.min(...xs) : NaN; }
function hasForbidden(summary: string, forbidden: string[]): boolean {
  const s = summary.toLowerCase();
  return forbidden.some((f) => s.includes(f.toLowerCase()));
}

async function resolveCase(db: SupabaseClient, c: GoldenCase): Promise<{ transcript: string; memory: string; lang: 'en' | 'ko' } | null> {
  if (c.kind === 'synthetic') {
    if (!c.transcript || !c.memory) return null;
    return { transcript: c.transcript, memory: c.memory, lang: c.outputLanguage ?? 'en' };
  }
  const { data: note } = await db.from('note').select('user_id, diarization, transcription, transcription_language').eq('id', c.noteId ?? '').maybeSingle();
  if (!note) return null;
  const segs = Array.isArray((note as { diarization?: Seg[] }).diarization) ? (note as { diarization: Seg[] }).diarization : [];
  const transcript = (segs.length ? segs.map((s) => `${s.speaker ?? 'Speaker'}: ${segText(s)}`).join('\n') : String((note as { transcription?: unknown }).transcription ?? '')).trim();
  const { data: memRow } = await db.from('user_memory').select('memory').eq('user_id', (note as { user_id: string }).user_id).maybeSingle();
  const memory = renderMemoryForContext((memRow as { memory?: unknown } | null)?.memory ?? null);
  const lang: 'en' | 'ko' = (note as { transcription_language?: string }).transcription_language === 'en' ? 'en' : 'ko';
  return transcript && memory ? { transcript, memory, lang } : null;
}

interface CaseResult {
  name: string; kind: string; driftGuard: boolean;
  offCont: number[]; onCont: number[]; offDrift: number[]; onDrift: number[]; forbidHits: number;
  lift: number; pass: boolean; why: string;
}

function gateCase(c: GoldenCase, r: Omit<CaseResult, 'pass' | 'why'>): { pass: boolean; why: string } {
  if (c.driftGuard) {
    if (r.forbidHits > FORBID_MAX) return { pass: false, why: `injected forbidden specific in ${r.forbidHits}/${r.onCont.length} ON runs` };
    if (r.lift < -REG_TOL) return { pass: false, why: `regressed ${r.lift.toFixed(1)} < -${REG_TOL}` };
    return { pass: true, why: 'ok' };
  }
  if (c.kind === 'synthetic') {
    if (r.lift < LIFT_MIN) return { pass: false, why: `mean lift ${r.lift.toFixed(1)} < ${LIFT_MIN}` };
    return { pass: true, why: 'ok' };
  }
  if (r.lift < -REG_TOL) return { pass: false, why: `regressed ${r.lift.toFixed(1)} < -${REG_TOL}` };
  return { pass: true, why: 'ok' };
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey || !url || !key) { process.stderr.write('Need GEMINI_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.\n'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const cases = loadGolden();
  if (!cases.length) { process.stderr.write(`No golden cases in ${GOLDEN}\n`); process.exit(1); }

  const results: CaseResult[] = [];
  for (const c of cases) {
    const resolved = await resolveCase(db, c);
    if (!resolved) { process.stdout.write(`  [${c.name}] SKIP (unresolved)\n`); continue; }
    const common = { now: new Date().toISOString(), meetingDate: null, summaryRules: SUMMARY_RULES, fileName: c.name, transcript: resolved.transcript, outputLanguage: resolved.lang };
    const offCont: number[] = []; const onCont: number[] = []; const offDrift: number[] = []; const onDrift: number[] = []; let forbidHits = 0;
    for (let k = 0; k < GEN_RUNS; k += 1) {
      const off = await generate(apiKey, buildSummaryPrompt(common));
      const on = await generate(apiKey, buildSummaryPrompt({ ...common, personalMemoryContext: resolved.memory }));
      if (!off || !on) continue;
      const jo = await judge(apiKey, resolved.transcript, resolved.memory, off);
      const jn = await judge(apiKey, resolved.transcript, resolved.memory, on);
      if (jo) { offCont.push(jo.continuity); offDrift.push(jo.drift); }
      if (jn) { onCont.push(jn.continuity); onDrift.push(jn.drift); }
      if (c.forbidden && on && hasForbidden(on, c.forbidden)) forbidHits += 1;
    }
    if (!offCont.length || !onCont.length) { process.stdout.write(`  [${c.name}] SKIP (generation failed)\n`); continue; }
    const base = { name: c.name, kind: c.kind, driftGuard: !!c.driftGuard, offCont, onCont, offDrift, onDrift, forbidHits, lift: mean(onCont) - mean(offCont) };
    const { pass, why } = gateCase(c, base);
    results.push({ ...base, pass, why });
  }

  process.stdout.write(`\n════════ STEP-0 GATE — memory injection A/B ════════\n`);
  process.stdout.write(`gen=${GEN_MODEL} (temp 0.1, as prod)  judge=${JUDGE_MODEL}  genRuns/arm=${GEN_RUNS}\n\n`);
  for (const r of results) {
    const guard = r.driftGuard ? `  forbidHits ${r.forbidHits}/${r.onCont.length}` : '';
    process.stdout.write(`  ${r.pass ? 'PASS' : 'FAIL'}  [${r.kind}] ${r.name.padEnd(26)}  cont ${mean(r.offCont).toFixed(0)}(±${spread(r.offCont)})→${mean(r.onCont).toFixed(0)}(±${spread(r.onCont)})  lift ${r.lift >= 0 ? '+' : ''}${r.lift.toFixed(1)}  drift ${mean(r.offDrift).toFixed(1)}→${mean(r.onDrift).toFixed(1)}${guard}  ${r.pass ? '' : '<< ' + r.why}\n`);
  }
  const syn = results.filter((r) => r.kind === 'synthetic' && !r.driftGuard);
  const real = results.filter((r) => r.kind === 'real');
  const m = (xs: CaseResult[]) => xs.length ? mean(xs.map((r) => r.lift)).toFixed(1) : 'n/a';
  process.stdout.write(`\n  mechanism mean lift ${m(syn)} (${syn.filter((r) => r.pass).length}/${syn.length})   real mean lift ${m(real)} (${real.filter((r) => r.pass).length}/${real.length})\n`);
  const gatePass = results.length > 0 && results.every((r) => r.pass);
  process.stdout.write(`\n  GATE: ${gatePass ? 'PASS — injection helps on the mechanism arm, no regression, no forbidden injection' : 'FAIL — see cases above; fix injection before building on top'}\n`);

  const snap = { at: new Date().toISOString(), gen: GEN_MODEL, judge: JUDGE_MODEL, genRuns: GEN_RUNS, thresholds: { LIFT_MIN, REG_TOL, FORBID_MAX }, gatePass, results };
  const out = join(HERE, 'results', `summary-mem-gate-${snap.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(snap, null, 2));
  process.stdout.write(`  snapshot: ${out}\n`);
  process.exit(gatePass ? 0 : 1);
}

main().catch((e) => { process.stderr.write(`gate failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
