// Isolated PostgreSQL-engine verification; never opens a hosted database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-meeting-knowledge-sql.mjs /absolute/path/to/pglite/dist/index.js');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[2])).href);
const root = fileURLToPath(new URL('../../', import.meta.url));
const bootstrap = await readFile(resolve(root, 'supabase/tests/meeting_knowledge_fixture_schema.sql'), 'utf8');
const migration = await readFile(resolve(root, 'supabase/migrations/20261004034140_meeting_knowledge_access_ledger.sql'), 'utf8');
const checks = await readFile(resolve(root, 'supabase/tests/meeting_knowledge_access_ledger.sql'), 'utf8');
const db = new PGlite();
let passedSqlAssertions;
let engine;
try {
  engine = (await db.query('select version() as engine')).rows[0].engine;
  await db.exec(bootstrap);
  await db.exec(migration);
  await db.exec(migration);
  const results = await db.exec(checks);
  passedSqlAssertions = results.flatMap(result => result.rows).find(row => 'passed_ledger_checks' in row)?.passed_ledger_checks;
  assert.equal(passedSqlAssertions, 35);
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
  } finally { await database.close(); }
}
process.stdout.write(JSON.stringify({ engine, passedSqlAssertions, repeatedMigration: true, projectArrayVariants: ['uuid', 'integer'] }) + '\n');
