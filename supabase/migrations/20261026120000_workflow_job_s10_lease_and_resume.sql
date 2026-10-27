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
-- * Every claim increments execution_generation and claim_count; only the one
--   UPDATE that matched receives the new generation. attempt_count counts
--   executions that actually started (a start claim, or workflow_job_begin_execution
--   after a recover claim loaded the request).
-- * The caps live in SQL: a recover claim on a row that already used its executions
--   (attempt_count) or its claims (claim_count) fails the row in the same statement
--   and returns claim_outcome = 'exhausted'. A client that loses the response still
--   leaves a terminated row, so no retry loop can keep a job processing forever.
--   Exception: when the job's note already exists (the work finished, only the
--   completed write was lost), the claim is a normal one, so the worker's note check
--   converges the job to completed instead of failing a saved note (same owner, or a
--   note without user_id, exactly as the worker's check). note.id is text,
--   like workflow_job.note_id. The function runs as security invoker for service_role,
--   which bypasses note RLS, so the existence check sees every note.
-- * The claim never returns the (possibly large) request; a resuming worker reads it
--   with workflow_job_load_request after its cheap checks passed.
-- * Renewal, writes, request load, execution begin and submission-begin match (id,
--   lease_owner, generation) and a non-terminal status, so a worker that lost its
--   lease reads and writes nothing.

begin;

alter table public.workflow_job
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists execution_generation integer not null default 0,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists claim_count integer not null default 0,
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
      and claim_count >= 0
      and transcript_submission_count >= 0
      and transcript_submission_state in ('none', 'submitting', 'submitted')
    );
  end if;
end $$;

-- Small partial index for the orphan sweep's candidate scan (non-terminal rows only).
create index if not exists workflow_job_active_lease_idx
  on public.workflow_job (lease_expires_at)
  where status in ('queued', 'processing');

-- Conditional claim. Returns one row (claim_outcome 'claimed', or 'exhausted' when a
-- recover claim found the caps used up and failed the row atomically) or no rows.
-- The exhausted error is localized from the stored request's language without
-- sending the request anywhere.
create or replace function public.workflow_job_claim(
  p_job_id uuid,
  p_owner text,
  p_mode text,
  p_lease_seconds integer,
  p_legacy_stale_seconds integer,
  p_max_attempts integer,
  p_max_claims integer,
  p_exhausted_error_en text,
  p_exhausted_error_ko text
) returns table (
  id uuid,
  user_id text,
  note_id text,
  status text,
  stage text,
  execution_generation integer,
  attempt_count integer,
  claim_count integer,
  assembly_transcript_id text,
  transcript_submission_state text,
  transcript_submission_count integer,
  claim_outcome text
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
         claim_count = j.claim_count + 1,
         attempt_count = case when p_mode = 'start' then j.attempt_count + 1 else j.attempt_count end,
         status = case when p_mode = 'recover' and (j.attempt_count >= p_max_attempts or j.claim_count >= p_max_claims)
           and not exists (select 1 from public.note n where n.id = j.note_id and (n.user_id is null or n.user_id = j.user_id)) then 'failed' else j.status end,
         stage = case when p_mode = 'recover' and (j.attempt_count >= p_max_attempts or j.claim_count >= p_max_claims)
           and not exists (select 1 from public.note n where n.id = j.note_id and (n.user_id is null or n.user_id = j.user_id)) then 'failed' else j.stage end,
         progress = case when p_mode = 'recover' and (j.attempt_count >= p_max_attempts or j.claim_count >= p_max_claims)
           and not exists (select 1 from public.note n where n.id = j.note_id and (n.user_id is null or n.user_id = j.user_id)) then 100 else j.progress end,
         error = case when p_mode = 'recover' and (j.attempt_count >= p_max_attempts or j.claim_count >= p_max_claims)
           and not exists (select 1 from public.note n where n.id = j.note_id and (n.user_id is null or n.user_id = j.user_id))
           then case when j.request ->> 'language' = 'ko' then p_exhausted_error_ko else p_exhausted_error_en end
           else j.error end,
         updated_at = clock_timestamp()
   where j.id = p_job_id
     and length(btrim(coalesce(p_owner, ''))) > 0
     and p_mode in ('start', 'recover')
     and p_lease_seconds between 1 and 3600
     and p_legacy_stale_seconds between 1 and 86400
     and p_max_attempts between 1 and 100
     and p_max_claims between p_max_attempts and 1000
     and length(btrim(coalesce(p_exhausted_error_en, ''))) > 0
     and length(btrim(coalesce(p_exhausted_error_ko, ''))) > 0
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
            j.execution_generation, j.attempt_count, j.claim_count, j.assembly_transcript_id,
            j.transcript_submission_state, j.transcript_submission_count,
            case when j.status = 'failed' then 'exhausted' else 'claimed' end;
$$;

-- The stored request for the current owner and generation of an active job, or null
-- when the caller lost the lease. Read only: a lost response costs nothing but time.
create or replace function public.workflow_job_load_request(
  p_job_id uuid,
  p_owner text,
  p_generation integer
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select j.request
    from public.workflow_job j
   where j.id = p_job_id
     and j.lease_owner = p_owner
     and j.execution_generation = p_generation
     and j.status in ('queued', 'processing');
$$;

-- Counts the start of a resumed execution. Returns the new attempt_count, or null when
-- the caller lost the lease, the job is terminal or its executions are used up.
create or replace function public.workflow_job_begin_execution(
  p_job_id uuid,
  p_owner text,
  p_generation integer,
  p_max_attempts integer
) returns integer
language sql
volatile
security invoker
set search_path = ''
as $$
  update public.workflow_job j
     set attempt_count = j.attempt_count + 1,
         updated_at = clock_timestamp()
   where j.id = p_job_id
     and j.lease_owner = p_owner
     and j.execution_generation = p_generation
     and j.status in ('queued', 'processing')
     and j.attempt_count < p_max_attempts
  returning j.attempt_count;
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
revoke all on function public.workflow_job_claim(uuid, text, text, integer, integer, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.workflow_job_load_request(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.workflow_job_begin_execution(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.workflow_job_renew_lease(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.workflow_job_write(uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.workflow_job_begin_transcript_submission(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.workflow_job_claim(uuid, text, text, integer, integer, integer, integer, text, text) to service_role;
grant execute on function public.workflow_job_load_request(uuid, text, integer) to service_role;
grant execute on function public.workflow_job_begin_execution(uuid, text, integer, integer) to service_role;
grant execute on function public.workflow_job_renew_lease(uuid, text, integer, integer) to service_role;
grant execute on function public.workflow_job_write(uuid, text, integer, jsonb) to service_role;
grant execute on function public.workflow_job_begin_transcript_submission(uuid, text, integer) to service_role;

commit;

-- Make PostgREST see the new columns and RPCs immediately.
notify pgrst, 'reload schema';
