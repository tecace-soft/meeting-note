/**
 * Stage 1 measurement for the speaker-suggestion feedback loop.
 *
 * Reads `speaker_suggestion_feedback` (the ground-truth log written by web + mobile when a
 * human confirms who an anonymous speaker is) and reports suggestion accuracy over time, so
 * we can SHOW whether the system is "getting progressively more accurate" (Hansoo's ask)
 * with a number instead of a claim.
 *
 * Accuracy is measured only over decisions where a suggestion WAS shown (accepted vs
 * overridden); `manual` rows (no suggestion) are reported separately as a coverage gap.
 *
 *   cd workflow-server && npm run speaker:feedback
 */
import { readFileSync } from 'node:fs';

function envVar(key: string): string {
  const fromProcess = process.env[key];
  if (fromProcess && fromProcess.trim()) return fromProcess.trim();
  try {
    const env = readFileSync('.env', 'utf8');
    const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^"|"$/g, '') : '';
  } catch {
    return '';
  }
}

interface Row {
  outcome: 'accepted' | 'overridden' | 'manual';
  source: string;
  suggested_name: string | null;
  suggested_confidence: number | null;
  created_at: string;
  client: string | null;
}

/** ISO week key (YYYY-Www) for grouping the trend. */
function weekKey(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const jan1 = new Date(Date.UTC(monday.getUTCFullYear(), 0, 1));
  const week = Math.floor((monday.getTime() - jan1.getTime()) / (7 * 864e5)) + 1;
  return `${monday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const url = envVar('SUPABASE_URL');
  const key = envVar('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }
  const res = await fetch(
    `${url}/rest/v1/speaker_suggestion_feedback?select=outcome,source,suggested_name,suggested_confidence,created_at,client&order=created_at.asc`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) {
    console.error(`Query failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const rows = (await res.json()) as Row[];
  if (rows.length === 0) {
    console.log('No speaker feedback logged yet. (Apply the migration + let users confirm speakers.)');
    return;
  }

  const withSuggestion = rows.filter((r) => r.outcome === 'accepted' || r.outcome === 'overridden');
  const accepted = withSuggestion.filter((r) => r.outcome === 'accepted').length;
  const manual = rows.filter((r) => r.outcome === 'manual').length;

  console.log(`\nSpeaker-suggestion feedback — ${rows.length} decisions logged\n`);
  console.log(`  Overall suggestion accuracy: ${pct(accepted, withSuggestion.length)}  (${accepted}/${withSuggestion.length} kept)`);
  console.log(`  Coverage gap (no suggestion shown, manual): ${manual}`);
  console.log(`  By client: ${['web', 'mobile'].map((c) => `${c} ${rows.filter((r) => r.client === c).length}`).join(', ')}`);

  // Trend: accuracy per ISO week — the "getting more accurate over time" signal.
  const byWeek = new Map<string, { acc: number; tot: number }>();
  for (const r of withSuggestion) {
    const k = weekKey(r.created_at);
    const cur = byWeek.get(k) ?? { acc: 0, tot: 0 };
    cur.tot += 1;
    if (r.outcome === 'accepted') cur.acc += 1;
    byWeek.set(k, cur);
  }
  console.log('\n  Weekly accuracy trend (suggested decisions only):');
  console.log('  week      accuracy   n');
  for (const k of [...byWeek.keys()].sort()) {
    const { acc, tot } = byWeek.get(k)!;
    console.log(`  ${k}   ${pct(acc, tot).padStart(6)}   ${tot}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
