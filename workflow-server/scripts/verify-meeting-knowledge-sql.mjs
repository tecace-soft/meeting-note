// Isolated PostgreSQL-engine verification; never opens a hosted database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// PostgreSQL errors may attach entire queries. Report only bounded diagnostic
// metadata from synthetic checks, never dump SQL or database payloads.
process.on('uncaughtException', error => {
  process.stderr.write(JSON.stringify({ code: error.code ?? 'VERIFY_FAILED', message: String(error.message).slice(0,512) }) + '\n');
  process.exit(1);
});

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-meeting-knowledge-sql.mjs /absolute/path/to/pglite/dist/index.js');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const root = fileURLToPath(new URL('../../', import.meta.url));
const bootstrap = await readFile(resolve(root, 'supabase/tests/meeting_knowledge_fixture_schema.sql'), 'utf8');
const migration = await readFile(resolve(root, 'supabase/migrations/20261004034140_meeting_knowledge_access_ledger.sql'), 'utf8');
const checks = await readFile(resolve(root, 'supabase/tests/meeting_knowledge_access_ledger.sql'), 'utf8');
const outboxMigration = await readFile(resolve(root, 'supabase/migrations/20261004042544_meeting_knowledge_transactional_outbox.sql'), 'utf8');
const outboxChecks = await readFile(resolve(root, 'supabase/tests/meeting_knowledge_outbox.sql'), 'utf8');
const extractionMigration = await readFile(resolve(root, 'supabase/migrations/20261004155113_meeting_knowledge_durable_extraction.sql'), 'utf8');
const extractionChecks = await readFile(resolve(root, 'supabase/tests/meeting_knowledge_extraction.sql'), 'utf8');
const evidenceMigration = await readFile(resolve(root, 'supabase/migrations/20261004194748_meeting_knowledge_evidence_fetch.sql'), 'utf8');
const evidenceChecks = await readFile(resolve(root, 'supabase/tests/meeting_knowledge_evidence_fetch.sql'), 'utf8');
const db = new PGlite();
let passedSqlAssertions;
let passedOutboxAssertions;
let passedExtractionAssertions;
let passedEvidenceAssertions;
let engine;
try {
  engine = (await db.query('select version() as engine')).rows[0].engine;
  await db.exec(bootstrap);
  await db.exec(migration);
  await db.exec(migration);
  await db.exec(outboxMigration);
  await db.exec(outboxMigration);
  await db.exec(extractionMigration);
  await db.exec(extractionMigration);
  await db.exec(evidenceMigration);
  await db.exec(evidenceMigration);
  const results = await db.exec(checks);
  passedSqlAssertions = results.flatMap(result => result.rows).find(row => 'passed_ledger_checks' in row)?.passed_ledger_checks;
  assert.equal(passedSqlAssertions, 35);
  const outboxResults = await db.exec(outboxChecks);
  passedOutboxAssertions = outboxResults.flatMap(result => result.rows).find(row => 'passed_outbox_checks' in row)?.passed_outbox_checks;
  assert.equal(passedOutboxAssertions, 72);
  const extractionResults = await db.exec(extractionChecks);
  passedExtractionAssertions = extractionResults.flatMap(result => result.rows).find(row => 'passed_extraction_checks' in row)?.passed_extraction_checks;
  assert.equal(passedExtractionAssertions, 66);
  const evidenceResults = await db.exec(evidenceChecks);
  passedEvidenceAssertions = evidenceResults.flatMap(result => result.rows).find(row => 'passed_evidence_checks' in row)?.passed_evidence_checks;
  assert.equal(passedEvidenceAssertions, 33);
  assert.equal((await db.query('select count(*)::int as count from meeting_knowledge.source')).rows[0].count, 0);
} finally { await db.close(); }

// Historical note/project schemas used both integer and UUID project arrays.
for (const type of ['uuid', 'integer']) {
  const database = new PGlite();
  const project = type === 'uuid' ? '55555555-5555-4555-8555-555555555555' : '123';
  const text = ' Synthetic raw text\n한글 🎤 ';
  const tenant = '11111111-1111-4111-8111-111111111111';
  const owner = '22222222-2222-4222-8222-000000000001';
  const member = '22222222-2222-4222-8222-000000000003';
  try {
    await database.exec(bootstrap.replace('projects text[]', `projects ${type}[]`)
      .replace('public.project (id text', `public.project (id ${type}`));
    await database.exec(migration);
    await database.exec(migration);
    await database.exec(outboxMigration);
    await database.exec(outboxMigration);
    await database.exec(extractionMigration);
    await database.exec(extractionMigration);
    await database.exec(evidenceMigration);
    await database.exec(evidenceMigration);
    await database.query('insert into public.project(id,user_id,shared_users) values ($1,$2,$3::text[])', [project, owner, [member]]);
    await database.query(`insert into public.note(id,user_id,transcription,projects) values ($1,$2,$3,$4::${type}[])`, ['synthetic-schema-variant', owner, text, [project]]);
    await database.exec('set role service_role');
    const record = (await database.query('select public.meeting_knowledge_initialize($1,$2,$3) as record', [tenant, 'synthetic-schema-variant', owner])).rows[0].record;
    assert.equal(record.sourceHash, createHash('sha256').update(text, 'utf8').digest('hex'));
    assert.deepEqual(record.noteProjectIds, [project]);
    assert.equal(record.projects[0].projectId, project);
    assert.equal(record.projects[0].sharedWith[0].objectId, member);
    await database.query('update public.project set shared_users = $1::text[] where id = $2', [[], project]);
    const changed = (await database.query('select public.meeting_knowledge_current_source($1,$2) as record', [tenant, 'synthetic-schema-variant'])).rows[0].record;
    assert.equal(changed.accessRevision, 2);
    assert.deepEqual(changed.projects[0].sharedWith, []);
    await database.query("select public.meeting_knowledge_mutate($1::uuid,$2::text,$3::uuid,2,'enable')", [tenant, 'synthetic-schema-variant', owner]);
    await database.query('update public.project set shared_users = $1::text[] where id = $2', [[member], project]);
    const enabled = (await database.query('select public.meeting_knowledge_current_source($1,$2) as record', [tenant, 'synthetic-schema-variant'])).rows[0].record;
    const args = [tenant, 'synthetic-schema-variant', member, enabled.contentRevision, enabled.speakerRevision,
      enabled.accessRevision, enabled.integrationGeneration, enabled.sourceHash];
    const evidenceSql = 'select public.meeting_knowledge_current_evidence($1::uuid,$2::text,$3::uuid,$4::bigint,$5::bigint,$6::bigint,$7::bigint,$8::text) as evidence';
    const evidence = (await database.query(evidenceSql, args)).rows[0].evidence;
    assert.equal(evidence.plaintext, text);
    assert.equal(evidence.record.projects[0].projectId, project);
    assert.equal(evidence.record.accessRevision, enabled.accessRevision);
    assert.equal((await database.query(evidenceSql, [tenant, 'synthetic-schema-variant', owner, ...args.slice(3)])).rows[0].evidence, null);
    await database.query('update public.project set shared_users = $1::text[] where id = $2', [[], project]);
    assert.equal((await database.query(evidenceSql, args)).rows[0].evidence, null);
  } finally { await database.close(); }
}
process.stdout.write(JSON.stringify({ engine, passedSqlAssertions, passedOutboxAssertions, passedExtractionAssertions, passedEvidenceAssertions, repeatedMigration: true, rolledBackSyntheticChecks: true, projectArrayVariants: ['uuid', 'integer'] }) + '\n');
