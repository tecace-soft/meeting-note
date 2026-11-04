// DECISION GRAPH eval (Job A). Runs the PRODUCTION extraction (src/decisions/job.ts
// extractDecisions + store.ts buildExtractionPayload) on a list of notes and reports the
// automatic acceptance metrics from the 2026-11-01 handoff §6:
//   (a) evidence_quote exact-match rate against the transcript (target ≥ 0.95)
//   (b) status distribution and decided ratio (> 0.7 per meeting = suspected over-classification)
//   (c) schema failure rate (target < 2%)
//   plus share of 'summary' evidence, latency, tokens and estimated cost per meeting.
// Gold-set precision/recall (decided precision ≥ 0.85, recall ≥ 0.80) needs the 20 hand-checked
// meetings and is not computed here yet.
//
// Read-only by default: it reads notes and calls Gemini, and writes nothing. Pass --write to
// also persist through the real job (runDecisionExtraction with force), e.g. to seed a staging DB.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + GEMINI_API_KEY (workflow-server/.env).
// Run:
//   npm run eval:decisions -- --notes <id1,id2,...> [--model gemini-2.5-flash-lite] [--write]
//   npm run eval:decisions -- --file note-ids.txt      (one id per line, # comments allowed)
// Compare models by running once per --model and diffing the JSON written to eval/results/.

import { config } from 'dotenv';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { assertLiveModel, isLiteModel, DECISION_EXTRACTION_MODEL } from '../src/gemini-models.js';
import { extractDecisions, prepareInput, refinePayload, runDecisionExtraction, DECISION_PIPELINE_VERSION, NOTE_EXTRACTION_SELECT, type NoteForExtraction } from '../src/decisions/job.js';
import { buildExtractionPayload } from '../src/decisions/store.js';
import { DECISION_STATUSES } from '../src/decisions/schema.js';

config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function noteIds(): Promise<string[]> {
  const inline = arg('notes');
  if (inline) return inline.split(',').map((s) => s.trim()).filter(Boolean);
  const file = arg('file');
  if (file) {
    return (await readFile(file, 'utf8')).split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  }
  throw new Error('pass --notes id1,id2 or --file ids.txt');
}

interface Row {
  noteId: string;
  ok: boolean;
  error?: string;
  model?: string;
  decisions?: number;
  decidedRatio?: number | null;
  evidenceQuoted?: number;
  evidenceMatched?: number;
  evidenceSummaryRate?: number | null;
  statusCounts?: Record<string, number>;
  latencyMs?: number;
  inputChars?: number;
  costUsd?: number;
  promptTokens?: number;
  outputTokens?: number;
  unmatchedQuotes?: string[];
}

async function main() {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
  if (!url || !key || !apiKey) throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and GEMINI_API_KEY are required');
  const model = assertLiveModel(arg('model') || DECISION_EXTRACTION_MODEL);
  if (!isLiteModel(model)) throw new Error(`${model} is not a lite model (DEC-0005)`);
  const timeZone = process.env.DECISION_GRAPH_TIMEZONE || 'Asia/Seoul';
  const write = process.argv.includes('--write');
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const ids = await noteIds();

  const rows: Row[] = [];
  for (const noteId of ids) {
    if (write) {
      const out = await runDecisionExtraction({ supabase, apiKey, noteId, model, timeZone, force: true });
      rows.push(out.status === 'done'
        ? { noteId, ok: true, model, decisions: out.metrics.decisions, decidedRatio: out.metrics.decided_ratio, evidenceQuoted: out.metrics.evidence_quoted, evidenceMatched: out.metrics.evidence_matched, evidenceSummaryRate: out.metrics.evidence_summary_rate, statusCounts: out.metrics.status_counts }
        : { noteId, ok: false, error: `${out.status}: ${out.reason}` });
      console.log(`${noteId} ${out.status}`);
      continue;
    }
    const { data, error } = await supabase.from('note').select(NOTE_EXTRACTION_SELECT).eq('id', noteId).maybeSingle();
    if (error || !data) { rows.push({ noteId, ok: false, error: error?.message ?? 'not found' }); continue; }
    const note = data as NoteForExtraction;
    const prepared = prepareInput(note, timeZone);
    if ('error' in prepared) { rows.push({ noteId, ok: false, error: prepared.error }); continue; }
    // No fallback models here: the eval measures exactly the requested model.
    const res = await extractDecisions({ apiKey, model, fallbackModels: [], noteId, title: note.name, prepared });
    if ('error' in res) {
      rows.push({ noteId, ok: false, error: res.error, latencyMs: res.latencyMs, inputChars: prepared.transcript.length });
      console.log(`${noteId} FAILED ${res.error.slice(0, 120)}`);
      continue;
    }
    const built = buildExtractionPayload(res.extraction, {
      noteId, meetingDate: prepared.meetingDate, promptVersion: DECISION_PIPELINE_VERSION, runId: null, segments: prepared.segments,
    });
    const { payload } = built;
    const { metrics } = await refinePayload({ apiKey, model, payload, metrics: built.metrics, segments: prepared.segments });
    const unmatched = [...payload.decisions, ...payload.actions, ...payload.issues]
      .filter((x) => x.evidence_match === false)
      .map((x) => String(x.evidence_quote).slice(0, 120));
    rows.push({
      noteId, ok: true, model: res.model,
      decisions: metrics.decisions, decidedRatio: metrics.decided_ratio,
      evidenceQuoted: metrics.evidence_quoted, evidenceMatched: metrics.evidence_matched,
      evidenceSummaryRate: metrics.evidence_summary_rate, statusCounts: metrics.status_counts,
      latencyMs: res.latencyMs, inputChars: prepared.transcript.length,
      costUsd: res.usage?.estimatedCostUsd, promptTokens: res.usage?.promptTokens, outputTokens: res.usage?.outputTokens,
      unmatchedQuotes: unmatched,
    });
    console.log(`${noteId} ok decisions=${metrics.decisions} decided=${metrics.decided_ratio} evidence=${metrics.evidence_matched}/${metrics.evidence_quoted} ${res.latencyMs}ms`);
  }

  const ok = rows.filter((r) => r.ok);
  const sum = (f: (r: Row) => number | undefined) => ok.reduce((a, r) => a + (f(r) ?? 0), 0);
  const quoted = sum((r) => r.evidenceQuoted);
  const matched = sum((r) => r.evidenceMatched);
  const statusTotals = Object.fromEntries(DECISION_STATUSES.map((s) => [s, sum((r) => r.statusCounts?.[s])]));
  const decisionsTotal = sum((r) => r.decisions);
  const latencies = ok.map((r) => r.latencyMs).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  const summary = {
    promptVersion: DECISION_PIPELINE_VERSION,
    model,
    notes: rows.length,
    schemaOrCallFailureRate: rows.length ? (rows.length - ok.length) / rows.length : null,
    evidenceMatchRate: quoted ? matched / quoted : null,
    evidenceQuoted: quoted,
    decisions: decisionsTotal,
    statusTotals,
    decidedShare: decisionsTotal ? statusTotals.decided / decisionsTotal : null,
    meetingsOverDecided70: ok.filter((r) => (r.decidedRatio ?? 0) > 0.7 && (r.decisions ?? 0) >= 4).map((r) => r.noteId),
    meanSummaryEvidenceRate: ok.length ? sum((r) => r.evidenceSummaryRate ?? 0) / ok.length : null,
    latencyP50Ms: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    latencyMaxMs: latencies.length ? latencies[latencies.length - 1] : null,
    costPerMeetingUsd: ok.length ? sum((r) => r.costUsd) / ok.length : null,
    targets: { evidenceMatchRate: '>= 0.95', schemaFailureRate: '< 0.02', decidedPrecision: '>= 0.85 (needs gold set)', recall: '>= 0.80 (needs gold set)' },
  };
  console.log('\n=== Decision Graph eval ===');
  console.log(JSON.stringify(summary, null, 2));
  await mkdir(new URL('./results/', import.meta.url), { recursive: true });
  const out = new URL(`./results/decision-graph-${model}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
  await writeFile(out, JSON.stringify({ summary, rows }, null, 2));
  console.log(`\nwrote ${out.pathname}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
