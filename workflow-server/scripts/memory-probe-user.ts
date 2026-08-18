// Read-only: diagnose a single user's memory gap. Are their notes recent (post
// server-fold) or old? Did the shared fold path write note_insight even though
// user_memory is empty? Run:  USER=<uuid> npx tsx scripts/memory-probe-user.ts
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config();
const sb = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
const USER = process.env.USER_ID ?? process.env.USER ?? '';
const FOLD_LIVE = '2026-08-11'; // server-side fold shipped ~here (c88ee76 / db7345d)

async function main(): Promise<void> {
  if (!USER) { process.stdout.write('Set USER_ID=<uuid>\n'); return; }
  // Note recency.
  const { data: notes, error: nErr } = await sb
    .from('note').select('id, created_at').eq('user_id', USER).order('created_at', { ascending: false });
  if (nErr) throw new Error(`note: ${nErr.message}`);
  const rows = (notes ?? []) as Array<{ id: string; created_at: string }>;
  const recent = rows.filter((r) => (r.created_at ?? '') >= FOLD_LIVE);
  process.stdout.write(`\nUser ${USER}\n`);
  process.stdout.write(`  total notes: ${rows.length}\n`);
  process.stdout.write(`  newest: ${rows[0]?.created_at ?? '(none)'}\n`);
  process.stdout.write(`  oldest: ${rows[rows.length - 1]?.created_at ?? '(none)'}\n`);
  process.stdout.write(`  notes since fold went live (${FOLD_LIVE}): ${recent.length}\n`);

  // user_memory row?
  const { data: mem } = await sb.from('user_memory').select('user_id, processed_note_ids, updated_at').eq('user_id', USER).maybeSingle();
  process.stdout.write(`  user_memory row: ${mem ? 'YES' : 'NO'}\n`);

  // note_insight coverage (same fold path writes it). Check the most recent notes.
  const sample = rows.slice(0, 25).map((r) => r.id);
  if (sample.length > 0) {
    const { data: ins, error: iErr } = await sb.from('note_insight').select('note_id').in('note_id', sample);
    if (iErr) { process.stdout.write(`  note_insight: ERROR ${iErr.message}\n`); }
    else {
      const have = new Set((ins ?? []).map((r) => (r as { note_id: string }).note_id));
      process.stdout.write(`  note_insight present for newest ${sample.length} notes: ${have.size}/${sample.length}\n`);
      const recentSample = recent.slice(0, 25).map((r) => r.id);
      const recentHave = recentSample.filter((id) => have.has(id)).length;
      process.stdout.write(`    of newest ${recentSample.length} POST-fold notes: ${recentHave} have note_insight\n`);
    }
  }
  process.stdout.write('\n  => If POST-fold notes exist but have neither user_memory nor note_insight, the fold is NOT running for this user (bug). If there are ~0 post-fold notes, the gap is just "no new recordings since fold shipped".\n\n');
}
main().catch((e) => { process.stdout.write(`ERROR: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
