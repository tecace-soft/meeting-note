// STEP-0 follow-up bake-off: two open decisions, both settled by measurement.
//
//   A. JUDGE MODEL — is the cheap flash-lite an adequate judge, or do we pay for flash?
//      Run BOTH judges on the same summaries; compare continuity signal + fabrication catch.
//   B. NOTE SET — Andrew-only already showed lift <= 0. Is that an injection DEFECT or a
//      single-project POPULATION artifact? Add a SYNTHETIC cross-meeting case where memory
//      MUST help (ambiguous references only memory can resolve) and see if ON > OFF.
//
// Reuses the real summary prompt + model path. Read-only DB. Run:
//   npx tsx eval/judge-tune.ts [noteId ...]

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { buildSummaryPrompt } from '../src/prompts.js';
import { callJsonModel, renderMemoryForContext } from '../src/memory.js';
import { callGemini } from '../src/gemini.js';

config();

const DEFAULT_NOTES = [
  'c729912a-3951-414c-abc5-cafc4f2233de', // 2026-09-03
  '1e0d45b0-3336-4baa-a5bd-493d69632115', // 2026-08-28
];
const GEN_MODEL = process.env.GEMINI_SUMMARY_MODEL || 'gemini-2.5-flash-lite';
const GEN_FALLBACK = 'gemini-3.1-flash-lite';
const JUDGES = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']; // A: compare these two as judges
const JUDGE_RUNS = 2;
const SUMMARY_RULES =
  'Write structured, actionable meeting notes in markdown: a short overview, key decisions, action items (with owner when stated), and open questions.';
const FABRICATION = '\n\n**Budget:** Priya Raman approved a $4.2M budget increase for Q3, effective immediately.';

interface Seg { speaker?: string; original?: string; text?: string; translated?: string }
function segText(s: Seg): string { return (s.original ?? s.text ?? s.translated ?? '').trim(); }

interface Parsed { title: string; summary: string; tags: string[] }
function parseSummary(text: string): Parsed | null {
  try {
    const o = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')) as Record<string, unknown>;
    if (typeof o.summary !== 'string') return null;
    return { title: String(o.title ?? ''), summary: o.summary, tags: Array.isArray(o.tags) ? o.tags.map(String) : [] };
  } catch { return null; }
}
async function generate(apiKey: string, prompt: string): Promise<string | null> {
  const res = await callJsonModel<Parsed>({ apiKey, models: [GEN_MODEL, GEN_FALLBACK], systemPrompt: '', userPrompt: prompt, parse: parseSummary, maxOutputTokens: 16384 });
  return 'error' in res ? null : res.value.summary;
}

interface JudgeOut { continuity: number; drift: string[] }
function stripFence(s: string): string { return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''); }
async function judge(apiKey: string, model: string, transcript: string, summary: string): Promise<JudgeOut | null> {
  const prompt = `You are grading a meeting-summary system on TWO independent axes, given the TRANSCRIPT (the only ground truth) and a SUMMARY.

1. CONTINUITY (0-100): how well does the summary surface the ongoing-work context that connects this meeting to the participants' broader work — the recurring people, projects, and prior decisions the transcript supports, and correctly RESOLVING vague references ("the migration", "the quota thing") to what they are? Reward grounded connective context; do NOT reward length or unsupported additions.
2. DRIFT: list every specific claim in the SUMMARY (a person, number, decision, or action) the TRANSCRIPT does NOT support. Empty list if all grounded.

TRANSCRIPT:
'''
${transcript.slice(0, 24000)}
'''

SUMMARY:
'''
${summary.slice(0, 8000)}
'''

Return ONLY JSON: {"continuity": <int 0-100>, "drift": [<string>, ...]}`;
  const res = await callGemini({ apiKey, model, parts: [{ text: prompt }], responseMimeType: 'application/json', maxOutputTokens: 2048, temperature: 0, thinkingBudget: 0 });
  try {
    const o = JSON.parse(stripFence(res.text)) as Record<string, unknown>;
    const continuity = typeof o.continuity === 'number' ? o.continuity : NaN;
    return Number.isFinite(continuity) ? { continuity, drift: Array.isArray(o.drift) ? o.drift.map(String) : [] } : null;
  } catch { return null; }
}
async function judgeK(apiKey: string, model: string, transcript: string, summary: string): Promise<{ cont: number[]; drift: number[] }> {
  const cont: number[] = []; const drift: number[] = [];
  for (let i = 0; i < JUDGE_RUNS; i += 1) { const j = await judge(apiKey, model, transcript, summary); if (j) { cont.push(j.continuity); drift.push(j.drift.length); } }
  return { cont, drift };
}
function med(xs: number[]): number { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

async function scorePair(apiKey: string, tag: string, transcript: string, off: string, on: string): Promise<void> {
  process.stdout.write(`\n══ ${tag} ══\n`);
  for (const m of JUDGES) {
    const jOff = await judgeK(apiKey, m, transcript, off);
    const jOn = await judgeK(apiKey, m, transcript, on);
    process.stdout.write(`  [${m}]  cont OFF ${med(jOff.cont)} [${jOff.cont.join(',')}] → ON ${med(jOn.cont)} [${jOn.cont.join(',')}]  (lift ${med(jOn.cont) - med(jOff.cont)})   drift OFF ${med(jOff.drift)} → ON ${med(jOn.drift)}\n`);
  }
}

// ---- synthetic cross-meeting case: memory MUST resolve the vague references ----
const SYN_TRANSCRIPT = `Alex: Okay, quick sync. Where are we on the migration?
Sam: Backend's basically done. I'm blocked on the quota thing again.
Alex: Did you loop in Priya?
Sam: Yeah, she's reviewing it this week. Once she signs off we can cut over.
Alex: Good. And the mobile side?
Sam: Jamie's still on the export bug, should land tomorrow.
Alex: Let's aim to wrap the migration by end of month.`;
const SYN_MEMORY = `- Sam (self) owns the billing-system migration to the new metering pipeline; the recurring blocker has been the Supabase storage quota.
- Priya is the finance lead who reviews billing budget changes before any cutover.
- Jamie owns the mobile app; the recurring work is the OneDrive/Teams export feature.
- The migration replaces the legacy 50MB-capped upload path.`;

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey || !url || !key) { process.stderr.write('Need GEMINI_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.\n'); process.exit(1); }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const noteIds = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_NOTES;

  // --- A + partial B: real Andrew notes, both judges ---
  let fabDone = false;
  for (const noteId of noteIds) {
    const { data: note } = await db.from('note').select('user_id, name, diarization, transcription, transcription_language, meeting_at').eq('id', noteId).maybeSingle();
    if (!note) { process.stdout.write(`\n[${noteId}] NOT FOUND\n`); continue; }
    const userId = (note as { user_id: string }).user_id;
    const segs = Array.isArray((note as { diarization?: Seg[] }).diarization) ? (note as { diarization: Seg[] }).diarization : [];
    const transcript = (segs.length ? segs.map((s) => `${s.speaker ?? 'Speaker'}: ${segText(s)}`).join('\n') : String((note as { transcription?: unknown }).transcription ?? '')).trim();
    const outputLanguage: 'en' | 'ko' = (note as { transcription_language?: string }).transcription_language === 'en' ? 'en' : 'ko';
    const { data: memRow } = await db.from('user_memory').select('memory').eq('user_id', userId).maybeSingle();
    const memoryText = renderMemoryForContext((memRow as { memory?: unknown } | null)?.memory ?? null);
    if (!memoryText || !transcript) { process.stdout.write(`\n[${noteId}] skipped\n`); continue; }
    const common = { now: new Date().toISOString(), meetingDate: (note as { meeting_at?: string }).meeting_at ?? null, summaryRules: SUMMARY_RULES, fileName: (note as { name?: string }).name ?? 'note', transcript, outputLanguage };
    const off = await generate(apiKey, buildSummaryPrompt(common));
    const on = await generate(apiKey, buildSummaryPrompt({ ...common, personalMemoryContext: memoryText }));
    if (!off || !on) { process.stdout.write(`\n[${noteId}] gen failed\n`); continue; }
    await scorePair(apiKey, `REAL [${String((note as { meeting_at?: string }).meeting_at).slice(0, 10)}] ${noteId}`, transcript, off, on);
    if (!fabDone) {
      fabDone = true;
      process.stdout.write(`  ── fabrication catch (both judges) ──\n`);
      for (const m of JUDGES) { const jc = await judge(apiKey, m, transcript, on + FABRICATION); process.stdout.write(`     [${m}] caught=${!!jc && jc.drift.some((x) => /priya|raman|4\.2|budget/i.test(x))}  drift=${JSON.stringify(jc?.drift ?? null)}\n`); }
    }
  }

  // --- B: synthetic cross-meeting case, memory MUST help ---
  const common = { now: new Date().toISOString(), meetingDate: null, summaryRules: SUMMARY_RULES, fileName: 'synthetic-sync', transcript: SYN_TRANSCRIPT, outputLanguage: 'en' as const };
  const off = await generate(apiKey, buildSummaryPrompt(common));
  const on = await generate(apiKey, buildSummaryPrompt({ ...common, personalMemoryContext: SYN_MEMORY }));
  if (off && on) {
    await scorePair(apiKey, 'SYNTHETIC cross-meeting (memory MUST resolve refs)', SYN_TRANSCRIPT, off, on);
    process.stdout.write(`\n  --- OFF ---\n${off}\n\n  --- ON ---\n${on}\n`);
  }

  process.stdout.write(`\n════════ READ ════════\n`);
  process.stdout.write(`A (judge model): if flash-lite tracks flash's lift sign + catches the fabrication → use flash-lite (cheaper, lite-only).\n`);
  process.stdout.write(`B (note set): if SYNTHETIC shows clear ON>OFF but REAL Andrew notes don't → Andrew ~0 is POPULATION, not an injection defect → gate needs synthetic/multi-user cases.\n`);
}

main().catch((e) => { process.stderr.write(`judge-tune failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
