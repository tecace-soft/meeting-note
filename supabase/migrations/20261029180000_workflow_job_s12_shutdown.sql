-- S12: bounded shutdown handoff and atomic job-owned note writes.
-- Andrew applies this file in SQL Editor after the combined PRE check.
-- No recording, request, transcript marker or checkpoint is deleted.
begin;
alter table public.workflow_job
  add column if not exists postprocessing_status text not null default 'none';
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.workflow_job'::regclass and conname='workflow_job_postprocessing_status_check') then
    alter table public.workflow_job add constraint workflow_job_postprocessing_status_check
      check(postprocessing_status in ('none','pending','done'));
  end if;
end $$;
-- A completed row retains request/result as the durable enrichment source.
-- Existing completed rows default to none and are not replayed by this migration.
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
           and not exists (select 1 from public.note n where n.id = j.note_id and n.user_id = j.user_id) then 'failed' else j.status end,
         stage = case when p_mode = 'recover' and (j.attempt_count >= p_max_attempts or j.claim_count >= p_max_claims)
           and not exists (select 1 from public.note n where n.id = j.note_id and n.user_id = j.user_id) then 'failed' else j.stage end,
         progress = case when p_mode = 'recover' and (j.attempt_count >= p_max_attempts or j.claim_count >= p_max_claims)
           and not exists (select 1 from public.note n where n.id = j.note_id and n.user_id = j.user_id) then 100 else j.progress end,
         error = case when p_mode = 'recover' and (j.attempt_count >= p_max_attempts or j.claim_count >= p_max_claims)
           and not exists (select 1 from public.note n where n.id = j.note_id and n.user_id = j.user_id)
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
       set postprocessing_status = case when p_patch ->> 'status' = 'completed' then 'pending' else j.postprocessing_status end,
           status = case when p_patch ? 'status' then p_patch ->> 'status' else j.status end,
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


create or replace function public.workflow_job_release(p_job_id uuid, p_owner text, p_generation integer)
returns boolean language sql volatile security invoker set search_path = '' as $$
  with released as (
    update public.workflow_job j
       set status = case when j.status in ('queued','processing') then 'queued' else j.status end,
           lease_owner = null, lease_expires_at = clock_timestamp() - interval '1 second',
           updated_at = clock_timestamp()
     where j.id = p_job_id and j.lease_owner = p_owner and j.execution_generation = p_generation
       and j.lease_expires_at > clock_timestamp()
       and j.status in ('queued','processing','completed')
    returning 1
  ) select exists(select 1 from released);
$$;

-- Lock the job, verify its live lease and identity, then mutate note in this transaction.
-- Explicit columns preserve defaults of unrelated note columns on first insert.
create or replace function public.workflow_job_persist_note(
  p_job_id uuid, p_owner text, p_generation integer, p_note jsonb, p_mode text
) returns boolean language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_job public.workflow_job%rowtype;
  v_note public.note%rowtype;
  v_existing public.note%rowtype;
begin
  select * into v_job from public.workflow_job j
    where j.id=p_job_id and j.lease_owner=p_owner and j.execution_generation=p_generation
      and j.lease_expires_at > clock_timestamp()
      and (j.status in ('queued','processing') or (p_mode='diarization' and j.status='completed' and j.postprocessing_status='pending'))
    for update;
  if not found then return false; end if;
  if jsonb_typeof(p_note) <> 'object' or p_mode not in ('insert','diarization') then
    raise exception 'Invalid job note payload' using errcode='22023';
  end if;
  if p_note->>'id' is distinct from v_job.note_id or p_note->>'user_id' is distinct from v_job.user_id then return false; end if;
  if p_mode='insert' then
    if (p_note - array['id','user_id','user_name','transcription','transcription_language','transcription_translations',
      'summary','summary_translations','audio_file','name','tags','diarization','diarization_translations','meeting_at','audio_file_id','duration_seconds']) <> '{}'::jsonb then
      raise exception 'Unsupported job note fields' using errcode='22023';
    end if;
    v_note := jsonb_populate_record(null::public.note,p_note);
    insert into public.note(id,user_id,user_name,transcription,transcription_language,transcription_translations,
      summary,summary_translations,audio_file,name,tags,diarization,diarization_translations,meeting_at,audio_file_id,duration_seconds)
    values(v_note.id,v_note.user_id,v_note.user_name,v_note.transcription,v_note.transcription_language,coalesce(v_note.transcription_translations,'{}'::jsonb),
      v_note.summary,coalesce(v_note.summary_translations,'{}'::jsonb),v_note.audio_file,v_note.name,v_note.tags,v_note.diarization,
      coalesce(v_note.diarization_translations,'{}'::jsonb),v_note.meeting_at,v_note.audio_file_id,v_note.duration_seconds)
    on conflict(id) do nothing;
    select * into v_existing from public.note n where n.id=v_job.note_id for update;
    return found and v_existing.user_id is not distinct from v_job.user_id;
  end if;
  if (p_note - array['id','user_id','diarization','diarization_before']) <> '{}'::jsonb then
    raise exception 'Unsupported diarization fields' using errcode='22023';
  end if;
  update public.note n set diarization=p_note->'diarization'
    where n.id=v_job.note_id and n.user_id=v_job.user_id
      and n.diarization is not distinct from p_note->'diarization_before';
  return found;
end;
$$;

create or replace function public.workflow_job_postprocessing_done(p_job_id uuid, p_owner text, p_generation integer)
returns boolean language sql volatile security invoker set search_path = '' as $$
  with finished as (
    update public.workflow_job j set postprocessing_status='done', updated_at=clock_timestamp()
    where j.id=p_job_id and j.lease_owner=p_owner and j.execution_generation=p_generation
      and j.lease_expires_at > clock_timestamp() and j.status='completed' and j.postprocessing_status='pending'
    returning 1
  ) select exists(select 1 from finished);
$$;
-- Completed work stays completed. Only its current generation may enrich it.
create or replace function public.workflow_job_write_enrichment(
  p_job_id uuid, p_owner text, p_generation integer, p_kind text, p_payload jsonb
) returns boolean language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_job public.workflow_job%rowtype;
  v_memory public.user_memory%rowtype;
  v_insight public.note_insight%rowtype;
begin
  select * into v_job from public.workflow_job j
    where j.id=p_job_id and j.lease_owner=p_owner and j.execution_generation=p_generation
      and j.lease_expires_at > clock_timestamp() and j.status='completed' and j.postprocessing_status='pending'
    for update;
  if not found then return false; end if;
  if p_payload->>'user_id' is distinct from v_job.user_id
    or not exists(select 1 from public.note n where n.id=v_job.note_id and n.user_id=v_job.user_id) then return false; end if;
  if p_kind='memory' then
    if (p_payload - array['user_id','memory','processed_note_ids','updated_at']) <> '{}'::jsonb then
      raise exception 'Unsupported memory fields' using errcode='22023';
    end if;
    v_memory := jsonb_populate_record(null::public.user_memory,p_payload);
    if not (v_job.note_id = any(v_memory.processed_note_ids)) then return false; end if;
    insert into public.user_memory(user_id,memory,processed_note_ids,updated_at)
      values(v_job.user_id,v_memory.memory,v_memory.processed_note_ids,clock_timestamp())
      on conflict(user_id) do update set memory=excluded.memory, processed_note_ids=excluded.processed_note_ids, updated_at=excluded.updated_at
      where not (v_job.note_id=any(public.user_memory.processed_note_ids));
    -- An already-folded note is a successful no-op, never a second fold.
    return true;
  elsif p_kind='insight' then
    if p_payload->>'note_id' is distinct from v_job.note_id then return false; end if;
    if (p_payload - array['note_id','user_id','actions','decisions','events','topics','people','companies','source_model','updated_at']) <> '{}'::jsonb then
      raise exception 'Unsupported insight fields' using errcode='22023';
    end if;
    v_insight := jsonb_populate_record(null::public.note_insight,p_payload);
    insert into public.note_insight(note_id,user_id,actions,decisions,events,topics,people,companies,source_model,updated_at)
      values(v_job.note_id,v_job.user_id,v_insight.actions,v_insight.decisions,v_insight.events,v_insight.topics,v_insight.people,v_insight.companies,v_insight.source_model,clock_timestamp())
      on conflict(note_id) do update set actions=excluded.actions, decisions=excluded.decisions, events=excluded.events,
        topics=excluded.topics, people=excluded.people, companies=excluded.companies, source_model=excluded.source_model, updated_at=excluded.updated_at
      where public.note_insight.user_id=v_job.user_id;
    return found;
  end if;
  raise exception 'Unsupported enrichment kind' using errcode='22023';
end;
$$;
revoke all on function public.workflow_job_write_enrichment(uuid,text,integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.workflow_job_write_enrichment(uuid,text,integer,text,jsonb) to service_role;
revoke all on function public.workflow_job_release(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.workflow_job_release(uuid, text, integer) to service_role;
revoke all on function public.workflow_job_persist_note(uuid, text, integer, jsonb, text) from public, anon, authenticated;
grant execute on function public.workflow_job_persist_note(uuid, text, integer, jsonb, text) to service_role;
revoke all on function public.workflow_job_postprocessing_done(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.workflow_job_postprocessing_done(uuid, text, integer) to service_role;
commit;
