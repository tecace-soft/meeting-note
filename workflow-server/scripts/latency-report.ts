// Read-only latency diagnostics against prod `workflow_usage`.
// Answers "the summary generator is slow, even for short audio" by breaking latency
// down PER STAGE and correlating it with token count, so we can tell fixed overhead
// (slow even at low tokens) from length-scaling cost. Zero writes.
//
// Run from workflow-server/:
//   npx tsx scripts/latency-report.ts                 # last 14 days
//   LATENCY_DAYS=30 npx tsx scripts/latency-report.ts # wider window
//   LATENCY_STAGE=summary npx tsx scripts/latency-report.ts  # one stage, row-level dump

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const DAYS = Math.min(Number(process.env.LATENCY_DAYS ?? '14') || 14, 120);
const ONE_STAGE = process.env.LATENCY_STAGE?.trim() || null;
const PAGE = 1000;
const MAX_ROWS = 50000; // bounded (rule 1/8)

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

interface UsageRow {
  stage: string;
  model: string;
  input_type: string;
  total_tokens: number;
  prompt_tokens: number;
  candidates_tokens: number;
  latency_ms: number;
  estimated_cost_usd: number;
  created_at: string;
  note_id: string | null;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

async function fetchAll(sinceIso: string): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let q = createClient(SUPABASE_URL, SERVICE_KEY)
      .from('workflow_usage')
      .select('stage,model,input_type,total_tokens,prompt_tokens,candidates_tokens,latency_ms,estimated_cost_usd,created_at,note_id')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (ONE_STAGE) q = q.eq('stage', ONE_STAGE);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as UsageRow[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    log('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (run from workflow-server/ with .env).');
    process.exit(1);
  }
  const sinceIso = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  log(`\nworkflow_usage latency — last ${DAYS} days (since ${sinceIso.slice(0, 10)})\n`);

  const rows = await fetchAll(sinceIso);
  if (rows.length === 0) {
    log('No usage rows in window.');
    return;
  }

  // Per-stage aggregation.
  const byStage = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const key = `${r.stage}`;
    if (!byStage.has(key)) byStage.set(key, []);
    byStage.get(key)!.push(r);
  }

  const header = ['stage', 'n', 'p50', 'p95', 'max', 'avg_tok', 'p50_tok', 'ms/1k_tok', 'model'];
  log(header.map((h) => h.padEnd(h === 'stage' ? 22 : 10)).join(''));
  log('-'.repeat(112));

  const stageEntries = [...byStage.entries()].sort(
    (a, b) => pct(b[1].map((r) => r.latency_ms).sort((x, y) => x - y), 50) -
      pct(a[1].map((r) => r.latency_ms).sort((x, y) => x - y), 50)
  );

  for (const [stage, list] of stageEntries) {
    const lat = list.map((r) => r.latency_ms).sort((a, b) => a - b);
    const toks = list.map((r) => r.total_tokens).sort((a, b) => a - b);
    const avgTok = Math.round(list.reduce((s, r) => s + r.total_tokens, 0) / list.length);
    const p50lat = pct(lat, 50);
    const p50tok = pct(toks, 50);
    const msPer1k = p50tok > 0 ? Math.round((p50lat / p50tok) * 1000) : 0;
    const model = list[0]?.model ?? '';
    const cells = [
      stage.slice(0, 21).padEnd(22),
      String(list.length).padEnd(10),
      fmtMs(p50lat).padEnd(10),
      fmtMs(pct(lat, 95)).padEnd(10),
      fmtMs(pct(lat, 100)).padEnd(10),
      String(avgTok).padEnd(10),
      String(p50tok).padEnd(10),
      String(msPer1k).padEnd(10),
      model.slice(0, 24),
    ];
    log(cells.join(''));
  }

  // Fixed-overhead probe: for the summary stage, latency of the LOWEST-token quartile.
  // If short-transcript summaries are still slow, the cost is fixed, not length-driven.
  const summaryRows = byStage.get('summary') ?? byStage.get('summarize') ?? [];
  if (summaryRows.length >= 8) {
    const sorted = [...summaryRows].sort((a, b) => a.total_tokens - b.total_tokens);
    const lowQ = sorted.slice(0, Math.max(4, Math.floor(sorted.length / 4)));
    const lowLat = lowQ.map((r) => r.latency_ms).sort((a, b) => a - b);
    log('\n── summary stage: shortest-transcript quartile (fixed-overhead probe) ──');
    log(`  n=${lowQ.length}  tokens ${lowQ[0].total_tokens}..${lowQ[lowQ.length - 1].total_tokens}`);
    log(`  latency p50=${fmtMs(pct(lowLat, 50))}  p95=${fmtMs(pct(lowLat, 95))}  max=${fmtMs(pct(lowLat, 100))}`);
    log('  (if these are still multiple seconds, the summary latency is fixed overhead, not length)');
  }

  if (ONE_STAGE) {
    log(`\n── row-level dump: stage=${ONE_STAGE} (20 most recent) ──`);
    for (const r of rows.slice(0, 20)) {
      log(`  ${r.created_at.slice(0, 19)}  ${fmtMs(r.latency_ms).padStart(7)}  tok=${String(r.total_tokens).padStart(6)}  ${r.model}`);
    }
  }
  log('');
}

main().catch((e) => {
  log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
