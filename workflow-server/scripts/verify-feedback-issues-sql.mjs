// Isolated PostgreSQL-engine verification of the F2 feedback-issues RLS migration.
// Never opens a hosted database: everything runs in an in-memory PGlite instance.
//
// Usage: node scripts/verify-feedback-issues-sql.mjs /absolute/path/to/pglite/dist/index.js
// (PGlite is not a repo dependency; install it into a scratch folder, same as the
// meeting-knowledge SQL harness.)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

process.on('uncaughtException', (error) => {
  process.stderr.write(JSON.stringify({ code: error.code ?? 'VERIFY_FAILED', message: String(error.message).slice(0, 512) }) + '\n');
  process.exit(1);
});

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-feedback-issues-sql.mjs /absolute/path/to/pglite/dist/index.js');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFile(resolve(root, path), 'utf8');

const fixture = await read('supabase/tests/feedback_issues_fixture_schema.sql');
const createMigration = await read('supabase/migrations/20260812230000_create_feedback_issues.sql');
const parityMigration = await read('supabase/migrations/20261014120000_feedback_issues_parity.sql');
const checks = await read('supabase/tests/feedback_issues_rls.sql');
const EXPECTED_CHECKS = 66;

const db = new PGlite();
let passed;
try {
  await db.exec(fixture);
  await db.exec(createMigration);
  // Run twice: the file must be safe to re-run (seed must not duplicate).
  await db.exec(parityMigration);
  await db.exec(parityMigration);
  const results = await db.exec(checks);
  passed = results.flatMap((result) => result.rows).find((row) => 'passed_feedback_checks' in row)?.passed_feedback_checks;
  assert.equal(Number(passed), EXPECTED_CHECKS);
} finally {
  await db.close();
}
process.stdout.write(JSON.stringify({ ok: true, passedFeedbackChecks: Number(passed) }) + '\n');
