// Reliability probe: the eval's headline finding on 2026-08-11 was that the REAL
// producers intermittently emit malformed or runaway JSON (so a note silently gets no
// insight/memory, with no retry). This measures that directly: call each producer N
// times on the golden transcript and report the parse-success rate + failure reasons.
// Cheap (no judge). Run: `npm run eval:stability`.

import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMemoryFold, extractInsight } from '../src/memory.js';
import type { InsightGolden, MemoryGolden } from './lib/types.js';

config();

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden');

function clampN(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '8', 10);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(20, n)); // bounded (Power-of-Ten rule 1/8)
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write('GEMINI_API_KEY is required.\n');
    process.exit(1);
    return;
  }
  const N = clampN(process.env.EVAL_STABILITY_N);
  const insight = JSON.parse(readFileSync(join(GOLDEN, 'insight', 'insight-2026-08-11.json'), 'utf8')) as InsightGolden;
  const memory = JSON.parse(readFileSync(join(GOLDEN, 'memory', 'memory-2026-08-11.json'), 'utf8')) as MemoryGolden;
  const now = process.env.EVAL_NOW?.trim() || '2026-08-11T00:00:00.000Z';

  let insightOk = 0;
  let memoryOk = 0;
  const insightFails: string[] = [];
  const memoryFails: string[] = [];
  const memoryOps: number[] = [];
  // Aggregate ops mix across runs — fold-share (update+supersede vs add) is the
  // deterministic before/after signal for the F1' supersede work (no judge needed).
  let totAdd = 0;
  let totFold = 0; // update + supersede
  let totArchive = 0;

  process.stdout.write(`\n=== F8 stability probe (N=${N}, model=gemini-2.5-flash-lite) ===\n`);
  for (let i = 1; i <= N; i += 1) {
    // Sequential to keep Gemini concurrency low.
    const ins = await extractInsight({ apiKey, transcript: insight.transcript, noteId: insight.noteId ?? null });
    if ('insight' in ins) {
      insightOk += 1;
    } else {
      insightFails.push(ins.error);
    }
    const mem = await computeMemoryFold({ apiKey, priorMemory: memory.priorMemory, transcript: memory.transcript, selfName: memory.selfName, noteId: memory.noteId ?? null, now });
    let mix = 'FAIL';
    if ('error' in mem) {
      memoryFails.push(mem.error);
    } else {
      memoryOk += 1;
      memoryOps.push(mem.ops.length);
      const add = mem.ops.filter((o) => o.op === 'add').length;
      const fold = mem.ops.filter((o) => o.op === 'update' || o.op === 'supersede').length;
      const archive = mem.ops.filter((o) => o.op === 'archive').length;
      totAdd += add;
      totFold += fold;
      totArchive += archive;
      mix = `${add} add / ${fold} upd+sup / ${archive} arch`;
    }
    process.stdout.write(`  run ${i}/${N}: insight ${'insight' in ins ? 'ok' : 'FAIL'}, memory ${'error' in mem ? 'FAIL' : `ok(${mix})`}\n`);
  }

  const totOps = totAdd + totFold + totArchive;
  process.stdout.write(`\ninsight parse-success: ${insightOk}/${N} (${((insightOk / N) * 100).toFixed(0)}%)\n`);
  process.stdout.write(`memory  parse-success: ${memoryOk}/${N} (${((memoryOk / N) * 100).toFixed(0)}%)\n`);
  if (memoryOps.length) process.stdout.write(`memory ops when ok: [${memoryOps.join(', ')}]\n`);
  process.stdout.write(`memory ops mix (all runs): ${totAdd} add, ${totFold} update+supersede, ${totArchive} archive\n`);
  process.stdout.write(`memory FOLD-SHARE (update+supersede / total): ${totOps ? ((totFold / totOps) * 100).toFixed(0) : '—'}% ${totOps ? `(${totFold}/${totOps})` : ''}\n`);
  for (const f of insightFails) process.stdout.write(`  insight FAIL: ${f.slice(0, 160)}\n`);
  for (const f of memoryFails) process.stdout.write(`  memory  FAIL: ${f.slice(0, 160)}\n`);
}

main().catch((error) => {
  process.stderr.write(`stability probe failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
