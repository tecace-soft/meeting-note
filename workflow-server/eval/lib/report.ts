// Console report + JSON snapshot writer.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SurfaceScore } from './types.js';
import { pct } from './util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, '..', 'results');

export function printReport(scores: SurfaceScore[], stampedAt: string): void {
  process.stdout.write(`\n=== F8 eval — ${stampedAt} ===\n`);
  for (const s of scores) {
    if (!s.ran) {
      process.stdout.write(`\n[${s.surface}] SKIPPED — ${s.skippedReason ?? 'no reason given'}\n`);
      continue;
    }
    process.stdout.write(`\n[${s.surface}]\n`);
    for (const m of s.metrics) {
      const isCount = m.label.includes('lower better') || m.label.includes('(count');
      const value = isCount ? String(m.value) : pct(m.value);
      process.stdout.write(`  ${m.label.padEnd(42)} ${value}${m.detail ? `   (${m.detail})` : ''}\n`);
    }
    for (const note of s.notes) process.stdout.write(`  · ${note}\n`);
  }
  process.stdout.write('\n');
}

/** Persist a machine-readable snapshot so before/after runs can be diffed later. */
export function writeSnapshot(scores: SurfaceScore[], stampedAt: string): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${stampedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ stampedAt, scores }, null, 2), 'utf8');
  return file;
}
