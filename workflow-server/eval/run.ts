// F8 evaluation harness entry point. Loads the golden sets, runs each surface against
// the REAL producers (extractInsight / computeMemoryFold / search_notes), scores them
// (deterministic + LLM judge), prints a table, and writes a JSON snapshot for
// before/after diffs. Run: `npm run eval` (from workflow-server/).

import { config } from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printReport, writeSnapshot } from './lib/report.js';
import type { EvalDeps, InsightGolden, MemoryGolden, SearchGolden, SpeakerIdGolden, SurfaceScore } from './lib/types.js';
import { runInsightSurface } from './surfaces/insight.js';
import { runMemorySurface } from './surfaces/memory.js';
import { runSearchSurface } from './surfaces/search.js';
import { runSpeakerIdSurface } from './surfaces/speakerId.js';

config();

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden');
const MAX_CASES_PER_SURFACE = 20; // bound (Power-of-Ten rule 1/8)

function loadGolden<T>(subdir: string): T[] {
  let files: string[];
  try {
    files = readdirSync(join(GOLDEN, subdir)).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no golden dir yet for this surface
  }
  const out: T[] = [];
  for (const f of files.slice(0, MAX_CASES_PER_SURFACE)) {
    out.push(JSON.parse(readFileSync(join(GOLDEN, subdir, f), 'utf8')) as T);
  }
  return out;
}

async function main(): Promise<void> {
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
  if (!geminiApiKey) {
    process.stderr.write('GEMINI_API_KEY is required to run the eval (insight + memory surfaces call Gemini).\n');
    process.exit(1);
    return;
  }
  const deps: EvalDeps = {
    geminiApiKey,
    judgeModel: process.env.EVAL_JUDGE_MODEL?.trim() || 'gemini-2.5-flash',
    now: process.env.EVAL_NOW?.trim() || '2026-08-11T00:00:00.000Z', // fixed clock → reproducible fold
  };

  const insightGolden = loadGolden<InsightGolden>('insight');
  const memoryGolden = loadGolden<MemoryGolden>('memory');
  const searchGolden = loadGolden<SearchGolden>('search');
  const speakerGolden = loadGolden<SpeakerIdGolden>('speaker');

  const scores: SurfaceScore[] = [];
  // Surfaces run sequentially to keep Gemini concurrency (and rate-limit risk) low.
  for (const g of insightGolden) scores.push(await runInsightSurface(g, deps));
  for (const g of memoryGolden) scores.push(await runMemorySurface(g, deps));
  for (const g of speakerGolden) scores.push(await runSpeakerIdSurface(g, deps));
  for (const g of searchGolden) scores.push(await runSearchSurface(g, deps));

  if (scores.length === 0) {
    process.stderr.write('No golden cases found under eval/golden/. Nothing to score.\n');
    process.exit(1);
    return;
  }

  const stampedAt = new Date().toISOString();
  printReport(scores, stampedAt);
  const file = writeSnapshot(scores, stampedAt);
  process.stdout.write(`snapshot: ${file}\n`);
}

main().catch((error) => {
  process.stderr.write(`eval failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
