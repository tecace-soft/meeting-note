-- Additive, inactive transport foundation. No source is enrolled or enabled here.
-- Rollback: stop worker + disable enrolled integrations before removing the new
-- trigger/RPCs/tables. Removing this migration while deliveries exist loses retry
-- state; take a database backup first. No hosted database is changed by this file.
begin;
create table if not exists meeting_knowledge.stream (
  source_id text primary key references meeting_knowledge.source(source_id),
  event_seq bigint not null default 0 check (event_seq between 0 and 9007199254740991)
);
create table if not exists meeting_knowledge.outbox (
  event_id uuid primary key default gen_random_uuid(),
  source_id text not null references meeting_knowledge.source(source_id),
  tenant_id uuid not null,
  event_seq bigint not null check (event_seq between 1 and 9007199254740991),
  integration_generation bigint not null check (integration_generation between 1 and 9007199254740991),
  event_type text not null check (event_type in ('source.upsert','access.changed','integration.disabled','source.deleted')),
  snapshot jsonb, prepared_event jsonb,
  status text not null default 'pending' check (status in ('pending','leased','delivered','cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default clock_timestamp(),
  worker_id uuid, lease_token uuid, lease_until timestamptz,
  payload_hash text check (payload_hash ~ '^[0-9a-f]{64}$'),
  last_error_code text check (last_error_code in ('DELIVERY_FAILED','IMPORT_REJECTED','INVALID_SNAPSHOT','PAYLOAD_TOO_LARGE','CONFIG_UNAVAILABLE')),
  created_at timestamptz not null default clock_timestamp(), delivered_at timestamptz,
  unique(source_id,event_seq),
  check (status <> 'leased' or (worker_id is not null and lease_token is not null and lease_until is not null)),
  check (status not in ('delivered','cancelled') or (snapshot is null and prepared_event is null))
);
alter table meeting_knowledge.outbox add column if not exists prepared_event jsonb;
-- New empty tables: normal indexes avoid nontransactional CONCURRENTLY machinery.
create index if not exists meeting_knowledge_outbox_claim_idx on meeting_knowledge.outbox(tenant_id,available_at,event_seq) where status in ('pending','leased');
alter table meeting_knowledge.stream enable row level security;
alter table meeting_knowledge.outbox enable row level security;
revoke all on meeting_knowledge.stream, meeting_knowledge.outbox from public,anon,authenticated;
grant select,insert,update on meeting_knowledge.stream, meeting_knowledge.outbox to service_role;
drop policy if exists service_only on meeting_knowledge.stream;
create policy service_only on meeting_knowledge.stream to service_role using(true) with check(true);
drop policy if exists service_only on meeting_knowledge.outbox;
create policy service_only on meeting_knowledge.outbox to service_role using(true) with check(true);

-- AFTER note/project/participant updates must observe the newly written rows.
-- VOLATILE SQL functions get a fresh statement snapshot for trigger execution.
alter function public.meeting_knowledge_current_source(uuid,text) volatile;
create or replace function meeting_knowledge.export_snapshot(p_tenant_id uuid,p_source_id text)
returns jsonb language sql volatile security invoker set search_path='' as $$
  select jsonb_build_object('record',public.meeting_knowledge_current_source(p_tenant_id,p_source_id),
    'plaintext',n.transcription,'title',coalesce(to_jsonb(n)->>'name',''),
    'meetingAt',to_jsonb(n)->>'meeting_at')
  from public.note n where n.id::text=p_source_id and n.transcription is not null and length(n.transcription)>0;
$$;
create or replace function meeting_knowledge.enqueue(p_source meeting_knowledge.source,p_type text,p_snapshot jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare seq bigint;
begin
  insert into meeting_knowledge.stream(source_id) values(p_source.source_id) on conflict do nothing;
  update meeting_knowledge.stream set event_seq=event_seq+1 where source_id=p_source.source_id returning event_seq into seq;
  insert into meeting_knowledge.outbox(source_id,tenant_id,event_seq,integration_generation,event_type,snapshot)
    values(p_source.source_id,p_source.tenant_id,seq,p_source.integration_generation,p_type,p_snapshot);
end $$;
create or replace function meeting_knowledge.source_outbox_changed()
returns trigger language plpgsql security definer set search_path='' as $$
declare snap jsonb; lifecycle text;
begin
  if tg_op='INSERT' and not new.integration_enabled then return new; end if;
  if tg_op='UPDATE' then
    if not old.active then return new; end if; -- Permanent tombstones never resurrect.
    if not new.active then lifecycle:='source.deleted';
    elsif old.integration_enabled and not new.integration_enabled then lifecycle:='integration.disabled'; end if;
  end if;
  if lifecycle is not null then
    -- A leased worker may already be sending; importer sequence and live checks
    -- fence that delivery. Cancellation also destroys all old retained raw text.
    update meeting_knowledge.outbox set status='cancelled',snapshot=null,prepared_event=null,worker_id=null,lease_token=null,lease_until=null
      where source_id=new.source_id and status in ('pending','leased');
    perform meeting_knowledge.enqueue(new,lifecycle,jsonb_build_object('record',jsonb_build_object(
      'tenantId',new.tenant_id::text,'sourceId',new.source_id,'contentRevision',new.content_revision,
      'speakerRevision',new.speaker_revision,'accessRevision',new.access_revision,'integrationGeneration',new.integration_generation)));
    return new;
  end if;
  if not new.active or not new.integration_enabled then return new; end if;
  snap:=meeting_knowledge.export_snapshot(new.tenant_id,new.source_id);
  if snap is null or snap->'record' is null or snap->'record'='null'::jsonb then
    raise exception using errcode='P0001',message='INVALID_EXPORT_SNAPSHOT';
  end if;
  if tg_op='INSERT' or not old.integration_enabled or old.integration_generation<>new.integration_generation then
    perform meeting_knowledge.enqueue(new,'source.upsert',snap);
    perform meeting_knowledge.enqueue(new,'access.changed',snap);
  else
    if old.content_revision<>new.content_revision or old.speaker_revision<>new.speaker_revision then
      perform meeting_knowledge.enqueue(new,'source.upsert',snap);
    end if;
    if old.access_revision<>new.access_revision then perform meeting_knowledge.enqueue(new,'access.changed',snap); end if;
  end if;
  return new;
end $$;
drop trigger if exists meeting_knowledge_source_outbox_changed on meeting_knowledge.source;
create trigger meeting_knowledge_source_outbox_changed after insert or update on meeting_knowledge.source
  for each row execute function meeting_knowledge.source_outbox_changed();

-- Add metadata invalidation and a fail-closed empty-raw transition. Existing
-- ownership tombstones and source identity are preserved exactly.
create or replace function meeting_knowledge.note_changed()
returns trigger language plpgsql security definer set search_path='' as $$
declare before_row jsonb:=to_jsonb(old); after_row jsonb; raw_changed boolean; speaker_changed boolean; access_changed boolean; unsupported boolean;
begin
  if tg_op='DELETE' then
    update meeting_knowledge.source set active=false,integration_enabled=false,access_revision=access_revision+1,updated_at=now()
      where source_id=old.id::text and active; return old;
  end if;
  after_row:=to_jsonb(new);
  if old.id::text is distinct from new.id::text or lower(old.user_id) is distinct from lower(new.user_id) then
    update meeting_knowledge.source set active=false,integration_enabled=false,access_revision=access_revision+1,updated_at=now()
      where source_id=old.id::text and active; return new;
  end if;
  raw_changed:=before_row->'transcription' is distinct from after_row->'transcription'
    or before_row->'diarization' is distinct from after_row->'diarization'
    or before_row->'name' is distinct from after_row->'name' or before_row->'meeting_at' is distinct from after_row->'meeting_at';
  speaker_changed:=before_row->'diarization' is distinct from after_row->'diarization' or before_row->'speakers' is distinct from after_row->'speakers';
  access_changed:=before_row->'shared_users' is distinct from after_row->'shared_users' or before_row->'projects' is distinct from after_row->'projects';
  unsupported:=new.transcription is null or length(new.transcription)=0;
  update meeting_knowledge.source set content_revision=content_revision+case when raw_changed then 1 else 0 end,
    speaker_revision=speaker_revision+case when speaker_changed then 1 else 0 end,
    access_revision=access_revision+case when access_changed or (unsupported and integration_enabled) then 1 else 0 end,
    integration_enabled=integration_enabled and not unsupported,updated_at=now()
    where source_id=old.id::text and active and (raw_changed or speaker_changed or access_changed or (unsupported and integration_enabled));
  return new;
end $$;

create or replace function public.meeting_knowledge_mutate(
  p_tenant_id uuid, p_source_id text, p_owner_object_id uuid, p_expected_access_revision bigint,
  p_action text, p_subject_object_id uuid default null, p_verification_ref text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare existing meeting_knowledge.source%rowtype; changed boolean := false;
begin
  if p_tenant_id is null or p_owner_object_id is null or p_source_id is null or length(p_source_id) not between 1 and 256
    or p_expected_access_revision is null or p_expected_access_revision not between 1 and 9007199254740991
    or p_action is null or p_action not in ('confirm_participant','revoke','restore','enable','disable')
    or (p_action in ('confirm_participant','revoke','restore') and p_subject_object_id is null)
    or (p_action in ('enable','disable') and (p_subject_object_id is not null or p_verification_ref is not null))
    or (p_action in ('revoke','restore') and p_verification_ref is not null)
    or (p_action = 'confirm_participant' and (p_verification_ref is null or length(p_verification_ref) not between 1 and 512)) then
    raise exception using errcode = 'P0001', message = 'INVALID_LEDGER_COMMAND';
  end if;
  perform 1 from public.note n where n.id::text = p_source_id and lower(n.user_id) = p_owner_object_id::text
    and (p_action = 'disable' or (n.transcription is not null and length(n.transcription) > 0)) for share;
  if not found then raise exception using errcode = 'P0001', message = 'SOURCE_UNAVAILABLE'; end if;
  select * into existing from meeting_knowledge.source where source_id = p_source_id for update;
  if not found or not existing.active or existing.tenant_id <> p_tenant_id or existing.owner_object_id <> p_owner_object_id then
    raise exception using errcode = 'P0001', message = 'SOURCE_UNAVAILABLE';
  end if;
  if existing.access_revision <> p_expected_access_revision then
    raise exception using errcode = 'P0001', message = 'ACCESS_REVISION_CONFLICT';
  end if;
  if p_action = 'confirm_participant' then
    insert into meeting_knowledge.participant(source_id,object_id,confirmed_by,verification_ref)
      values(p_source_id,p_subject_object_id,p_owner_object_id,p_verification_ref)
      on conflict(source_id,object_id) do update set confirmed_by = excluded.confirmed_by,
        verification_ref = excluded.verification_ref, confirmed_at = now()
      where meeting_knowledge.participant.confirmed_by is distinct from excluded.confirmed_by
        or meeting_knowledge.participant.verification_ref is distinct from excluded.verification_ref;
    changed := found; -- Confirmation never clears an explicit denial.
  elsif p_action = 'revoke' then
    insert into meeting_knowledge.denial(source_id,object_id) values(p_source_id,p_subject_object_id)
      on conflict(source_id,object_id) do update set active = true, updated_at = now()
      where not meeting_knowledge.denial.active;
    changed := found;
  elsif p_action = 'restore' then
    update meeting_knowledge.denial set active = false, updated_at = now()
      where source_id = p_source_id and object_id = p_subject_object_id and active;
    changed := found; -- Restore removes a deny; it does not create attendance/shares.
  elsif p_action = 'enable' then changed := not existing.integration_enabled;
  elsif p_action = 'disable' then changed := existing.integration_enabled;
  end if;
  if changed then
    update meeting_knowledge.source set access_revision = access_revision + 1,
      integration_enabled = case p_action when 'enable' then true when 'disable' then false else integration_enabled end,
      integration_generation = integration_generation + case when p_action = 'enable' then 1 else 0 end,
      updated_at = now() where source_id = p_source_id returning * into existing;
    insert into meeting_knowledge.access_event(source_id,tenant_id,actor_object_id,action,subject_object_id,verification_ref,access_revision)
      values(p_source_id,p_tenant_id,p_owner_object_id,p_action,p_subject_object_id,p_verification_ref,existing.access_revision);
  end if;
  return coalesce(public.meeting_knowledge_current_source(p_tenant_id,p_source_id),
    jsonb_build_object('sourceId',existing.source_id,'accessRevision',existing.access_revision,
      'integrationGeneration',existing.integration_generation,'integrationEnabled',existing.integration_enabled));
end;
$$;

create or replace function public.meeting_knowledge_owner_status(p_tenant_id uuid,p_source_id text,p_owner_object_id uuid)
returns jsonb language sql volatile security invoker set search_path='' as $$
  select jsonb_build_object('sourceId',n.id::text,'enrolled',s.source_id is not null,
    'unsupportedTranscript',n.transcription is null or length(n.transcription)=0,
    'integrationEnabled',coalesce(s.integration_enabled,false) and coalesce(s.active,false),
    'accessRevision',s.access_revision,'integrationGeneration',s.integration_generation,
    'participants',coalesce((select jsonb_agg(object_id::text order by object_id) from meeting_knowledge.participant where source_id=s.source_id),'[]'::jsonb),
    'denies',coalesce((select jsonb_agg(object_id::text order by object_id) from meeting_knowledge.denial where source_id=s.source_id and active),'[]'::jsonb),
    'directShares',coalesce((select jsonb_agg(member order by member) from (select distinct member from unnest(n.shared_users) member
      where member ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') valid),'[]'::jsonb),
    'projectShares',coalesce((select jsonb_agg(member order by member) from (select distinct member from public.project p cross join lateral unnest(p.shared_users) member
      where lower(p.user_id)=p_owner_object_id::text and exists(select 1 from unnest(n.projects) id where id::text=p.id::text)
      and member ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') valid),'[]'::jsonb),
    'delivery',jsonb_build_object('pending',(select count(*) from meeting_knowledge.outbox where source_id=s.source_id and status in ('pending','leased')),
      'lastDeliveredAt',(select max(delivered_at) from meeting_knowledge.outbox where source_id=s.source_id and status='delivered'),
      'lastErrorCode',(select last_error_code from meeting_knowledge.outbox where source_id=s.source_id
        and status in ('pending','leased') and last_error_code is not null order by event_seq desc limit 1)))
  from public.note n left join meeting_knowledge.source s on s.source_id=n.id::text
  where n.id::text=p_source_id and lower(n.user_id)=p_owner_object_id::text
    and p_tenant_id is not null and p_owner_object_id is not null
    and (s.source_id is null or (s.tenant_id=p_tenant_id and s.owner_object_id=p_owner_object_id));
$$;

create or replace function public.meeting_knowledge_outbox_claim(p_tenant_id uuid,p_worker_id uuid,p_limit integer default 10,p_lease_seconds integer default 60)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_tenant_id is null or p_worker_id is null or p_limit is null or p_limit not between 1 and 10
    or p_lease_seconds is null or p_lease_seconds not between 1 and 60 then raise exception using errcode='P0001',message='INVALID_OUTBOX_COMMAND'; end if;
  with candidates as (
    select event_id from meeting_knowledge.outbox where tenant_id=p_tenant_id and
      ((status='pending' and available_at<=clock_timestamp()) or (status='leased' and lease_until<=clock_timestamp()))
    order by case when event_type in ('source.deleted','integration.disabled') then 0 else 1 end,event_seq
    for update skip locked limit p_limit
  ), claimed as (
    update meeting_knowledge.outbox o set status='leased',worker_id=p_worker_id,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempts=attempts+1
    from candidates c where o.event_id=c.event_id returning o.*
  ) select coalesce(jsonb_agg(jsonb_build_object('eventId',event_id::text,'eventSeq',event_seq,'sourceId',source_id,'tenantId',tenant_id::text,
    'integrationGeneration',integration_generation,'eventType',event_type,'snapshot',snapshot,'leaseToken',lease_token::text,'attempts',attempts)
    order by case when event_type in ('source.deleted','integration.disabled') then 0 else 1 end,event_seq),'[]'::jsonb) into result from claimed;
  return result;
end $$;
-- Seal transport metadata once per immutable event. Claim deliberately does not
-- expose the saved envelope; prepare returns it under the current lease. Producer
-- validates the complete schema and canonical payload hash before first sealing.
create or replace function public.meeting_knowledge_outbox_prepare(p_event_id uuid,p_worker_id uuid,p_lease_token uuid,p_event jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare existing meeting_knowledge.outbox%rowtype;
begin
  select * into existing from meeting_knowledge.outbox where event_id=p_event_id and status='leased'
    and worker_id=p_worker_id and lease_token=p_lease_token and lease_until>clock_timestamp() for update;
  if not found or existing.lease_until<=clock_timestamp() then return null; end if;
  if existing.prepared_event is not null then return existing.prepared_event; end if;
  if p_event is null or jsonb_typeof(p_event)<>'object' then
    raise exception using errcode='P0001',message='INVALID_OUTBOX_COMMAND'; end if;
  if octet_length(p_event::text)>1048576 or (select count(*) from jsonb_object_keys(p_event))<>10
    or exists(select 1 from jsonb_object_keys(p_event) key where key not in
      ('schemaVersion','eventId','eventSeq','integrationGeneration','sourceApp','sourceId','tenantId','payloadHash','eventType','payload'))
    or p_event->'schemaVersion' is distinct from '1'::jsonb or p_event->>'sourceApp' is distinct from 'meeting-note'
    or exists(select 1 from unnest(array['eventId','sourceApp','sourceId','tenantId','eventType']) key
      where jsonb_typeof(p_event->key) is distinct from 'string')
    or jsonb_typeof(p_event->'payload') is distinct from 'object'
    or jsonb_typeof(p_event->'payloadHash') is distinct from 'string' or p_event->>'payloadHash' !~ '^[0-9a-f]{64}$'
    or p_event->>'eventId' is distinct from existing.event_id::text
    or p_event->>'eventType' is distinct from existing.event_type
    or p_event->>'sourceId' is distinct from existing.source_id
    or p_event->>'tenantId' is distinct from existing.tenant_id::text
    or jsonb_typeof(p_event->'eventSeq') is distinct from 'number' or p_event->>'eventSeq' is distinct from existing.event_seq::text
    or jsonb_typeof(p_event->'integrationGeneration') is distinct from 'number'
    or p_event->>'integrationGeneration' is distinct from existing.integration_generation::text then
    raise exception using errcode='P0001',message='INVALID_OUTBOX_COMMAND';
  end if;
  -- Recheck expiry after validation: lock waits cannot extend the old lease.
  update meeting_knowledge.outbox set prepared_event=p_event where event_id=existing.event_id and lease_until>clock_timestamp();
  if not found then return null; end if;
  return p_event;
end $$;
create or replace function public.meeting_knowledge_outbox_ack(p_event_id uuid,p_worker_id uuid,p_lease_token uuid,p_payload_hash text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare existing meeting_knowledge.outbox%rowtype;
begin
  if p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='P0001',message='INVALID_OUTBOX_COMMAND'; end if;
  select * into existing from meeting_knowledge.outbox where event_id=p_event_id for update;
  if not found or existing.status<>'leased' or existing.worker_id is distinct from p_worker_id
    or existing.lease_token is distinct from p_lease_token or existing.lease_until<=clock_timestamp() then return false; end if;
  update meeting_knowledge.outbox set status='delivered',snapshot=null,prepared_event=null,payload_hash=p_payload_hash,delivered_at=clock_timestamp(),
    last_error_code=null,worker_id=null,lease_token=null,lease_until=null
    where event_id=p_event_id and status='leased' and worker_id=p_worker_id and lease_token=p_lease_token and lease_until>clock_timestamp()
      and prepared_event is not null and prepared_event->>'payloadHash'=p_payload_hash;
  return found;
end $$;
create or replace function public.meeting_knowledge_outbox_fail(p_event_id uuid,p_worker_id uuid,p_lease_token uuid,p_error_code text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare existing meeting_knowledge.outbox%rowtype;
begin
  if p_error_code is null or p_error_code not in ('DELIVERY_FAILED','IMPORT_REJECTED','INVALID_SNAPSHOT','PAYLOAD_TOO_LARGE','CONFIG_UNAVAILABLE') then
    raise exception using errcode='P0001',message='INVALID_OUTBOX_COMMAND'; end if;
  select * into existing from meeting_knowledge.outbox where event_id=p_event_id for update;
  if not found or existing.status<>'leased' or existing.worker_id is distinct from p_worker_id
    or existing.lease_token is distinct from p_lease_token or existing.lease_until<=clock_timestamp() then return false; end if;
  update meeting_knowledge.outbox set status='pending',last_error_code=p_error_code,
    available_at=clock_timestamp()+make_interval(secs=>least(300,power(2,least(attempts,8))::integer)),worker_id=null,lease_token=null,lease_until=null
    where event_id=p_event_id and status='leased' and worker_id=p_worker_id and lease_token=p_lease_token and lease_until>clock_timestamp();
  return found;
end $$;
revoke all on all functions in schema meeting_knowledge from public,anon,authenticated,service_role;
revoke all on function public.meeting_knowledge_owner_status(uuid,text,uuid),
  public.meeting_knowledge_outbox_claim(uuid,uuid,integer,integer),public.meeting_knowledge_outbox_prepare(uuid,uuid,uuid,jsonb),public.meeting_knowledge_outbox_ack(uuid,uuid,uuid,text),
  public.meeting_knowledge_outbox_fail(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.meeting_knowledge_owner_status(uuid,text,uuid),
  public.meeting_knowledge_outbox_claim(uuid,uuid,integer,integer),public.meeting_knowledge_outbox_prepare(uuid,uuid,uuid,jsonb),public.meeting_knowledge_outbox_ack(uuid,uuid,uuid,text),
  public.meeting_knowledge_outbox_fail(uuid,uuid,uuid,text) to service_role;
commit;
