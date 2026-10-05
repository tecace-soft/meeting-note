// Native PostgreSQL verification in an explicitly labelled local test container.
// No DATABASE_URL, production credentials, or hosted endpoint is accepted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const container = process.argv[2];
if (!container || !/^[a-zA-Z0-9_-]{1,80}$/.test(container)) throw new Error('Provide a local synthetic Docker container name.');
const root = fileURLToPath(new URL('../../', import.meta.url));
function command(args, input = '') {
  return new Promise((accept, reject) => {
    const child = spawn('docker', ['--host=unix:///var/run/docker.sock', ...args], { stdio: ['pipe','pipe','pipe'] });
    let output = ''; let error = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('NATIVE_CHECK_TIMEOUT')); }, 60_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', failure => { clearTimeout(timer); reject(failure); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? accept(output.trim()) : reject(new Error(error.slice(0, 500))); });
    child.stdin.end(input);
  });
}
const label = await command(['inspect', '--format', '{{index .Config.Labels "codex.synthetic"}}', container]);
assert.equal(label, 'meeting-knowledge', 'Refusing a container not labelled codex.synthetic=meeting-knowledge');
const sql = (database, text) => command(['exec','-i',container,'psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-U','postgres','-d',database], text);
const fixture = await readFile(resolve(root,'supabase/tests/meeting_knowledge_fixture_schema.sql'), 'utf8');
const migrations = (await readdir(resolve(root,'supabase/migrations'))).filter(name => /meeting_knowledge.*\.sql$/.test(name)).sort();
const checks = ['access_ledger','outbox','extraction','evidence_fetch','owner_operability'];
const assertions = {};
for (const variant of ['text','bigint']) {
  const database = `codex_knowledge_${variant}`;
  assert.equal(await sql('postgres', `select count(*) from pg_database where datname='${database}';`), '0', 'Use a fresh container for each run.');
  await sql('postgres', `create database ${database};`);
  await sql(database, fixture.replace('projects text[]', `projects ${variant}[]`).replace('public.project (id text', `public.project (id ${variant}`));
  for (const name of migrations) {
    const migration = await readFile(resolve(root,'supabase/migrations',name), 'utf8');
    await sql(database, migration);
    await sql(database, migration);
  }
  if (variant === 'text') {
    for (const name of checks) {
      process.stderr.write(`Native SQL check: ${name}\n`);
      const output = await sql(database, await readFile(resolve(root,`supabase/tests/meeting_knowledge_${name}.sql`), 'utf8'));
      assertions[name] = Number(output.split('\n').filter(Boolean).at(-1));
    }
  }
}
assert.deepEqual(assertions, { access_ledger:35, outbox:72, extraction:66, evidence_fetch:33, owner_operability:49 });

const database = 'codex_knowledge_bigint';
const tenant = '11111111-1111-4111-8111-111111111111';
const owner = '22222222-2222-4222-8222-000000000001';
const member = '22222222-2222-4222-8222-000000000003';
const text = 'Synthetic native source. 한국어 🎤';
const hash = createHash('sha256').update(text).digest('hex');
await sql(database, `insert into public.project values (9007199254740000,'${owner}',array['${member}']);
insert into public.note(id,user_id,transcription,projects) values ('native-source','${owner}','${text}',array[9007199254740000]::bigint[]);
set role service_role;
select public.meeting_knowledge_initialize('${tenant}','native-source','${owner}');
select public.meeting_knowledge_mutate('${tenant}','native-source','${owner}',1,'enable');`);
const record = JSON.parse(await sql(database, `set role service_role; select public.meeting_knowledge_current_source('${tenant}','native-source');`));
assert.equal(record.projects[0].projectId, '9007199254740000');
const args = `'${tenant}','native-source','${member}',${record.contentRevision},${record.speakerRevision},${record.accessRevision},${record.integrationGeneration},'${hash}'`;
const evidence = `select public.meeting_knowledge_current_evidence(${args})`;
assert.equal(JSON.parse(await sql(database, `set role service_role; ${evidence};`)).plaintext, text);
// Separate backend processes/connections: a held evidence read must serialize a
// concurrent edit. Synchronize via pg_stat_activity rather than timing guesses.
const reader = sql(database, `set application_name='codex_evidence_lock'; set role service_role; begin; ${evidence}; select pg_sleep(2); commit;`);
let observed = false;
for (let attempt=0; attempt<20; attempt++) {
  if (await sql(database, "select count(*) from pg_stat_activity where application_name='codex_evidence_lock' and wait_event='PgSleep';") === '1') { observed=true; break; }
  await new Promise(accept => setTimeout(accept, 50));
}
assert.equal(observed, true, 'Reader acquired native transaction locks');
await assert.rejects(sql(database, "set lock_timeout='150ms'; update public.note set transcription=transcription||' edit' where id='native-source';"), /lock timeout/);
await reader;
await sql(database, "update public.note set transcription=transcription||' edit' where id='native-source';");
assert.equal(await sql(database, `set role service_role; ${evidence} is null;`), 't');
assert.equal(await sql(database, "select content_revision from meeting_knowledge.source where source_id='native-source';"), '2');

// Native PG17 default locale previously made JSONB scalar comparison quadratic.
// A statement deadline verifies large escaped raw updates retain bounded cost;
// exact Unicode bytes and canonically equivalent object keys retain revisions.
await sql(database, "set statement_timeout='5s'; update public.note set transcription=repeat(E'\\n',460000) where id='native-source';");
assert.equal(await sql(database, "select content_revision from meeting_knowledge.source where source_id='native-source';"), '3');
await sql(database, "set statement_timeout='5s'; update public.note set transcription=transcription where id='native-source';");
assert.equal(await sql(database, "select content_revision from meeting_knowledge.source where source_id='native-source';"), '3');
await sql(database, "update public.note set transcription=U&'\\00E9' where id='native-source'; update public.note set transcription=U&'e\\0301' where id='native-source';");
assert.equal(await sql(database, "select content_revision from meeting_knowledge.source where source_id='native-source';"), '5');
await sql(database, `update public.note set diarization='{"alpha":"first","beta":"second"}'::jsonb where id='native-source';`);
const revisions = await sql(database, "select content_revision||':'||speaker_revision from meeting_knowledge.source where source_id='native-source';");
await sql(database, `update public.note set diarization='{"beta":"second","alpha":"first"}'::jsonb where id='native-source';`);
assert.equal(await sql(database, "select content_revision||':'||speaker_revision from meeting_knowledge.source where source_id='native-source';"), revisions);
// Leave the documented synthetic source available for the PostgREST runner.
await sql(database, `update public.note set transcription='${text} edit' where id='native-source';`);

await assert.rejects(sql(database, `set role anon; ${evidence};`), /permission denied/);
await assert.rejects(sql(database, `set role authenticated; ${evidence};`), /permission denied/);
const result = { engine:await sql(database,'select version();'), assertions, migrationCount:migrations.length,
  repeatedMigrations:true, bigintProjectId:true, separateConnectionLocking:true, staleReadDenied:true,
  browserRolesDenied:true, binaryChangeComparison:true, largeControlUpdateDeadline:true, hostedDatabaseUsed:false, database };
process.stdout.write(JSON.stringify(result)+'\n');
