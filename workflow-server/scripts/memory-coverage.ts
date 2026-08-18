// Read-only: is personal memory (F1' user_memory) being created + accumulating for
// ALL users, not just one? Reports per-user memory size + note coverage. Zero writes.
//   Run from workflow-server/:  npx tsx scripts/memory-coverage.ts
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config();
const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');

function activeItems(memory: unknown): number {
  const o = memory && typeof memory === 'object' ? (memory as Record<string, unknown>) : {};
  const items = Array.isArray(o.items) ? o.items : [];
  return items.filter((it) => it && typeof it === 'object' && (it as Record<string, unknown>).status !== 'archived').length;
}
function totalItems(memory: unknown): number {
  const o = memory && typeof memory === 'object' ? (memory as Record<string, unknown>) : {};
  return Array.isArray(o.items) ? o.items.length : 0;
}

async function main(): Promise<void> {
  // Note owners: how many distinct users actually have notes.
  const noteCounts = new Map<string, number>();
  for (let from = 0; from < 100000; from += 1000) {
    const { data, error } = await sb.from('note').select('user_id').range(from, from + 999);
    if (error) throw new Error(`note: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ user_id: string | null }>) {
      if (r.user_id) noteCounts.set(r.user_id, (noteCounts.get(r.user_id) ?? 0) + 1);
    }
    if (data.length < 1000) break;
  }

  const { data: mem, error: memErr } = await sb
    .from('user_memory')
    .select('user_id, memory, processed_note_ids, updated_at');
  if (memErr) throw new Error(`user_memory: ${memErr.message}`);
  const rows = (mem ?? []) as Array<{ user_id: string; memory: unknown; processed_note_ids: string[] | null; updated_at: string | null }>;

  process.stdout.write(`\nDistinct note owners: ${noteCounts.size}\n`);
  process.stdout.write(`user_memory rows:     ${rows.length}\n\n`);

  process.stdout.write(`${'user_id'.padEnd(38)}${'active'.padEnd(8)}${'total'.padEnd(8)}${'folded'.padEnd(8)}${'notes'.padEnd(7)}updated_at\n`);
  process.stdout.write('-'.repeat(100) + '\n');
  const byNotes = [...rows].sort((a, b) => (noteCounts.get(b.user_id) ?? 0) - (noteCounts.get(a.user_id) ?? 0));
  for (const r of byNotes) {
    const folded = Array.isArray(r.processed_note_ids) ? r.processed_note_ids.length : 0;
    process.stdout.write(
      `${r.user_id.padEnd(38)}${String(activeItems(r.memory)).padEnd(8)}${String(totalItems(r.memory)).padEnd(8)}` +
      `${String(folded).padEnd(8)}${String(noteCounts.get(r.user_id) ?? 0).padEnd(7)}${(r.updated_at ?? '').slice(0, 19)}\n`
    );
  }

  // Coverage: note owners WITHOUT any memory row.
  const memUsers = new Set(rows.map((r) => r.user_id));
  const missing = [...noteCounts.entries()].filter(([u]) => !memUsers.has(u)).sort((a, b) => b[1] - a[1]);
  process.stdout.write(`\nNote owners with NO user_memory row: ${missing.length}\n`);
  for (const [u, n] of missing.slice(0, 15)) process.stdout.write(`  ${u}  notes=${n}\n`);

  // Health flags: has notes+memory row but 0 active items, or folded << notes.
  const stalled = byNotes.filter((r) => (noteCounts.get(r.user_id) ?? 0) >= 2 && activeItems(r.memory) === 0);
  if (stalled.length > 0) {
    process.stdout.write(`\n⚠ users with notes but 0 active memory items: ${stalled.length}\n`);
    for (const r of stalled.slice(0, 15)) process.stdout.write(`  ${r.user_id}  notes=${noteCounts.get(r.user_id)}\n`);
  }
  process.stdout.write('\n');
}
main().catch((e) => { process.stdout.write(`ERROR: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
