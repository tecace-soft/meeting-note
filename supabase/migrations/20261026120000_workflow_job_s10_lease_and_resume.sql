-- S10: lease, execution generation, attempt counter and AssemblyAI submission state
-- for workflow_job, plus the conditional claim, lease renewal, fenced write and
-- submission-begin RPCs that the workflow server uses to resume in-flight jobs
-- after a restart instead of failing them (DEC-0022).
--
-- Additive and backward compatible:
-- * Pre-S10 code (main before this change) keeps working unchanged: every new
--   column has a constant default, no existing column, index or policy changes,
--   and its id-only UPDATEs still succeed.
-- * S10 code deployed BEFORE this migration sees the RPCs missing (PGRST202 or
--   42883) or the columns missing (42703) and degrades to the pre-S10 behavior
--   (unfenced run, stale jobs failed by the orphan sweep).
-- Agents never apply migrations. Andrew applies it in the Supabase SQL Editor.
-- Read-only pre/post checks and the rollback script live in
-- docs/refactor/S10_MIGRATION_CHECKS.md.
--
-- Ownership model (one statement per transition, so Postgres row locks make each
-- one atomic):
-- * workflow_job_claim('start') takes a freshly inserted, never-claimed row.
-- * workflow_job_claim('recover') takes a non-terminal row whose lease expired by
--   DATABASE time, or a pre-S10 row (no lease) whose updated_at heartbeat is stale.
-- * Every claim increments execution_generation and attempt_count; only the one
--   UPDATE that matched receives the new generation.
-- * Renewal, writes and submission-begin match (id, lease_owner, generation) and a
--   non-terminal status, so a worker that lost its lease writes nothing.

begin;

alter table public.workflow_job
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists execution_generation integer not null default 0,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists assembly_transcript_id text,
  add column if not exists transcript_submission_state text not null default 'none',
  add column if not exists transcript_submission_count integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workflow_job_s10_state_check'
      and conrelid = 'public.workflow_job'::regclass
  ) then
    alter table public.workflow_job add constraint workflow_job_s10_state_check check (
      execution_generation >= 0
      and attempt_count >= 0
      and transcript_submission_count >= 0
      and transcript_submission_state in ('none', 'submitting', 'submitted')
    );
  end if;
end $$;

-- Small partial index for the orphan sweep's candidate scan (non-terminal rows only).
create index if not exists workflow_job_active_lease_idx
  on public.workflow_job (lease_expires_at)
  where status in ('queued', 'processing');

-- Conditional claim. Returns the claimed row (one row) or no rows. The stored request
-- (which can carry large base64 attachments) is returned only to a recover claim, which
-- needs it to rebuild the pipeline input; a start claim already has the input.
create or replace function public.workflow_job_claim(
  p_job_id uuid,
  p_owner text,
  p_mode text,
  p_lease_seconds integer,
  p_legacy_stale_seconds integer
) returns table (
  id uuid,
  user_id text,
  note_id text,
  status text,
  stage text,
  request jsonb,
  execution_generation integer,
  attempt_count integer,
  assembly_transcript_id text,
  transcript_submission_state text,
  transcript_submission_count integer
)
language sql
volatile
security invoker
set search_path = ''
as $$
  update public.workflow_job j
     set lease_owner = p_owner,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         execution_generation = j.execution_generation + 1,
         attempt_count = j.attempt_count + 1,
         updated_at = clock_timestamp()
   where j.id = p_job_id
     and length(btrim(coalesce(p_owner, ''))) > 0
     and p_lease_seconds between 1 and 3600
     and p_legacy_stale_seconds between 1 and 86400
     and j.status in ('queued', 'processing')
     and (
       (p_mode = 'start' and j.execution_generation = 0 and j.lease_owner is null)
       or (
         p_mode = 'recover'
         and (
           (j.lease_expires_at is not null and j.lease_expires_at <= clock_timestamp())
           or (
             j.lease_expires_at is null
             and j.updated_at < clock_timestamp() - make_interval(secs => p_legacy_stale_seconds)
           )
         )
       )
     )
  returning j.id, j.user_id, j.note_id, j.status, j.stage,
            case when p_mode = 'recover' then j.request end,
            j.execution_generation, j.attempt_count, j.assembly_transcript_id,
            j.transcript_submission_state, j.transcript_submission_count;
$$;

-- Heartbeat: extends the lease of the current owner and generation only.
-- Returns false when the caller no longer owns this generation.
create or replace function public.workflow_job_renew_lease(
  p_job_id uuid,
  p_owner text,
  p_generation integer,
  p_lease_seconds integer
) returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  with renewed as (
    update public.workflow_job j
       set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
           updated_at = clock_timestamp()
     where j.id = p_job_id
       and j.lease_owner = p_owner
       and j.execution_generation = p_generation
       and p_lease_seconds between 1 and 3600
    returning 1
  )
  select exists (select 1 from renewed);
$$;

-- Fenced write of whitelisted job fields. A key present in p_patch is written (a
-- JSON null clears result/error); an absent key is kept. Returns false when the
-- caller lost the lease or the job is already terminal (completed/failed are final).
create or replace function public.workflow_job_write(
  p_job_id uuid,
  p_owner text,
  p_generation integer,
  p_patch jsonb
) returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_written boolean;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object'
     or (p_patch - array['status', 'stage', 'progress', 'result', 'error',
                         'assembly_transcript_id', 'transcript_submission_state']) <> '{}'::jsonb then
    raise exception 'workflow_job_write: unsupported patch keys' using errcode = '22023';
  end if;
  if p_patch ? 'status' and coalesce(p_patch ->> 'status', '') not in ('processing', 'completed', 'failed') then
    raise exception 'workflow_job_write: unsupported status' using errcode = '22023';
  end if;
  with written as (
    update public.workflow_job j
       set status = case when p_patch ? 'status' then p_patch ->> 'status' else j.status end,
           stage = case when p_patch ? 'stage' then p_patch ->> 'stage' else j.stage end,
           progress = case when p_patch ? 'progress' then (p_patch ->> 'progress')::integer else j.progress end,
           result = case when p_patch ? 'result' then nullif(p_patch -> 'result', 'null'::jsonb) else j.result end,
           error = case when p_patch ? 'error' then p_patch ->> 'error' else j.error end,
           assembly_transcript_id = case when p_patch ? 'assembly_transcript_id'
             then p_patch ->> 'assembly_transcript_id' else j.assembly_transcript_id end,
           transcript_submission_state = case when p_patch ? 'transcript_submission_state'
             then p_patch ->> 'transcript_submission_state' else j.transcript_submission_state end,
           updated_at = clock_timestamp()
     where j.id = p_job_id
       and j.lease_owner = p_owner
       and j.execution_generation = p_generation
       and j.status in ('queued', 'processing')
    returning 1
  )
  select exists (select 1 from written) into v_written;
  return v_written;
end;
$$;

-- Marks an AssemblyAI submission as in flight BEFORE the provider call and counts
-- it, so a crash between the provider accepting it and the id being saved is
-- detectable on recovery. Returns the new submission count, or null when the
-- caller lost the lease or the job is terminal.
create or replace function public.workflow_job_begin_transcript_submission(
  p_job_id uuid,
  p_owner text,
  p_generation integer
) returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  update public.workflow_job j
     set transcript_submission_state = 'submitting',
         transcript_submission_count = j.transcript_submission_count + 1,
         assembly_transcript_id = null,
         updated_at = clock_timestamp()
   where j.id = p_job_id
     and j.lease_owner = p_owner
     and j.execution_generation = p_generation
     and j.status in ('queued', 'processing')
  returning j.transcript_submission_count;
$$;

-- Backend-only, like the table: no anon/authenticated access (RLS and the table
-- grants already deny them; revoking EXECUTE keeps the RPC surface closed too).
revoke all on function public.workflow_job_claim(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.workflow_job_renew_lease(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.workflow_job_write(uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.workflow_job_begin_transcript_submission(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.workflow_job_claim(uuid, text, text, integer, integer) to service_role;
grant execute on function public.workflow_job_renew_lease(uuid, text, integer, integer) to service_role;
grant execute on function public.workflow_job_write(uuid, text, integer, jsonb) to service_role;
grant execute on function public.workflow_job_begin_transcript_submission(uuid, text, integer) to service_role;

commit;

-- Make PostgREST see the new columns and RPCs immediately.
notify pgrst, 'reload schema';
