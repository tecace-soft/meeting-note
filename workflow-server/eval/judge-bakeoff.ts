// STEP-0 SCORER BAKE-OFF (exploratory, not the final gate). Question: for the
// memory-injection A/B, which SCORER do we trust to run without a human each time —
// a deterministic entity-carryover/drift metric, or an LLM judge?
//
// It does NOT decide whether memory helps. It compares the two SCORERS on the same
// OFF/ON summary pairs, on three axes:
//   1. judge NOISE   — run the judge K times on the same summary; how much does it swing?
//   2. drift SENSITIVITY — inject a known-fabricated fact; does each detector catch it?
//   3. value SIGNAL  — does deterministic carryover track the judge's continuity score?
//
// Reuses the REAL summary prompt + model path (same as eval:summary-mem). Read-only DB.
// Run: `npx tsx eval/judge-bakeoff.ts [noteId ...]`  (defaults to 3 recent Andrew notes).

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { buildSummaryPrompt } from '../src/prompts.js';
import { callJsonModel, renderMemoryForContext } from '../src/memory.js';
import { callGemini } from '../src/gemini.js';

config();

const DEFAULT_NOTES = [
  'c729912a-3951-414c-abc5-cafc4f2233de', // 2026-09-03
  '1e0d45b0-3336-4baa-a5bd-493d69632115', // 2026-08-28
  'a9db2cc3-cc04-4e69-b87c-6a5304d65e0b', // 2026-08-25
];
const GEN_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.5-flash-lite';
const GEN_FALLBACK = 'gemini-3.1-flash-lite';
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'gemini-2.5-flash';
const JUDGE_RUNS = 3; // measure judge variance (Power-of-Ten rule 2: bounded)
const SUMMARY_RULES =
  'Write structured, actionable meeting notes in markdown: a short overview, key decisions, action items (with owner when stated), and open questions.';
// A fabricated fact grounded in NOTHING — the drift-sensitivity probe.
const FABRICATION = '\n\n**Budget:** Priya Raman approved a $4.2M budget increase for Q3, effective immediately.';

interface Seg { speaker?: string; original?: string; text?: string; translated?: string }
function segText(s: Seg): string { return (s.original ?? s.text ?? s.translated ?? '').trim(); }

interface Parsed { title: string; summary: string; tags: string[] }
function parseSummary(text: string): Parsed | null {
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const o = JSON.parse(cleaned) as Record<string, unknown>;
    if (typeof o.summary !== 'string') return null;
    return { title: String(o.title ?? ''), summary: o.summary, tags: Array.isArray(o.tags) ? o.tags.map(String) : [] };
  } catch { return null; }
}

async function generate(apiKey: string, prompt: string): Promise<string | null> {
  const res = await callJsonModel<Parsed>({
    apiKey, models: [GEN_MODEL, GEN_FALLBACK], systemPrompt: '', userPrompt: prompt,
    parse: parseSummary, maxOutputTokens: 16384,
  });
  return 'error' in res ? null : res.value.summary;
}

// ---- deterministic scorer -------------------------------------------------
function norm(s: string): string { return s.toLowerCase().replace(/\s+/g, ' '); }
function has(hay: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  return n.length >= 3 && norm(hay).includes(n);
}
// Memory entities that surface in the summary AND are grounded in the transcript.
function carryover(summary: string, transcript: string, ents: string[]): number {
  let c = 0;
  for (const e of ents) if (has(summary, e) && has(transcript, e)) c += 1;
  return c;
}
// Deterministic drift proxy: proper-noun phrases and money/number tokens that appear in
// the summary but NOT in the transcript. Crude on purpose — its adequacy is under test.
function detDrift(summary: string, transcript: string): string[] {
  const t = norm(transcript);
  const cands = new Set<string>();
  for (const m of summary.matchAll(/[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+/g)) cands.add(m[0]);
  for (const m of summary.matchAll(/\$\s?\d[\d,.]*\s?(?:[MmKkBb]|million|billion)?/g)) cands.add(m[0].trim());
  const out: string[] = [];
  for (const c of cands) if (!t.includes(c.toLowerCase())) out.push(c);
  return out;
}

// ---- LLM judge ------------------------------------------------------------
interface JudgeOut { continuity: number; drift: string[] }
function stripFence(s: string): string { return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''); }
async function judge(apiKey: string, transcript: string, summary: string): Promise<JudgeOut | null> {
  const prompt = `You are grading a meeting-summary system on TWO independent axes. You are given the meeting TRANSCRIPT (the only ground truth) and a SUMMARY.

1. CONTINUITY (0-100): how well does the summary surface the ongoing-work context that connects this meeting to the participants' broader work — the recurring people, projects, and prior decisions that the transcript supports? Reward grounded connective context. Do NOT reward length or unsupported additions.
2. DRIFT: list every specific claim in the SUMMARY (a person, number, decision, or action) that the TRANSCRIPT does NOT support. Empty list if all claims are grounded.

TRANSCRIPT:
'''
${transcript.slice(0, 24000)}
'''

SUMMARY:
'''
${summary.slice(0, 8000)}
'''

Return ONLY JSON: {"continuity": <int 0-100>, "drift": [<string>, ...]}`;
  const res = await callGemini({
    apiKey, model: JUDGE_MODEL, parts: [{ text: prompt }],
    responseMimeType: 'application/json', maxOutputTokens: 2048, temperature: 0, thinkingBudget: 0,
  });
  try {
    const o = JSON.parse(stripFence(res.text)) as Record<string, unknown>;
    const continuity = typeof o.continuity === 'number' ? o.continuity : NaN;
    const drift = Array.isArray(o.drift) ? o.drift.map(String) : [];
    return Number.isFinite(continuity) ? { continuity, drift } : null;
  } catch { return null; }
}
async function judgeK(apiKey: string, transcript: string, summary: string): Promise<{ cont: number[]; drift: number[] }> {
  const cont: number[] = []; const drift: number[] = [];
  for (let i = 0; i < JUDGE_RUNS; i += 1) {
    const j = await judge(apiKey, transcript, summary);
    if (j) { cont.push(j.continuity); drift.push(j.drift.length); }
  }
  return { cont, drift };
}
function med(xs: number[]): number { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function spread(xs: number[]): number { return xs.length ? Math.max(...xs) - Math.min(...xs) : NaN; }

// ---- main -----------------------------------------------------------------
async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey || !url || !key) { process.stderr.write('Need GEMINI_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.\n'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const noteIds = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_NOTES;

  const spreads: number[] = [];
  let sanityDone = false;

  for (const noteId of noteIds) {
    const { data: note } = await db.from('note')
      .select('user_id, name, diarization, transcription, transcription_language, meeting_at')
      .eq('id', noteId).maybeSingle();
    if (!note) { process.stdout.write(`\n[${noteId}] NOT FOUND\n`); continue; }
    const userId = (note as { user_id: string }).user_id;
    const segs = Array.isArray((note as { diarization?: Seg[] }).diarization) ? (note as { diarization: Seg[] }).diarization : [];
    const transcript = (segs.length ? segs.map((s) => `${s.speaker ?? 'Speaker'}: ${segText(s)}`).join('\n') : String((note as { transcription?: unknown }).transcription ?? '')).trim();
    const outputLanguage: 'en' | 'ko' = (note as { transcription_language?: string }).transcription_language === 'en' ? 'en' : 'ko';

    const { data: memRow } = await db.from('user_memory').select('memory').eq('user_id', userId).maybeSingle();
    const memory = (memRow as { memory?: unknown } | null)?.memory ?? null;
    const memoryText = renderMemoryForContext(memory);
    const items = (memory && typeof memory === 'object' && Array.isArray((memory as { items?: unknown[] }).items)) ? (memory as { items: Array<Record<string, unknown>> }).items : [];
    const ents = Array.from(new Set(items.filter((i) => i.status !== 'archived').flatMap((i) => Array.isArray(i.entities) ? (i.entities as unknown[]).map(String) : []))).filter((e) => e.trim().length >= 3);

    if (!memoryText || !transcript) { process.stdout.write(`\n[${noteId}] skipped (memory or transcript empty)\n`); continue; }

    const common = { now: new Date().toISOString(), meetingDate: (note as { meeting_at?: string }).meeting_at ?? null, summaryRules: SUMMARY_RULES, fileName: (note as { name?: string }).name ?? 'note', transcript, outputLanguage };
    const off = await generate(apiKey, buildSummaryPrompt(common));
    const on = await generate(apiKey, buildSummaryPrompt({ ...common, personalMemoryContext: memoryText }));
    if (!off || !on) { process.stdout.write(`\n[${noteId}] generation failed\n`); continue; }

    const detOff = { carry: carryover(off, transcript, ents), drift: detDrift(off, transcript).length };
    const detOn = { carry: carryover(on, transcript, ents), drift: detDrift(on, transcript).length };
    const jOff = await judgeK(apiKey, transcript, off);
    const jOn = await judgeK(apiKey, transcript, on);
    spreads.push(spread(jOff.cont), spread(jOn.cont));

    process.stdout.write(`\n══ [${String((note as { meeting_at?: string }).meeting_at).slice(0, 10)}] ${noteId} — ${ents.length} mem-entities, transcript ${transcript.length} chars ══\n`);
    process.stdout.write(`  DETERMINISTIC  carryover OFF ${detOff.carry} → ON ${detOn.carry}  (lift ${detOn.carry - detOff.carry})   |  drift OFF ${detOff.drift} → ON ${detOn.drift}\n`);
    process.stdout.write(`  JUDGE cont     OFF med ${med(jOff.cont)} [${jOff.cont.join(',')}] spread ${spread(jOff.cont)}  →  ON med ${med(jOn.cont)} [${jOn.cont.join(',')}] spread ${spread(jOn.cont)}   (lift ${med(jOn.cont) - med(jOff.cont)})\n`);
    process.stdout.write(`  JUDGE drift    OFF med ${med(jOff.drift)} [${jOff.drift.join(',')}]  →  ON med ${med(jOn.drift)} [${jOn.drift.join(',')}]\n`);

    // Drift-sensitivity probe: corrupt the ON summary with a known fabrication, once.
    if (!sanityDone) {
      sanityDone = true;
      const corrupted = on + FABRICATION;
      const detFlag = detDrift(corrupted, transcript);
      const detCaught = detFlag.some((x) => /priya|raman|4\.2/i.test(x));
      const jc = await judge(apiKey, transcript, corrupted);
      const jCaught = !!jc && jc.drift.some((x) => /priya|raman|4\.2|budget/i.test(x));
      process.stdout.write(`\n── DRIFT SANITY (fabrication injected into ON summary) ──\n`);
      process.stdout.write(`  DETERMINISTIC caught: ${detCaught}   (flagged: ${JSON.stringify(detFlag)})\n`);
      process.stdout.write(`  JUDGE caught: ${jCaught}   (drift: ${JSON.stringify(jc?.drift ?? null)})\n`);
    }
  }

  process.stdout.write(`\n════════ SUMMARY ════════\n`);
  process.stdout.write(`Judge continuity NOISE: mean spread across ${spreads.length} summaries = ${(spreads.reduce((a, b) => a + b, 0) / (spreads.length || 1)).toFixed(1)} points (max ${Math.max(...spreads, 0)})\n`);
  process.stdout.write(`Generator = ${GEN_MODEL}, Judge = ${JUDGE_MODEL}, judge runs/summary = ${JUDGE_RUNS}\n`);
  process.stdout.write(`Read: low judge noise + judge catches the fabrication the deterministic misses → judge earns its cost. High noise or judge misses fabrication → lean deterministic/hybrid.\n`);
}

main().catch((e) => { process.stderr.write(`bakeoff failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
