// STEP-1(b): does injecting cross-meeting personal memory into extractInsight HELP, or
// does it just cost tokens and violate the index's "THIS meeting only" scope?
//
// The INSIGHT_SYSTEM_PROMPT scopes the index to one meeting on purpose, so the risk is
// that memory leaks cross-meeting people/companies into a per-meeting index. This A/B runs
// extractInsight memory OFF vs ON over real Andrew notes and reports, per arm (avg of K):
//   - actions, ownerCoverage% (actions with a non-empty owner), people, companies
//   - UNGROUNDED: people/owners/companies NOT present verbatim in the transcript
//     (deterministic) = the scope-violation / drift signal.
// Ship memory into extractInsight ONLY if ON raises ownerCoverage or grounded people
// WITHOUT raising UNGROUNDED. Read-only DB. Run: npx tsx eval/insight-memory-ab.ts [noteId ...]

import { config } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { extractInsight, renderMemoryForContext, type NoteInsight } from '../src/memory.js';

config();

const DEFAULT_NOTES = [
  'c729912a-3951-414c-abc5-cafc4f2233de', // 2026-09-03
  '1e0d45b0-3336-4baa-a5bd-493d69632115', // 2026-08-28
  'a9db2cc3-cc04-4e69-b87c-6a5304d65e0b', // 2026-08-25
];
const K = 2; // bounded repeats per arm (Power-of-Ten rule 2)

interface Seg { speaker?: string; original?: string; text?: string; translated?: string }
function segText(s: Seg): string { return (s.original ?? s.text ?? s.translated ?? '').trim(); }
function norm(s: string): string { return s.toLowerCase().replace(/\s+/g, ' '); }
function grounded(entity: string, transcript: string): boolean {
  const e = entity.trim().toLowerCase();
  return e.length < 3 || norm(transcript).includes(e);
}

interface Metrics { actions: number; ownerCov: number; people: number; companies: number; ungrounded: number }
function measure(ins: NoteInsight, transcript: string): Metrics {
  const actions = ins.actions.length;
  const withOwner = ins.actions.filter((a) => a.owner && a.owner.trim() && a.owner.trim().toLowerCase() !== 'self').length;
  const ownerCov = actions ? (withOwner / actions) * 100 : 0;
  const proper = [...ins.people, ...ins.companies, ...ins.actions.map((a) => a.owner)].map((x) => (x ?? '').trim()).filter((x) => x.length >= 3);
  const ungrounded = proper.filter((p) => !grounded(p, transcript)).length;
  return { actions, ownerCov, people: ins.people.length, companies: ins.companies.length, ungrounded };
}
function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }

async function runArm(apiKey: string, transcript: string, memory: string | null): Promise<Metrics | null> {
  const res = await extractInsight({ apiKey, transcript, noteId: null, speakerContext: null, personalMemoryContext: memory });
  if ('error' in res) { process.stdout.write(`    (extractInsight error: ${res.error})\n`); return null; }
  return measure(res.insight, transcript);
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey || !url || !key) { process.stderr.write('Need GEMINI_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.\n'); process.exit(1); }
  const db: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });
  const noteIds = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_NOTES;

  const agg = { offCov: [] as number[], onCov: [] as number[], offUng: [] as number[], onUng: [] as number[] };
  process.stdout.write(`\n════ INSIGHT memory A/B (extractInsight OFF vs ON, K=${K}/arm) ════\n`);
  for (const noteId of noteIds) {
    const { data: note } = await db.from('note').select('user_id, diarization, transcription').eq('id', noteId).maybeSingle();
    if (!note) { process.stdout.write(`[${noteId}] NOT FOUND\n`); continue; }
    const segs = Array.isArray((note as { diarization?: Seg[] }).diarization) ? (note as { diarization: Seg[] }).diarization : [];
    const transcript = (segs.length ? segs.map((s) => `${s.speaker ?? 'Speaker'}: ${segText(s)}`).join('\n') : String((note as { transcription?: unknown }).transcription ?? '')).trim();
    const { data: memRow } = await db.from('user_memory').select('memory').eq('user_id', (note as { user_id: string }).user_id).maybeSingle();
    const memory = renderMemoryForContext((memRow as { memory?: unknown } | null)?.memory ?? null);
    if (!transcript || !memory) { process.stdout.write(`[${noteId}] skipped (no transcript/memory)\n`); continue; }

    const off: Metrics[] = []; const on: Metrics[] = [];
    for (let k = 0; k < K; k += 1) {
      const o = await runArm(apiKey, transcript, null); if (o) off.push(o);
      const n = await runArm(apiKey, transcript, memory); if (n) on.push(n);
    }
    if (!off.length || !on.length) { process.stdout.write(`[${noteId}] arm failed\n`); continue; }
    const oCov = avg(off.map((m) => m.ownerCov)); const nCov = avg(on.map((m) => m.ownerCov));
    const oUng = avg(off.map((m) => m.ungrounded)); const nUng = avg(on.map((m) => m.ungrounded));
    agg.offCov.push(oCov); agg.onCov.push(nCov); agg.offUng.push(oUng); agg.onUng.push(nUng);
    process.stdout.write(`[${noteId}]  actions ${avg(off.map((m) => m.actions)).toFixed(0)}→${avg(on.map((m) => m.actions)).toFixed(0)}  ownerCov ${oCov.toFixed(0)}%→${nCov.toFixed(0)}%  people ${avg(off.map((m) => m.people)).toFixed(0)}→${avg(on.map((m) => m.people)).toFixed(0)}  UNGROUNDED ${oUng.toFixed(1)}→${nUng.toFixed(1)}\n`);
  }
  process.stdout.write(`\n──── VERDICT ────\n`);
  process.stdout.write(`ownerCoverage: OFF ${avg(agg.offCov).toFixed(1)}% → ON ${avg(agg.onCov).toFixed(1)}%  (Δ ${(avg(agg.onCov) - avg(agg.offCov)).toFixed(1)})\n`);
  process.stdout.write(`ungrounded (scope leak): OFF ${avg(agg.offUng).toFixed(2)} → ON ${avg(agg.onUng).toFixed(2)}  (Δ ${(avg(agg.onUng) - avg(agg.offUng)).toFixed(2)})\n`);
  process.stdout.write(`SHIP only if ownerCoverage Δ clearly positive AND ungrounded Δ ~0. Otherwise keep extractInsight memory-blind.\n`);
}

main().catch((e) => { process.stderr.write(`insight-ab failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });
