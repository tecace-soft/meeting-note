-- Inactive durable extraction foundation. No model/provider is configured here.
-- Rollback: stop both workers, disable integration, and back up private queues
-- before removing the new extraction trigger/RPCs/table. Existing source/outbox
-- migrations are preserved; this corrective migration extends their behavior.
begin;
create table if not exists meeting_knowledge.extraction_job (
  job_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, source_id text not null references meeting_knowledge.source(source_id),
  integration_generation bigint not null check(integration_generation between 1 and 9007199254740991),
  content_revision bigint not null check(content_revision between 1 and 9007199254740991),
  speaker_revision bigint not null check(speaker_revision between 1 and 9007199254740991),
  source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
  source_event jsonb, plaintext_code_units integer not null check(plaintext_code_units>0),
  status text not null default 'pending' check(status in ('pending','leased','completed','cancelled')),
  worker_id uuid, lease_token uuid, lease_until timestamptz,
  attempts integer not null default 0 check(attempts>=0),
  available_at timestamptz not null default clock_timestamp(),
  coverage jsonb, run jsonb,
  last_error_code text check(last_error_code in ('POLICY_DENIED','POLICY_UNAVAILABLE','SOURCE_STALE','CURRENT_UNAVAILABLE','CANCELLED','EXTRACTION_FAILED','INVALID_SNAPSHOT','PAYLOAD_TOO_LARGE')),
  created_at timestamptz not null default clock_timestamp(), completed_at timestamptz,
  unique(tenant_id,source_id,integration_generation,content_revision,speaker_revision,source_hash),
  check(status<>'leased' or (worker_id is not null and lease_token is not null and lease_until is not null)),
  check(status not in ('completed','cancelled') or source_event is null)
);
alter table meeting_knowledge.extraction_job enable row level security;
revoke all on meeting_knowledge.extraction_job from public,anon,authenticated;
grant select,insert,update on meeting_knowledge.extraction_job to service_role;
drop policy if exists service_only on meeting_knowledge.extraction_job;
create policy service_only on meeting_knowledge.extraction_job to service_role using(true) with check(true);
create index if not exists meeting_knowledge_extraction_claim_idx on meeting_knowledge.extraction_job(tenant_id,available_at,created_at) where status in ('pending','leased');
-- Only the previous event-type check is replaced; other lifecycle/privacy checks
-- remain intact. New empty/small queue tables do not need CONCURRENTLY indexes.
alter table meeting_knowledge.outbox drop constraint if exists outbox_event_type_check;
alter table meeting_knowledge.outbox add constraint outbox_event_type_check check(event_type in ('source.upsert','access.changed','integration.disabled','source.deleted','units.upsert'));

create or replace function meeting_knowledge.extraction_binding_current(p_source meeting_knowledge.source,p_event jsonb)
returns boolean language sql volatile security invoker set search_path='' as $$
  select coalesce(p_source.active and p_source.integration_enabled
    and p_event->>'eventType'='source.upsert' and p_event->>'sourceApp'='meeting-note'
    and p_event->>'tenantId'=p_source.tenant_id::text and p_event->>'sourceId'=p_source.source_id
    and p_event->>'integrationGeneration'=p_source.integration_generation::text
    and p_event#>>'{payload,contentRevision}'=p_source.content_revision::text
    and p_event#>>'{payload,speakerRevision}'=p_source.speaker_revision::text
    and jsonb_typeof(p_event#>'{payload,plaintext}')='string'
    and length(p_event#>>'{payload,plaintext}')>0
    and encode(sha256(convert_to(p_event#>>'{payload,plaintext}','UTF8')),'hex')=p_event#>>'{payload,sourceHash}'
    and public.meeting_knowledge_current_source(p_source.tenant_id,p_source.source_id)->>'sourceHash'=p_event#>>'{payload,sourceHash}',false);
$$;
create or replace function meeting_knowledge.extraction_source_changed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not new.active or not new.integration_enabled then
    update meeting_knowledge.extraction_job set status='cancelled',source_event=null,coverage=null,run=null,
      worker_id=null,lease_token=null,lease_until=null,last_error_code='SOURCE_STALE'
      where source_id=new.source_id and (status<>'cancelled' or coverage is not null or run is not null);
    update meeting_knowledge.outbox set status='cancelled',snapshot=null,prepared_event=null,worker_id=null,lease_token=null,lease_until=null
      where source_id=new.source_id and event_type='units.upsert' and status in ('pending','leased');
  elsif old.content_revision<>new.content_revision or old.speaker_revision<>new.speaker_revision
      or old.integration_generation<>new.integration_generation then
    update meeting_knowledge.extraction_job set status='cancelled',source_event=null,worker_id=null,lease_token=null,lease_until=null,last_error_code='SOURCE_STALE'
      where source_id=new.source_id and status in ('pending','leased') and
        (content_revision<>new.content_revision or speaker_revision<>new.speaker_revision or integration_generation<>new.integration_generation);
    update meeting_knowledge.outbox set status='cancelled',snapshot=null,prepared_event=null,worker_id=null,lease_token=null,lease_until=null
      where source_id=new.source_id and event_type='units.upsert' and status in ('pending','leased') and
        (snapshot#>>'{record,contentRevision}' is distinct from new.content_revision::text
        or snapshot#>>'{record,speakerRevision}' is distinct from new.speaker_revision::text
        or integration_generation<>new.integration_generation);
  end if;
  return new;
end $$;
drop trigger if exists meeting_knowledge_source_extraction_changed on meeting_knowledge.source;
create trigger meeting_knowledge_source_extraction_changed after update on meeting_knowledge.source
  for each row execute function meeting_knowledge.extraction_source_changed();

-- Lock order: source -> outbox -> job -> stream. ACK must not take outbox before
-- source: note/project updates already hold source before cancelling queue rows.
create or replace function public.meeting_knowledge_outbox_ack(p_event_id uuid,p_worker_id uuid,p_lease_token uuid,p_payload_hash text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare existing meeting_knowledge.outbox%rowtype; s meeting_knowledge.source%rowtype; sid text; units integer; should_enqueue boolean;
begin
  if p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='P0001',message='INVALID_OUTBOX_COMMAND'; end if;
  select source_id into sid from meeting_knowledge.outbox where event_id=p_event_id;
  if not found then return false; end if;
  select * into s from meeting_knowledge.source where source_id=sid for update;
  select * into existing from meeting_knowledge.outbox where event_id=p_event_id for update;
  if not found or existing.status<>'leased' or existing.worker_id is distinct from p_worker_id
    or existing.lease_token is distinct from p_lease_token or existing.lease_until<=clock_timestamp()
    or existing.prepared_event is null or existing.prepared_event->>'payloadHash' is distinct from p_payload_hash then return false; end if;
  should_enqueue:=existing.event_type='source.upsert' and meeting_knowledge.extraction_binding_current(s,existing.prepared_event);
  if should_enqueue then
    -- JS evidence ranges use UTF-16 code units, not PostgreSQL code points.
    select length(existing.prepared_event#>>'{payload,plaintext}')+count(*)::integer into units
      from regexp_split_to_table(existing.prepared_event#>>'{payload,plaintext}','') ch where ascii(ch)>65535;
  end if;
  update meeting_knowledge.outbox set status='delivered',snapshot=null,prepared_event=null,payload_hash=p_payload_hash,delivered_at=clock_timestamp(),
    last_error_code=null,worker_id=null,lease_token=null,lease_until=null where event_id=p_event_id and status='leased' and worker_id=p_worker_id and lease_token=p_lease_token
    and lease_until>clock_timestamp() and prepared_event->>'payloadHash'=p_payload_hash;
  if not found then return false; end if;
  if should_enqueue then
    insert into meeting_knowledge.extraction_job(tenant_id,source_id,integration_generation,content_revision,speaker_revision,source_hash,source_event,plaintext_code_units)
      values(s.tenant_id,s.source_id,s.integration_generation,s.content_revision,s.speaker_revision,
        existing.prepared_event#>>'{payload,sourceHash}',existing.prepared_event,units) on conflict do nothing;
  end if;
  return true;
end $$;

create or replace function public.meeting_knowledge_extraction_claim(p_tenant_id uuid,p_worker_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s meeting_knowledge.source%rowtype; j meeting_knowledge.extraction_job%rowtype;
begin
  if p_tenant_id is null or p_worker_id is null then raise exception using errcode='P0001',message='INVALID_EXTRACTION_COMMAND'; end if;
  select source.* into s from meeting_knowledge.source source where source.tenant_id=p_tenant_id and exists(
    select 1 from meeting_knowledge.extraction_job jobs where jobs.source_id=source.source_id and
      ((jobs.status='pending' and jobs.available_at<=clock_timestamp()) or (jobs.status='leased' and jobs.lease_until<=clock_timestamp())))
    order by source.source_id for update of source skip locked limit 1;
  if not found then return '[]'::jsonb; end if;
  select * into j from meeting_knowledge.extraction_job where source_id=s.source_id and
    ((status='pending' and available_at<=clock_timestamp()) or (status='leased' and lease_until<=clock_timestamp()))
    order by created_at,job_id for update skip locked limit 1;
  if not found then return '[]'::jsonb; end if;
  if not meeting_knowledge.extraction_binding_current(s,j.source_event) then
    update meeting_knowledge.extraction_job set status='cancelled',source_event=null,worker_id=null,lease_token=null,lease_until=null,last_error_code='SOURCE_STALE' where job_id=j.job_id;
    return '[]'::jsonb;
  end if;
  update meeting_knowledge.extraction_job set status='leased',worker_id=p_worker_id,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1
    where job_id=j.job_id returning * into j;
  return jsonb_build_array(jsonb_build_object('jobId',j.job_id::text,'tenantId',j.tenant_id::text,'sourceId',j.source_id,'integrationGeneration',j.integration_generation,
    'sourceEvent',j.source_event,'leaseToken',j.lease_token::text,'attempts',j.attempts));
end $$;
create or replace function public.meeting_knowledge_extraction_current(p_job_id uuid,p_worker_id uuid,p_lease_token uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare s meeting_knowledge.source%rowtype; j meeting_knowledge.extraction_job%rowtype; sid text;
begin
  select source_id into sid from meeting_knowledge.extraction_job where job_id=p_job_id;
  if not found then return false; end if;
  select * into s from meeting_knowledge.source where source_id=sid for update;
  select * into j from meeting_knowledge.extraction_job where job_id=p_job_id for update;
  if j.status<>'leased' or j.worker_id is distinct from p_worker_id or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then return false; end if;
  if not meeting_knowledge.extraction_binding_current(s,j.source_event) then
    update meeting_knowledge.extraction_job set status='cancelled',source_event=null,worker_id=null,lease_token=null,lease_until=null,last_error_code='SOURCE_STALE' where job_id=j.job_id;
    return false;
  end if;
  update meeting_knowledge.extraction_job set lease_until=clock_timestamp()+interval '60 seconds'
    where job_id=j.job_id and lease_until>clock_timestamp();
  return found;
end $$;

-- Metadata guards accept no arbitrary text-bearing keys. Producer additionally
-- validates the shared schema, canonical hashes, Unicode ranges and source spans.
create or replace function meeting_knowledge.extraction_shape(v jsonb,required text[],optional text[] default '{}')
returns boolean language plpgsql immutable security invoker set search_path='' as $$
begin
  if jsonb_typeof(v) is distinct from 'object' then return false; end if;
  return v ?& required and not exists(select 1 from jsonb_object_keys(v) key where not(key=any(required||optional)));
end $$;
create or replace function meeting_knowledge.extraction_integer(v jsonb,minimum bigint default 0,maximum bigint default 9007199254740991)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
begin
  if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^(0|[1-9][0-9]*)$' then return false; end if;
  return v::text::numeric between minimum and maximum;
end $$;
create or replace function meeting_knowledge.extraction_validate(j meeting_knowledge.extraction_job,p_payload jsonb,p_coverage jsonb,p_run jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare u jsonb; e jsonb; c jsonb; span jsonb; position bigint:=0; idx integer:=0; accepted bigint:=0; usage_key text;
begin
  if octet_length(p_payload::text)>1048576 or octet_length(p_coverage::text)>1048576 or octet_length(p_run::text)>8192
    or not meeting_knowledge.extraction_shape(p_payload,array['contentRevision','speakerRevision','sourceHash','extractorRun','units'])
    or p_payload->>'contentRevision' is distinct from j.content_revision::text or p_payload->>'speakerRevision' is distinct from j.speaker_revision::text
    or p_payload->>'sourceHash' is distinct from j.source_hash or jsonb_typeof(p_payload->'sourceHash') is distinct from 'string'
    or not meeting_knowledge.extraction_integer(p_payload->'contentRevision',1) or not meeting_knowledge.extraction_integer(p_payload->'speakerRevision',1)
    or not meeting_knowledge.extraction_shape(p_payload->'extractorRun',array['runId','model','promptVersion'])
    or p_payload#>>'{extractorRun,runId}' is distinct from j.job_id::text
    or exists(select 1 from unnest(array['runId','model','promptVersion']) k where jsonb_typeof(p_payload->'extractorRun'->k) is distinct from 'string')
    or jsonb_typeof(p_payload->'units') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_payload->'units')>5000 or not meeting_knowledge.extraction_shape(p_run,array['runId','model','promptVersion','inputHash','calls','usage'])
    or p_run->>'runId' is distinct from j.job_id::text
    or p_run->>'model' is distinct from p_payload#>>'{extractorRun,model}' or p_run->>'promptVersion' is distinct from p_payload#>>'{extractorRun,promptVersion}'
    or jsonb_typeof(p_run->'model') is distinct from 'string' or p_run->>'model' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    or jsonb_typeof(p_run->'promptVersion') is distinct from 'string' or p_run->>'promptVersion' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    or jsonb_typeof(p_run->'inputHash') is distinct from 'string' or p_run->>'inputHash' !~ '^[0-9a-f]{64}$'
    or not meeting_knowledge.extraction_integer(p_run->'calls',0,1000)
    or not meeting_knowledge.extraction_shape(p_run->'usage',array['inputTokens','outputTokens','totalTokens']) then return false; end if;
  foreach usage_key in array array['inputTokens','outputTokens','totalTokens'] loop
    if p_run->'usage'->usage_key<>'null'::jsonb and not meeting_knowledge.extraction_integer(p_run->'usage'->usage_key) then return false; end if;
  end loop;
  if (select count(distinct item->>'unitId') from jsonb_array_elements(p_payload->'units') item)<>jsonb_array_length(p_payload->'units') then return false; end if;
  for u in select value from jsonb_array_elements(p_payload->'units') loop
    if not meeting_knowledge.extraction_shape(u,array['unitId','text','factType','speechAct','epistemic','lifecycle','evidence'])
      or jsonb_typeof(u->'unitId') is distinct from 'string' or length(u->>'unitId') not between 1 and 256 or u->>'unitId' not like j.job_id::text||':%'
      or jsonb_typeof(u->'text') is distinct from 'string' or length(u->>'text') not between 1 and 20000
      or exists(select 1 from unnest(array['factType','speechAct','epistemic','lifecycle']) k where jsonb_typeof(u->k) is distinct from 'string')
      or u->>'factType' not in ('definition','condition','status','proposal','decision','task','outcome','open-question','unclassified')
      or u->>'speechAct' not in ('statement','proposal','request','acceptance','decision','correction','question','unclassified')
      or u->>'epistemic' not in ('reported','hypothesis','uncertain') or u->>'lifecycle' is distinct from 'candidate'
      or jsonb_typeof(u->'evidence') is distinct from 'array' then return false; end if;
    if jsonb_array_length(u->'evidence') not between 1 and 1000 then return false; end if;
    for e in select value from jsonb_array_elements(u->'evidence') loop
      if not meeting_knowledge.extraction_shape(e,array['spanId','start','end','textHash','sourceId','contentRevision','sourceHash'])
        or e->>'sourceId' is distinct from j.source_id or e->>'contentRevision' is distinct from j.content_revision::text
        or e->>'sourceHash' is distinct from j.source_hash
        or exists(select 1 from unnest(array['spanId','sourceId','textHash','sourceHash']) k where jsonb_typeof(e->k) is distinct from 'string')
        or not meeting_knowledge.extraction_integer(e->'contentRevision',1)
        or not meeting_knowledge.extraction_integer(e->'start') or not meeting_knowledge.extraction_integer(e->'end',1) then return false; end if;
      select value into span from jsonb_array_elements(j.source_event#>'{payload,spans}') where value->>'spanId'=e->>'spanId';
      if not found or e->'start' is distinct from span->'start' or e->'end' is distinct from span->'end' or e->'textHash' is distinct from span->'textHash' then return false; end if;
    end loop;
  end loop;
  if jsonb_typeof(p_coverage) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_coverage) not between 1 and 1001 then return false; end if;
  for c in select value from jsonb_array_elements(p_coverage) loop
    if not meeting_knowledge.extraction_shape(c,array['index','start','end','sourceSpanIds','processable','status','rawFallback','acceptedCandidates','rejectedCandidates'],array['errorCode'])
      or not meeting_knowledge.extraction_integer(c->'index',0,1000) or c->>'index' is distinct from idx::text
      or not meeting_knowledge.extraction_integer(c->'start',0,j.plaintext_code_units) or c->>'start' is distinct from position::text
      or not meeting_knowledge.extraction_integer(c->'end',1,j.plaintext_code_units)
      or jsonb_typeof(c->'processable') is distinct from 'boolean' or jsonb_typeof(c->'rawFallback') is distinct from 'boolean'
      or jsonb_typeof(c->'status') is distinct from 'string' or c->>'status' not in ('success','failed','skipped','cancelled')
      or not meeting_knowledge.extraction_integer(c->'acceptedCandidates',0,5000) or not meeting_knowledge.extraction_integer(c->'rejectedCandidates',0,5000)
      or jsonb_typeof(c->'sourceSpanIds') is distinct from 'array'
      or (c ? 'errorCode' and (jsonb_typeof(c->'errorCode') is distinct from 'string' or c->>'errorCode' not in ('POLICY_DENIED','POLICY_UNAVAILABLE','SOURCE_STALE','CURRENT_UNAVAILABLE','CANCELLED','TIMEOUT','MODEL_FAILED','INVALID_OUTPUT','TRUNCATED_OUTPUT','INVALID_METADATA','LIMIT_REACHED','INVALID_CANDIDATE'))) then return false; end if;
    if (c->>'end')::bigint<=position or jsonb_array_length(c->'sourceSpanIds') not between 1 and 10000 then return false; end if;
    if exists(select 1 from jsonb_array_elements(c->'sourceSpanIds') item where jsonb_typeof(item)<>'string' or not exists(
      select 1 from jsonb_array_elements(j.source_event#>'{payload,spans}') known where known->'spanId'=item)) then return false; end if;
    position:=(c->>'end')::bigint;idx:=idx+1;accepted:=accepted+(c->>'acceptedCandidates')::bigint;
  end loop;
  return position=j.plaintext_code_units and accepted=jsonb_array_length(p_payload->'units');
end $$;

create or replace function public.meeting_knowledge_extraction_complete(p_job_id uuid,p_worker_id uuid,p_lease_token uuid,p_payload jsonb,p_coverage jsonb,p_run jsonb)
returns boolean language plpgsql security invoker set search_path='' as $$
declare s meeting_knowledge.source%rowtype; j meeting_knowledge.extraction_job%rowtype; sid text; seq bigint; snap jsonb;
begin
  select source_id into sid from meeting_knowledge.extraction_job where job_id=p_job_id;
  if not found then return false; end if;
  select * into s from meeting_knowledge.source where source_id=sid for update;
  select * into j from meeting_knowledge.extraction_job where job_id=p_job_id for update;
  if j.status<>'leased' or j.worker_id is distinct from p_worker_id or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then return false; end if;
  if not meeting_knowledge.extraction_binding_current(s,j.source_event) then
    update meeting_knowledge.extraction_job set status='cancelled',source_event=null,worker_id=null,lease_token=null,lease_until=null,last_error_code='SOURCE_STALE' where job_id=j.job_id;return false;
  end if;
  if octet_length(p_payload::text)>1048576 then raise exception using errcode='P0001',message='EXTRACTION_PAYLOAD_TOO_LARGE'; end if;
  if not meeting_knowledge.extraction_validate(j,p_payload,p_coverage,p_run) then raise exception using errcode='P0001',message='INVALID_EXTRACTION_COMMAND'; end if;
  snap:=jsonb_build_object('record',jsonb_build_object('tenantId',s.tenant_id::text,'sourceId',s.source_id,'contentRevision',s.content_revision,'speakerRevision',s.speaker_revision,
    'accessRevision',s.access_revision,'integrationGeneration',s.integration_generation,'sourceHash',j.source_hash),'sourceEvent',j.source_event,'payload',p_payload);
  if octet_length(snap::text)>1048576 then raise exception using errcode='P0001',message='EXTRACTION_PAYLOAD_TOO_LARGE'; end if;
  if j.lease_until<=clock_timestamp() then return false; end if;
  insert into meeting_knowledge.stream(source_id) values(s.source_id) on conflict do nothing;
  update meeting_knowledge.stream set event_seq=event_seq+1 where source_id=s.source_id returning event_seq into seq;
  insert into meeting_knowledge.outbox(source_id,tenant_id,event_seq,integration_generation,event_type,snapshot)
    values(s.source_id,s.tenant_id,seq,s.integration_generation,'units.upsert',snap);
  update meeting_knowledge.extraction_job set status='completed',source_event=null,coverage=p_coverage,run=p_run,completed_at=clock_timestamp(),
    last_error_code=null,worker_id=null,lease_token=null,lease_until=null where job_id=j.job_id and lease_until>clock_timestamp();
  -- A lock wait while allocating the stream sequence cannot extend this lease.
  -- Raising rolls back the sequence and units packet together with completion.
  if not found then raise exception using errcode='P0001',message='EXTRACTION_LEASE_EXPIRED'; end if;
  return true;
end $$;
create or replace function public.meeting_knowledge_extraction_fail(p_job_id uuid,p_worker_id uuid,p_lease_token uuid,p_error_code text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare s meeting_knowledge.source%rowtype; j meeting_knowledge.extraction_job%rowtype; sid text;
begin
  if p_error_code is null or p_error_code not in ('POLICY_DENIED','POLICY_UNAVAILABLE','SOURCE_STALE','CURRENT_UNAVAILABLE','CANCELLED','EXTRACTION_FAILED','INVALID_SNAPSHOT','PAYLOAD_TOO_LARGE') then
    raise exception using errcode='P0001',message='INVALID_EXTRACTION_COMMAND';end if;
  select source_id into sid from meeting_knowledge.extraction_job where job_id=p_job_id;if not found then return false; end if;
  select * into s from meeting_knowledge.source where source_id=sid for update;
  select * into j from meeting_knowledge.extraction_job where job_id=p_job_id for update;
  if j.status<>'leased' or j.worker_id is distinct from p_worker_id or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then return false; end if;
  if not meeting_knowledge.extraction_binding_current(s,j.source_event) then
    update meeting_knowledge.extraction_job set status='cancelled',source_event=null,worker_id=null,lease_token=null,lease_until=null,last_error_code='SOURCE_STALE' where job_id=j.job_id;return false;
  end if;
  update meeting_knowledge.extraction_job set status='pending',last_error_code=p_error_code,
    available_at=case when p_error_code='PAYLOAD_TOO_LARGE' then 'infinity'::timestamptz
      else clock_timestamp()+make_interval(secs=>least(300,power(2,least(attempts,8))::integer)) end,worker_id=null,lease_token=null,lease_until=null
    where job_id=j.job_id and lease_until>clock_timestamp();
  return found;
end $$;
revoke all on function meeting_knowledge.extraction_binding_current(meeting_knowledge.source,jsonb),meeting_knowledge.extraction_source_changed(),
  meeting_knowledge.extraction_shape(jsonb,text[],text[]),meeting_knowledge.extraction_integer(jsonb,bigint,bigint),
  meeting_knowledge.extraction_validate(meeting_knowledge.extraction_job,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function meeting_knowledge.extraction_binding_current(meeting_knowledge.source,jsonb),
  meeting_knowledge.extraction_shape(jsonb,text[],text[]),meeting_knowledge.extraction_integer(jsonb,bigint,bigint),
  meeting_knowledge.extraction_validate(meeting_knowledge.extraction_job,jsonb,jsonb,jsonb) to service_role;
revoke all on function public.meeting_knowledge_extraction_claim(uuid,uuid),public.meeting_knowledge_extraction_current(uuid,uuid,uuid),
  public.meeting_knowledge_extraction_complete(uuid,uuid,uuid,jsonb,jsonb,jsonb),public.meeting_knowledge_extraction_fail(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.meeting_knowledge_extraction_claim(uuid,uuid),public.meeting_knowledge_extraction_current(uuid,uuid,uuid),
  public.meeting_knowledge_extraction_complete(uuid,uuid,uuid,jsonb,jsonb,jsonb),public.meeting_knowledge_extraction_fail(uuid,uuid,uuid,text) to service_role;
commit;
