// One-time GC for personal memory: clean the run-on / duplicate pollution that the OLD
// concatenating consolidation left in user_memory rows. Runs the (fixed) consolidation
// pass TWICE per user — pass 1 atomizes run-on items (split), pass 2 dedups the resulting
// atoms (merge) — then writes the cleaned active set back.
//
// SAFE BY DEFAULT: dry-run (prints before/after, writes nothing). Pass --write to persist.
// Best-effort and idempotent: re-running a clean memory is a near no-op. Never drops
// information (split preserves content, merge unions sources); the model only proposes,
// the merge/split apply is deterministic.
//
//   npm run memory:gc                       # dry-run, ALL users
//   npm run memory:gc -- --user <uuid>      # dry-run, one user
//   npm run memory:gc -- --user <uuid> --write
//   npm run memory:gc -- --write            # persist for ALL users (after a dry-run review)

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { consolidateMemory, type MemoryItem } from '../src/memory.js';

config();

const PASSES = 2; // pass 1: atomize (split); pass 2: dedup the split atoms (merge).

function activeCount(items: MemoryItem[]): number {
  return items.filter((i) => i.status === 'active').length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const userIdx = args.indexOf('--user');
  const onlyUser = userIdx >= 0 ? args[userIdx + 1] : undefined;

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!apiKey || !url || !key) {
    process.stderr.write('Need GEMINI_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.\n');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  let query = db.from('user_memory').select('user_id, memory');
  if (onlyUser) query = query.eq('user_id', onlyUser);
  const { data, error } = await query;
  if (error) {
    process.stderr.write(`query failed: ${error.message}\n`);
    process.exit(1);
  }
  const rows = (data as Array<{ user_id: string; memory: unknown }>) ?? [];
  process.stdout.write(`\nMEMORY GC ${write ? '(WRITE)' : '(dry-run)'} — ${rows.length} user(s), ${PASSES} passes each\n\n`);

  let cleaned = 0;
  for (const row of rows) {
    const mem = row.memory && typeof row.memory === 'object' ? (row.memory as { version?: unknown; items?: unknown }) : {};
    if (mem.version !== 2 || !Array.isArray(mem.items)) {
      process.stdout.write(`• ${row.user_id.slice(0, 8)}: skipped (not v2)\n`);
      continue;
    }
    let items = mem.items as MemoryItem[];
    const before = activeCount(items);
    let totalMerged = 0;
    for (let p = 0; p < PASSES; p += 1) {
      const res = await consolidateMemory({ apiKey, items: JSON.parse(JSON.stringify(items)) as MemoryItem[] });
      items = res.items;
      totalMerged += res.merged;
    }
    const after = activeCount(items);
    const changed = after !== before || totalMerged > 0;
    process.stdout.write(`• ${row.user_id.slice(0, 8)}: active ${before} → ${after} (merged ${totalMerged})${changed ? '' : '  [no change]'}\n`);

    if (write && changed) {
      const { error: upErr } = await db
        .from('user_memory')
        .update({ memory: { version: 2, items } })
        .eq('user_id', row.user_id);
      if (upErr) process.stdout.write(`    WRITE FAILED: ${upErr.message}\n`);
      else cleaned += 1;
    }
  }
  process.stdout.write(`\n${write ? `wrote ${cleaned} row(s)` : 'dry-run: nothing written (pass --write to persist)'}\n`);
}

main().catch((error) => {
  process.stderr.write(`memory-gc failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
