// Search surface: run the REAL search_notes RPC against the configured Supabase and
// score ranking (MRR, recall@k) for known query→note expectations. Requires real
// Supabase credentials + populated data, so it SKIPS gracefully (never silently) when
// the local env only has placeholders.

import { createClient } from '@supabase/supabase-js';
import { mrr, recallAtK } from '../lib/scoring.js';
import type { EvalDeps, Metric, SearchGolden, SurfaceScore } from '../lib/types.js';
import { withTimeout } from '../lib/util.js';

const SEARCH_TIMEOUT_MS = 20000;
const MAX_QUERIES = 20;

interface SearchRow {
  note_id: string;
}

export async function runSearchSurface(golden: SearchGolden, _deps: EvalDeps): Promise<SurfaceScore> {
  const surface = `search:${golden.name}`;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key || url.includes('your-project-ref') || key.includes('your-supabase')) {
    return { surface, ran: false, skippedReason: 'no real SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env (placeholder locally); run against prod to score search', metrics: [], notes: [] };
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const notes: string[] = [];
  const ranks: number[] = [];
  for (const q of golden.queries.slice(0, MAX_QUERIES)) {
    try {
      const { data, error } = await withTimeout(
        Promise.resolve(
          supabase.rpc('search_notes', { p_user_id: golden.userId, p_query: q.query, p_limit: 10, p_project_id: null, p_start: null, p_end: null }),
        ),
        SEARCH_TIMEOUT_MS,
        `search_notes("${q.query}")`,
      );
      if (error) {
        notes.push(`query "${q.query}" error: ${error.message}`);
        ranks.push(0);
        continue;
      }
      const rows = (data as SearchRow[] | null) ?? [];
      const idx = rows.findIndex((r) => q.expectedNoteIds.includes(r.note_id));
      ranks.push(idx >= 0 ? idx + 1 : 0);
      if (idx < 0) notes.push(`query "${q.query}": expected note not in top ${rows.length}`);
    } catch (error) {
      notes.push(`query "${q.query}" threw: ${(error as Error).message}`);
      ranks.push(0);
    }
  }

  const metrics: Metric[] = [
    { label: 'MRR', value: mrr(ranks) },
    { label: 'recall@5', value: recallAtK(ranks, 5) },
    { label: 'recall@10', value: recallAtK(ranks, 10) },
  ];
  return { surface, ran: true, metrics, notes };
}
