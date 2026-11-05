// Owner-scoped batch backfill for the Decision Graph (docs/decision-graph.md §5, option b chosen by
// Hans 2026-11-05). Finds the caller's notes that have no finished run for the current pipeline
// version and runs Job A on a bounded batch with small concurrency. Re-running is safe: Job A is
// idempotent per (note_id, pipeline version) and never overwrites human-verified rows, so the
// caller just repeats until `remaining` is 0. Bumping DECISION_PIPELINE_VERSION makes every note
// eligible again.
import type { SupabaseClient } from '@supabase/supabase-js';
import { DECISION_PIPELINE_VERSION, runDecisionExtraction, type RunOutcome } from './job.js';

export const MAX_BACKFILL_BATCH = 25;
export const DEFAULT_BACKFILL_BATCH = 10;
const BACKFILL_CONCURRENCY = 3;
// Upper bound on how many of the owner's notes one call scans for candidates.
const MAX_SCAN = 2000;

/** Notes not yet processed for this version, newest first (input order is preserved). */
export function selectBackfillCandidates(orderedNoteIds: string[], processedNoteIds: Set<string>, limit: number): { batch: string[]; remaining: number } {
  const pending = orderedNoteIds.filter((id) => !processedNoteIds.has(id));
  return { batch: pending.slice(0, limit), remaining: Math.max(0, pending.length - limit) };
}

/** Run tasks with at most `concurrency` in flight; results keep input order. Never throws. */
export async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface BackfillResult {
  pipelineVersion: string;
  processed: number;
  done: number;
  skipped: number;
  failed: number;
  remaining: number;
  decisionsStored: number;
  decidedStored: number;
  failures: Array<{ noteId: string; reason: string }>;
  skips: Array<{ noteId: string; reason: string }>;
}

export async function runDecisionBackfill(input: {
  supabase: SupabaseClient;
  apiKey: string;
  userId: string;
  model: string;
  timeZone: string;
  limit?: number;
  from?: string | null; // YYYY-MM-DD on meeting_at/created_at
  to?: string | null;
}): Promise<BackfillResult> {
  const { supabase, userId } = input;
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_BACKFILL_BATCH, MAX_BACKFILL_BATCH));

  let q = supabase
    .from('note')
    .select('id, created_at, meeting_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(MAX_SCAN);
  if (input.from) q = q.gte('created_at', `${input.from}T00:00:00Z`);
  if (input.to) q = q.lte('created_at', `${input.to}T23:59:59Z`);
  const { data: notes, error: notesError } = await q;
  if (notesError) throw new Error(`note scan: ${notesError.message}`);
  const ordered = ((notes as Array<{ id: string }>) ?? []).map((n) => String(n.id));

  // A 'skipped' run (e.g. empty transcript) also counts as processed, so it is not retried forever.
  const { data: runs, error: runsError } = await supabase
    .from('mn_extraction_runs')
    .select('note_id')
    .eq('user_id', userId)
    .eq('prompt_version', DECISION_PIPELINE_VERSION)
    .in('status', ['done', 'skipped'])
    .limit(10000);
  if (runsError) throw new Error(`run scan: ${runsError.message}`);
  const processed = new Set(((runs as Array<{ note_id: string }>) ?? []).map((r) => String(r.note_id)));

  const { batch, remaining } = selectBackfillCandidates(ordered, processed, limit);
  const outcomes = await runPool(batch, BACKFILL_CONCURRENCY, (noteId) =>
    runDecisionExtraction({ supabase, apiKey: input.apiKey, noteId, model: input.model, timeZone: input.timeZone })
      .catch((error): RunOutcome => ({ status: 'failed', reason: (error as Error).message ?? 'unknown' })));

  const result: BackfillResult = {
    pipelineVersion: DECISION_PIPELINE_VERSION,
    processed: batch.length, done: 0, skipped: 0, failed: 0, remaining,
    decisionsStored: 0, decidedStored: 0, failures: [], skips: [],
  };
  outcomes.forEach((o, i) => {
    if (o.status === 'done') {
      result.done += 1;
      result.decisionsStored += o.metrics.decisions;
      result.decidedStored += o.metrics.status_counts.decided ?? 0;
    } else if (o.status === 'skipped') {
      result.skipped += 1;
      result.skips.push({ noteId: batch[i], reason: o.reason.slice(0, 160) });
    } else {
      result.failed += 1;
      result.failures.push({ noteId: batch[i], reason: o.reason.slice(0, 160) });
    }
  });
  // Failed notes stay eligible: they are not in `processed`, so the next call retries them.
  result.remaining += result.failed;
  return result;
}
