// Deterministic set-based scoring (no LLM). Used for the exact-ish fields
// (people, companies) and as the fast first pass everywhere.

import { norm } from './util.js';

export interface PRF1 {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
}

/**
 * Set precision/recall/F1 with a custom match predicate. Each actual can satisfy at
 * most one expected (greedy first match), so duplicates in `actual` count as FPs.
 */
export function prf1(expected: string[], actual: string[], match: (e: string, a: string) => boolean): PRF1 {
  const e = expected.filter((x) => x.trim());
  const a = actual.filter((x) => x.trim());
  const usedActual = new Set<number>();
  let tp = 0;
  for (const exp of e) {
    const idx = a.findIndex((act, i) => !usedActual.has(i) && match(exp, act));
    if (idx >= 0) {
      usedActual.add(idx);
      tp += 1;
    }
  }
  const fn = e.length - tp;
  const fp = a.length - usedActual.size;
  const precision = a.length ? tp / a.length : e.length ? 0 : 1;
  const recall = e.length ? tp / e.length : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp, fn };
}

/** Case-insensitive containment either direction ("인덱싱" ~ "인덱스 레이어" won't match, but "메모리" ~ "메모리 기능" will). */
export function containsMatch(e: string, a: string): boolean {
  const ne = norm(e);
  const na = norm(a);
  return ne === na || ne.includes(na) || na.includes(ne);
}

/** Mean Reciprocal Rank for a list of (rank-of-first-relevant) results. rank is 1-based; 0 = not found. */
export function mrr(ranks: number[]): number {
  if (ranks.length === 0) return 0;
  const sum = ranks.reduce((acc, r) => acc + (r > 0 ? 1 / r : 0), 0);
  return sum / ranks.length;
}

/** Fraction of queries where a relevant note appeared within the top k. */
export function recallAtK(ranks: number[], k: number): number {
  if (ranks.length === 0) return 0;
  const hits = ranks.filter((r) => r > 0 && r <= k).length;
  return hits / ranks.length;
}
