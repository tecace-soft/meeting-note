// LLM-as-judge scoring (the semantic half of the hybrid). One bounded Gemini call
// per task; output is JSON, validated at the boundary (Power-of-Ten rule 3). A judge
// failure is surfaced as a thrown error the surface records as a note — never silently
// swallowed (rule 4).

import { callGemini } from '../../src/gemini.js';
import type { EvalDeps } from './types.js';
import { PRF1 } from './scoring.js';
import { stripFence, withTimeout } from './util.js';

const JUDGE_TIMEOUT_MS = 30000;
const JUDGE_MAX_TOKENS = 2048;

async function judgeJson(deps: EvalDeps, prompt: string): Promise<unknown> {
  const result = await withTimeout(
    callGemini({
      apiKey: deps.geminiApiKey,
      model: deps.judgeModel,
      parts: [{ text: prompt }],
      responseMimeType: 'application/json',
      maxOutputTokens: JUDGE_MAX_TOKENS,
      temperature: 0,
      thinkingBudget: 0,
    }),
    JUDGE_TIMEOUT_MS,
    `judge(${deps.judgeModel})`,
  );
  try {
    return JSON.parse(stripFence(result.text));
  } catch {
    throw new Error(`judge returned non-JSON: ${result.text.slice(0, 200)}`);
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/**
 * Semantically align EXPECTED vs ACTUAL short items (paraphrase/translation OK) and
 * return P/R/F1. Each actual matches at most one expected. Empty lists score by
 * convention: no expected → recall 1; no actual → precision 0 (unless nothing expected).
 */
export async function judgeAlignment(
  deps: EvalDeps,
  kind: string,
  expected: string[],
  actual: string[],
): Promise<PRF1> {
  const e = expected.filter((x) => x.trim());
  const a = actual.filter((x) => x.trim());
  if (e.length === 0) return { precision: a.length ? 0 : 1, recall: 1, f1: a.length ? 0 : 1, tp: 0, fp: a.length, fn: 0 };
  if (a.length === 0) return { precision: 0, recall: 0, f1: 0, tp: 0, fp: 0, fn: e.length };

  const prompt = `You are grading a meeting-extraction system. Below are EXPECTED ${kind} (ground truth) and ACTUAL ${kind} the system produced. Match each EXPECTED to AT MOST ONE ACTUAL that means the same thing. Paraphrase, summarization, and Korean/English translation all count as a match; only match when they clearly refer to the same ${kind}. Each ACTUAL may be used once.

EXPECTED (0-indexed):
${e.map((x, i) => `${i}: ${x}`).join('\n')}

ACTUAL (0-indexed):
${a.map((x, i) => `${i}: ${x}`).join('\n')}

Return ONLY JSON: {"matches":[{"expected":<int>,"actual":<int>}]}`;

  const parsed = await judgeJson(deps, prompt);
  const rawMatches = asArray((parsed as { matches?: unknown }).matches);
  const usedActual = new Set<number>();
  const usedExpected = new Set<number>();
  let tp = 0;
  for (const m of rawMatches) {
    const ei = asInt((m as { expected?: unknown }).expected);
    const ai = asInt((m as { actual?: unknown }).actual);
    if (ei === null || ai === null) continue;
    if (ei < 0 || ei >= e.length || ai < 0 || ai >= a.length) continue;
    if (usedExpected.has(ei) || usedActual.has(ai)) continue;
    usedExpected.add(ei);
    usedActual.add(ai);
    tp += 1;
  }
  const precision = tp / a.length;
  const recall = tp / e.length;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp: a.length - tp, fn: e.length - tp };
}

export interface ForbiddenResult {
  claim: string;
  asserted: boolean;
  itemIndex: number | null;
}

/** For each forbidden claim, does any memory item assert it as current fact? */
export async function judgeForbidden(
  deps: EvalDeps,
  items: string[],
  forbidden: Array<{ claim: string; why: string }>,
): Promise<ForbiddenResult[]> {
  if (forbidden.length === 0 || items.length === 0) return forbidden.map((f) => ({ claim: f.claim, asserted: false, itemIndex: null }));

  const prompt = `You are auditing a personal-memory store for FACT-DRIFT. Below are MEMORY ITEMS and FORBIDDEN CLAIMS. A forbidden claim is something the memory must NOT assert as a current fact (it is unsupported or was left undecided). For EACH forbidden claim, decide whether ANY memory item asserts that claim as a current fact.

MEMORY ITEMS (0-indexed):
${items.map((x, i) => `${i}: ${x}`).join('\n')}

FORBIDDEN CLAIMS (0-indexed):
${forbidden.map((f, i) => `${i}: ${f.claim} — must not assert because: ${f.why}`).join('\n')}

Return ONLY JSON: {"results":[{"claim":<int>,"asserted":<bool>,"itemIndex":<int or null>}]}`;

  const parsed = await judgeJson(deps, prompt);
  const rawResults = asArray((parsed as { results?: unknown }).results);
  const byIndex = new Map<number, ForbiddenResult>();
  for (const r of rawResults) {
    const ci = asInt((r as { claim?: unknown }).claim);
    if (ci === null || ci < 0 || ci >= forbidden.length) continue;
    const asserted = (r as { asserted?: unknown }).asserted === true;
    const itemIndex = asInt((r as { itemIndex?: unknown }).itemIndex);
    byIndex.set(ci, { claim: forbidden[ci].claim, asserted, itemIndex: itemIndex ?? null });
  }
  return forbidden.map((f, i) => byIndex.get(i) ?? { claim: f.claim, asserted: false, itemIndex: null });
}

/** Cluster memory items by subject; a cluster with >1 item is a set of near-duplicates. */
export async function judgeDuplicateClusters(deps: EvalDeps, items: string[]): Promise<number[][]> {
  if (items.length <= 1) return items.map((_, i) => [i]);

  const prompt = `Group these MEMORY ITEMS into clusters where the items describe the SAME subject, project, decision, or problem — i.e. near-duplicates that should have been merged into one memory. Items about different subjects go in their own singleton cluster. Every index must appear in exactly one cluster.

MEMORY ITEMS (0-indexed):
${items.map((x, i) => `${i}: ${x}`).join('\n')}

Return ONLY JSON: {"clusters":[[<int>,...],...]}`;

  const parsed = await judgeJson(deps, prompt);
  const rawClusters = asArray((parsed as { clusters?: unknown }).clusters);
  const clusters: number[][] = [];
  const seen = new Set<number>();
  for (const c of rawClusters) {
    const idxs: number[] = [];
    for (const v of asArray(c)) {
      const i = asInt(v);
      if (i !== null && i >= 0 && i < items.length && !seen.has(i)) {
        seen.add(i);
        idxs.push(i);
      }
    }
    if (idxs.length) clusters.push(idxs);
  }
  // Any item the judge dropped becomes its own singleton so counts stay honest.
  for (let i = 0; i < items.length; i += 1) if (!seen.has(i)) clusters.push([i]);
  return clusters;
}
