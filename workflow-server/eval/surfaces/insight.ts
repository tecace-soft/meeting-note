// Insight surface: run the REAL note_insight producer (extractInsight) on a golden
// transcript and score its five fields. actions/decisions/topics are judged
// semantically; people/companies deterministically. This is the surface the c88ee76
// runaway-truncation bug broke — a hard extraction failure scores 0 here.

import { extractInsight } from '../../src/memory.js';
import { judgeAlignment } from '../lib/judge.js';
import { containsMatch, prf1, type PRF1 } from '../lib/scoring.js';
import type { EvalDeps, InsightGolden, Metric, SurfaceScore } from '../lib/types.js';
import { pct } from '../lib/util.js';

function metricOf(label: string, p: PRF1): Metric {
  return { label, value: p.f1, detail: `P ${pct(p.precision)} R ${pct(p.recall)} · tp${p.tp} fp${p.fp} fn${p.fn}` };
}

export async function runInsightSurface(golden: InsightGolden, deps: EvalDeps): Promise<SurfaceScore> {
  const surface = `insight:${golden.name}`;
  const res = await extractInsight({ apiKey: deps.geminiApiKey, transcript: golden.transcript, noteId: golden.noteId ?? null });
  if ('error' in res) {
    // Extraction failure IS a result (this is exactly what the runaway bug produced).
    return { surface, ran: true, metrics: [{ label: 'extraction succeeded', value: 0 }], notes: [`extraction FAILED: ${res.error}`] };
  }
  const ins = res.insight;

  const actions = await judgeAlignment(deps, 'action item', golden.expected.actions, ins.actions.map((a) => a.text));
  const decisions = await judgeAlignment(deps, 'decision', golden.expected.decisions, ins.decisions.map((d) => d.text));
  const topics = await judgeAlignment(deps, 'topic', golden.expected.topics, ins.topics);
  const people = prf1(golden.expected.people, ins.people, containsMatch);
  const companies = prf1(golden.expected.companies, ins.companies, containsMatch);

  const fieldMetrics: Metric[] = [
    metricOf('actions F1 (judge)', actions),
    metricOf('decisions F1 (judge)', decisions),
    metricOf('topics F1 (judge)', topics),
    metricOf('people F1 (exact)', people),
    metricOf('companies F1 (exact)', companies),
  ];
  const macroF1 = fieldMetrics.reduce((acc, m) => acc + m.value, 0) / fieldMetrics.length;

  return {
    surface,
    ran: true,
    metrics: [{ label: 'macro F1 (mean of fields)', value: macroF1 }, ...fieldMetrics],
    notes: [
      `extracted ${ins.actions.length} actions / ${ins.decisions.length} decisions / ${ins.topics.length} topics / ${ins.people.length} people / ${ins.companies.length} companies (model ${ins.sourceModel})`,
    ],
  };
}
