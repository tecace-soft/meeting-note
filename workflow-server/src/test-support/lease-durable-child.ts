// Offline subprocess fixture: persists real PostgreSQL state outside the child lifetime.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createJobLeaseStore } from '../jobs/lease.js';
const db = new PGlite(process.argv[2]!);
const chain = [
  'supabase/tests/workflow_job_fixture_schema.sql',
  'supabase/migrations/20260601120000_create_workflow_usage_table.sql',
  'supabase/migrations/20260601121000_add_latency_to_workflow_usage.sql',
  'supabase/migrations/20260601122000_create_workflow_job_table.sql',
  'supabase/migrations/20260602123000_enable_backend_table_rls.sql',
  'supabase/migrations/20261009120100_reliability_transcript_checkpoint_and_active_job_uniq.sql',
  'supabase/migrations/20261026120000_workflow_job_s10_lease_and_resume.sql',
  'supabase/migrations/20261029180000_workflow_job_s12_shutdown.sql',
];
for (const path of chain) await db.exec(await readFile(new URL('../../../' + path, import.meta.url), 'utf8'));
const { rows } = await db.query<{ id: string }>(`insert into public.workflow_job(user_id,note_id,type,status,request)
  values('fixture-user','durable-note','summarize_audio','queued','{"language":"en"}') returning id`);
const id = rows[0]!.id;
// Keep the exact store argument contract and execute the real claim SQL.
const store = createJobLeaseStore(async (name, args) => {
  const keys = Object.keys(args);
  const named = keys.map((key, index) => `${key} => $${index + 1}`).join(',');
  return { data: (await db.query(`select * from public.${name}(${named})`, Object.values(args))).rows, error: null };
}, 'killed-worker');
await store.claim(id, 'start');
await db.query("update public.workflow_job set assembly_transcript_id='persisted-transcript', transcript_submission_state='submitted' where id=$1", [id]);
await db.syncToFs();
process.send?.({ id });
// Only this fixture process receives SIGKILL; PostgreSQL data is kept in the test's temp folder.
setInterval(() => undefined, 1000);
