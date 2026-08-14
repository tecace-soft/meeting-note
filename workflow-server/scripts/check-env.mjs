// Fail-loud env doctor (P2.3). Catches the exact mistake that silently broke the
// events backfill: a `.env` copied from `.env.example` but left with placeholder values
// (e.g. SUPABASE_URL still `https://your-project-ref.supabase.co`), which fails later with
// a confusing `getaddrinfo ENOTFOUND your-project-ref.supabase.co` deep inside a request.
// Run: `npm run env:check` (loads .env the same way the server does). Zero prod impact.
import { config } from 'dotenv';
config();

// CORE = needed by almost everything, including the eval/backfill scripts → hard-fail.
// PIPELINE = only needed by the full summarize server (not eval) → warn, don't fail, so an
// eval-only local setup passes while still surfacing a placeholder. Each: name + "is placeholder".
const CORE = [
  { name: 'SUPABASE_URL', placeholder: (v) => v.includes('your-project-ref') || !/^https:\/\/.+\.supabase\.co/.test(v) },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', placeholder: (v) => v.includes('your-') || v.length < 40 },
  { name: 'GEMINI_API_KEY', placeholder: (v) => v.includes('your-') || v.length < 20 },
];
const PIPELINE = [
  { name: 'ASSEMBLYAI_API_KEY', placeholder: (v) => v.includes('your-') || v.length < 20 },
];

function classify(list) {
  const bad = [];
  for (const { name, placeholder } of list) {
    const v = (process.env[name] ?? '').trim();
    if (!v) bad.push(`  ✗ ${name} is MISSING`);
    else if (placeholder(v)) bad.push(`  ✗ ${name} looks like a PLACEHOLDER / malformed value ("${v.slice(0, 24)}…")`);
    else process.stdout.write(`  ✓ ${name}\n`);
  }
  return bad;
}

const coreBad = classify(CORE);
const pipeBad = classify(PIPELINE);

if (pipeBad.length > 0) {
  process.stdout.write('\nenv:check WARNING — pipeline vars are placeholders (fine for eval-only; the full server needs them):\n');
  process.stdout.write(pipeBad.join('\n') + '\n');
}
if (coreBad.length > 0) {
  process.stderr.write('\nenv:check FAILED — fix these in workflow-server/.env (real values live in the Render service env for prod):\n');
  process.stderr.write(coreBad.join('\n') + '\n');
  process.exit(1);
}
process.stdout.write('\nenv:check PASSED — core env (Supabase + Gemini) is set with real values.\n');
