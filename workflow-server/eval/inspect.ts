// Diagnostic: dump what the insight producer actually extracts for each golden, so a
// weak field (e.g. decisions) can be diagnosed — over-tagging vs missing vs a labeling
// boundary. Run: `npm run eval:inspect` (optionally EVAL_INSPECT_FIELD=decisions).

import { config } from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInsight } from '../src/memory.js';
import type { InsightGolden } from './lib/types.js';

config();

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'golden', 'insight');

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write('GEMINI_API_KEY is required.\n');
    process.exit(1);
    return;
  }
  const field = (process.env.EVAL_INSPECT_FIELD?.trim() || 'decisions') as 'actions' | 'decisions' | 'events' | 'topics' | 'people' | 'companies';
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

  for (const f of files) {
    const g = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as InsightGolden;
    const res = await extractInsight({ apiKey, transcript: g.transcript, noteId: g.noteId ?? null });
    process.stdout.write(`\n===== ${g.name} — ${field} =====\n`);
    if ('error' in res) {
      process.stdout.write(`  extraction FAILED: ${res.error}\n`);
      continue;
    }
    const expected = (g.expected[field] as string[] | undefined) ?? [];
    const actualRaw = res.insight[field];
    // events is {cause,effect}[]; flatten to "cause → effect" like the surface scorer does.
    const actual = Array.isArray(actualRaw)
      ? actualRaw.map((x) =>
          typeof x === 'string' ? x
          : x && typeof x === 'object' && 'cause' in x ? `${(x as { cause: string }).cause} → ${(x as { effect: string }).effect}`
          : JSON.stringify(x))
      : [];
    process.stdout.write(`  EXPECTED (${expected.length}):\n`);
    for (const e of expected) process.stdout.write(`    - ${e}\n`);
    process.stdout.write(`  EXTRACTED (${actual.length}):\n`);
    for (const a of actual) process.stdout.write(`    · ${a}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`inspect failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
