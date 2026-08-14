// F8 CI gate. Runs the same scoring as `npm run eval`, then checks each ran surface's
// metrics against eval/thresholds.json and EXITS NON-ZERO if any gated metric is out of
// bounds (or missing on a surface that ran). This promotes the harness from measure-only
// to a regression gate — the boss's "evaluation is first-class / hypothesis-driven"
// directive. Run: `npm run eval:gate` (needs GEMINI_API_KEY). Tune floors in thresholds.json.

import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeps, collectScores } from './run.js';
import type { SurfaceScore } from './lib/types.js';

config();

const HERE = dirname(fileURLToPath(import.meta.url));

interface Threshold {
  metric: string;
  min?: number;
  max?: number;
}

interface CheckResult {
  surface: string;
  metric: string;
  bound: string;
  actual: number | null; // null = metric missing on a ran surface
  pass: boolean;
}

/** Load thresholds.json as { surfacePrefix: Threshold[] }, ignoring the `_comment` key. */
function loadThresholds(): Record<string, Threshold[]> {
  const raw = JSON.parse(readFileSync(join(HERE, 'thresholds.json'), 'utf8')) as Record<string, unknown>;
  const out: Record<string, Threshold[]> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith('_')) continue; // _comment
    if (Array.isArray(val)) out[key] = val as Threshold[];
  }
  return out;
}

/** Check one surface's metrics against the thresholds whose prefix it matches. */
function checkSurface(score: SurfaceScore, thresholds: Record<string, Threshold[]>): CheckResult[] {
  const results: CheckResult[] = [];
  for (const [prefix, checks] of Object.entries(thresholds)) {
    if (!score.surface.startsWith(prefix)) continue;
    for (const t of checks) {
      const m = score.metrics.find((x) => x.label.startsWith(t.metric));
      const bound = t.min !== undefined ? `>= ${t.min}` : t.max !== undefined ? `<= ${t.max}` : '(no bound)';
      if (!m) {
        // Missing on a surface that RAN = the quality metric was dropped because the
        // producer failed. That is exactly the reliability regression we gate on.
        results.push({ surface: score.surface, metric: t.metric, bound, actual: null, pass: false });
        continue;
      }
      let pass = true;
      if (t.min !== undefined && m.value < t.min) pass = false;
      if (t.max !== undefined && m.value > t.max) pass = false;
      results.push({ surface: score.surface, metric: t.metric, bound, actual: m.value, pass });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const thresholds = loadThresholds();
  const deps = buildDeps();
  const scores = await collectScores(deps);

  if (scores.length === 0) {
    process.stderr.write('eval:gate — no golden cases found; nothing to gate.\n');
    process.exit(1);
    return;
  }

  const results: CheckResult[] = [];
  for (const score of scores) {
    if (!score.ran) continue; // a skipped surface (e.g. search without prod creds) is not gated
    results.push(...checkSurface(score, thresholds));
  }

  if (results.length === 0) {
    process.stderr.write('eval:gate — no gated metrics matched any ran surface. Check thresholds.json prefixes.\n');
    process.exit(1);
    return;
  }

  process.stdout.write('\nF8 gate\n');
  for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    const actual = r.actual === null ? 'MISSING' : r.actual.toFixed(3);
    process.stdout.write(`  [${mark}] ${r.surface}  ${r.metric} ${r.bound}  (actual ${actual})\n`);
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    process.stdout.write(`\neval:gate FAILED — ${failed.length}/${results.length} checks below threshold.\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`\neval:gate PASSED — ${results.length}/${results.length} checks met.\n`);
}

main().catch((error) => {
  process.stderr.write(`eval:gate errored: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
