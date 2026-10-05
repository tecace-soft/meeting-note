begin;
alter table meeting_knowledge.extraction_job add column if not exists provider_attempts integer not null default 0;
alter table meeting_knowledge.extraction_job add column if not exists provider_lease_token uuid;
-- Metadata survives ACK plaintext purge so recovery does not duplicate current
-- envelopes or rerun models. Historical ACK rows with no metadata are repaired
-- once by an explicit owner resync; no production backfill runs on installation.
alter table meeting_knowledge.outbox add column if not exists content_revision bigint;
alter table meeting_knowledge.outbox add column if not exists speaker_revision bigint;
alter table meeting_knowledge.outbox add column if not exists access_revision bigint;
alter table meeting_knowledge.outbox add column if not exists source_hash text;
create or replace function meeting_knowledge.outbox_binding_metadata() returns trigger
language plpgsql security invoker set search_path='' as $$
declare record jsonb;
begin
  record:=coalesce(new.snapshot->'record',case when tg_op='UPDATE' then old.snapshot->'record' end);
  if record is not null then
    new.content_revision:=(record->>'contentRevision')::bigint;
    new.speaker_revision:=(record->>'speakerRevision')::bigint;
    new.access_revision:=(record->>'accessRevision')::bigint;
    new.source_hash:=record->>'sourceHash';
  end if;
  return new;
end $$;
drop trigger if exists meeting_knowledge_outbox_binding_metadata on meeting_knowledge.outbox;
create trigger meeting_knowledge_outbox_binding_metadata before insert or update on meeting_knowledge.outbox
  for each row execute function meeting_knowledge.outbox_binding_metadata();
update meeting_knowledge.outbox set snapshot=snapshot where snapshot is not null;
create table if not exists meeting_knowledge.owner_recovery (
  source_id text primary key references meeting_knowledge.source(source_id), last_requested_at timestamptz not null
);
alter table meeting_knowledge.owner_recovery enable row level security;
revoke all on meeting_knowledge.owner_recovery from public,anon,authenticated;
grant select,insert,update on meeting_knowledge.owner_recovery to service_role;
drop policy if exists service_only on meeting_knowledge.owner_recovery;
create policy service_only on meeting_knowledge.owner_recovery to service_role using(true) with check(true);
create or replace function meeting_knowledge.owner_base_status(p_tenant_id uuid,p_source_id text,p_owner_object_id uuid)
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
create or replace function public.meeting_knowledge_owner_status(p_tenant_id uuid,p_source_id text,p_owner_object_id uuid)
returns jsonb language sql volatile security invoker set search_path='' as $$
  select meeting_knowledge.owner_base_status(p_tenant_id,p_source_id,p_owner_object_id) || jsonb_build_object('processing',jsonb_build_object(
    'binding',case when r.record is null then null else jsonb_build_object('tenantId',p_tenant_id::text,'sourceId',p_source_id,
      'contentRevision',s.content_revision,'speakerRevision',s.speaker_revision,'accessRevision',s.access_revision,
      'integrationGeneration',s.integration_generation,'sourceHash',r.record->>'sourceHash') end,
    'sourceBytes',coalesce(octet_length(n.transcription),0),'encodedSourceBytes',coalesce(octet_length(to_jsonb(n.transcription)::text),0),
    'sourceLimitBytes',900000,'sizing',case when n.transcription is null or length(n.transcription)=0 then 'unsupported'
      when octet_length(to_jsonb(n.transcription)::text)>900000 then 'oversized' else 'ready' end,
    'deliveryState',case when o.last_error_code in ('PAYLOAD_TOO_LARGE','INVALID_SNAPSHOT','CONFIG_UNAVAILABLE') then 'blocked'
      when o.status='leased' then 'running' when o.status='pending' and o.last_error_code is not null then 'retrying'
      when o.status='pending' then 'queued' when o.status='delivered' then 'delivered' else 'idle' end,
    'extractionState',case when j.status='completed' and exists(select 1 from jsonb_array_elements(j.coverage) c where c->>'status'<>'success') then 'partial'
      when j.status='completed' then 'completed' when j.status='cancelled' then 'cancelled'
      when j.status='leased' then 'running' when j.status='pending' and not isfinite(j.available_at) then 'blocked'
      when j.status='pending' then 'queued' else 'not-started' end,
    'extractionErrorCode',j.last_error_code,
    'successfulChunks',(select count(*) from jsonb_array_elements(j.coverage) c where c->>'status'='success'),
    'failedChunks',(select count(*) from jsonb_array_elements(j.coverage) c where c->>'status'='failed'),
    'skippedChunks',(select count(*) from jsonb_array_elements(j.coverage) c where c->>'status'='skipped'),
    'canResync',coalesce(s.active and s.integration_enabled and r.record is not null
      and octet_length(to_jsonb(n.transcription)::text)<=900000
      and (recovery.last_requested_at is null or recovery.last_requested_at<=clock_timestamp()-interval '60 seconds'),false)))
  from public.note n left join meeting_knowledge.source s on s.source_id=n.id::text
  left join lateral (select public.meeting_knowledge_current_source(p_tenant_id,p_source_id) record) r on true
  left join lateral (select * from meeting_knowledge.outbox where source_id=s.source_id
    and integration_generation=s.integration_generation and status<>'cancelled'
    and (event_type='access.changed' and access_revision=s.access_revision
      or event_type in ('source.upsert','units.upsert') and content_revision=s.content_revision and speaker_revision=s.speaker_revision)
    order by case when status in ('pending','leased') then 0 else 1 end,event_seq desc limit 1) o on true
  left join meeting_knowledge.extraction_job j on j.source_id=s.source_id and j.tenant_id=s.tenant_id
    and j.integration_generation=s.integration_generation and j.content_revision=s.content_revision
    and j.speaker_revision=s.speaker_revision and j.source_hash=r.record->>'sourceHash'
  left join meeting_knowledge.owner_recovery recovery on recovery.source_id=s.source_id
  where n.id::text=p_source_id and lower(n.user_id)=p_owner_object_id::text
    and p_tenant_id is not null and p_owner_object_id is not null
    and (s.source_id is null or s.tenant_id=p_tenant_id and s.owner_object_id=p_owner_object_id);
$$;
create or replace function public.meeting_knowledge_owner_resync(p_tenant_id uuid,p_source_id text,p_owner_object_id uuid,
 p_content_revision bigint,p_speaker_revision bigint,p_access_revision bigint,p_integration_generation bigint,p_source_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s meeting_knowledge.source%rowtype; snap jsonb; last_requested timestamptz; seq bigint;
begin
  perform 1 from public.note n where n.id::text=p_source_id and lower(n.user_id)=p_owner_object_id::text for share;
  if not found then raise exception using errcode='P0001',message='SOURCE_UNAVAILABLE'; end if;
  select * into s from meeting_knowledge.source where source_id=p_source_id for update;
  if not found or s.tenant_id is distinct from p_tenant_id or s.owner_object_id is distinct from p_owner_object_id
    or not s.active or not s.integration_enabled then raise exception using errcode='P0001',message='SOURCE_UNAVAILABLE'; end if;
  select jsonb_build_object('record',public.meeting_knowledge_current_source(p_tenant_id,p_source_id),
    'plaintext',n.transcription,'title',coalesce(to_jsonb(n)->>'name',''),'meetingAt',to_jsonb(n)->>'meeting_at') into snap
    from public.note n where n.id::text=p_source_id;
  if snap->'record' is null or snap->'record'='null'::jsonb then raise exception using errcode='P0001',message='SOURCE_UNAVAILABLE'; end if;
  if s.content_revision is distinct from p_content_revision or s.speaker_revision is distinct from p_speaker_revision
    or s.access_revision is distinct from p_access_revision or s.integration_generation is distinct from p_integration_generation
    or snap#>>'{record,sourceHash}' is distinct from p_source_hash then raise exception using errcode='P0001',message='ACCESS_REVISION_CONFLICT'; end if;
  if octet_length(to_jsonb(snap->>'plaintext')::text)>900000 then raise exception using errcode='P0001',message='SOURCE_TOO_LARGE'; end if;
  select last_requested_at into last_requested from meeting_knowledge.owner_recovery where source_id=p_source_id;
  if last_requested is null or last_requested<=clock_timestamp()-interval '60 seconds' then
    -- Pending transient deliveries may retry, but active leases and permanent
    -- payload/invalid-snapshot holds remain intact. Extraction jobs are untouched.
    update meeting_knowledge.outbox set available_at=clock_timestamp()
      where source_id=p_source_id and integration_generation=s.integration_generation and status='pending'
      and last_error_code in ('DELIVERY_FAILED','IMPORT_REJECTED','CONFIG_UNAVAILABLE')
      and (event_type='access.changed' and access_revision=s.access_revision
        or event_type in ('source.upsert','units.upsert') and content_revision=s.content_revision and speaker_revision=s.speaker_revision)
      and last_error_code<>'PAYLOAD_TOO_LARGE';
    if not exists(select 1 from meeting_knowledge.outbox where source_id=p_source_id and integration_generation=s.integration_generation
      and event_type='source.upsert' and content_revision=s.content_revision and speaker_revision=s.speaker_revision
      and source_hash=p_source_hash and status<>'cancelled') then
      insert into meeting_knowledge.stream(source_id) values(s.source_id) on conflict do nothing;
      update meeting_knowledge.stream set event_seq=event_seq+1 where source_id=s.source_id returning event_seq into seq;
      insert into meeting_knowledge.outbox(source_id,tenant_id,event_seq,integration_generation,event_type,snapshot) values(s.source_id,s.tenant_id,seq,s.integration_generation,'source.upsert',snap);
    end if;
    if not exists(select 1 from meeting_knowledge.outbox where source_id=p_source_id and integration_generation=s.integration_generation
      and event_type='access.changed' and access_revision=s.access_revision and status<>'cancelled') then
      insert into meeting_knowledge.stream(source_id) values(s.source_id) on conflict do nothing;
      update meeting_knowledge.stream set event_seq=event_seq+1 where source_id=s.source_id returning event_seq into seq;
      insert into meeting_knowledge.outbox(source_id,tenant_id,event_seq,integration_generation,event_type,snapshot) values(s.source_id,s.tenant_id,seq,s.integration_generation,'access.changed',snap);
    end if;
    insert into meeting_knowledge.owner_recovery values(p_source_id,clock_timestamp()) on conflict(source_id)
      do update set last_requested_at=excluded.last_requested_at;
  end if;
  return jsonb_build_object('sourceId',s.source_id,'accessRevision',s.access_revision,'integrationGeneration',s.integration_generation,'integrationEnabled',true);
end $$;
-- Permanently unprocessable packets do not enter an infinite delivery loop.
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
    available_at=case when p_error_code in ('PAYLOAD_TOO_LARGE','INVALID_SNAPSHOT') then 'infinity'::timestamptz
      else clock_timestamp()+make_interval(secs=>least(300,power(2,least(attempts,8))::integer)) end,
    worker_id=null,lease_token=null,lease_until=null
    where event_id=p_event_id and status='leased' and worker_id=p_worker_id and lease_token=p_lease_token and lease_until>clock_timestamp();
  return found;
end $$;
revoke all on function meeting_knowledge.owner_base_status(uuid,text,uuid),meeting_knowledge.outbox_binding_metadata()
  from public,anon,authenticated;
grant execute on function meeting_knowledge.owner_base_status(uuid,text,uuid),meeting_knowledge.outbox_binding_metadata() to service_role;
revoke all on function public.meeting_knowledge_owner_resync(uuid,text,uuid,bigint,bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.meeting_knowledge_owner_resync(uuid,text,uuid,bigint,bigint,bigint,bigint,text) to service_role;
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
    available_at=case when p_error_code='PAYLOAD_TOO_LARGE' or j.provider_attempts>=3 then 'infinity'::timestamptz
      else clock_timestamp()+make_interval(secs=>least(300,power(2,least(attempts,8))::integer)) end,worker_id=null,lease_token=null,lease_until=null
    where job_id=j.job_id and lease_until>clock_timestamp();
  return found;
end $$;
create or replace function public.meeting_knowledge_extraction_begin_provider(p_job_id uuid,p_worker_id uuid,p_lease_token uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare j meeting_knowledge.extraction_job%rowtype;
begin
  if not public.meeting_knowledge_extraction_current(p_job_id,p_worker_id,p_lease_token) then return false; end if;
  select * into j from meeting_knowledge.extraction_job where job_id=p_job_id for update;
  if j.provider_lease_token=p_lease_token then return true; end if;
  if j.provider_attempts>=3 then
    update meeting_knowledge.extraction_job set status='pending',available_at='infinity'::timestamptz,
      last_error_code='EXTRACTION_FAILED',worker_id=null,lease_token=null,lease_until=null where job_id=p_job_id;
    return false;
  end if;
  update meeting_knowledge.extraction_job set provider_attempts=provider_attempts+1,provider_lease_token=p_lease_token where job_id=p_job_id;
  return true;
end $$;
revoke all on function public.meeting_knowledge_extraction_begin_provider(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.meeting_knowledge_extraction_begin_provider(uuid,uuid,uuid) to service_role;
-- Exact binary comparison avoids the default locale's quadratic JSONB scalar
-- string comparison for large escaped/control-character transcripts on PG17.
-- Canonical JSONB text retains object-key equivalence. A different numeric
-- rendering may conservatively invalidate a binding; no changed byte is ignored.
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
  raw_changed:=(old.transcription collate pg_catalog."C") is distinct from (new.transcription collate pg_catalog."C")
    or ((before_row->'diarization')::text collate pg_catalog."C") is distinct from ((after_row->'diarization')::text collate pg_catalog."C")
    or ((before_row->'name')::text collate pg_catalog."C") is distinct from ((after_row->'name')::text collate pg_catalog."C") or ((before_row->'meeting_at')::text collate pg_catalog."C") is distinct from ((after_row->'meeting_at')::text collate pg_catalog."C");
  speaker_changed:=((before_row->'diarization')::text collate pg_catalog."C") is distinct from ((after_row->'diarization')::text collate pg_catalog."C") or ((before_row->'speakers')::text collate pg_catalog."C") is distinct from ((after_row->'speakers')::text collate pg_catalog."C");
  access_changed:=((before_row->'shared_users')::text collate pg_catalog."C") is distinct from ((after_row->'shared_users')::text collate pg_catalog."C") or ((before_row->'projects')::text collate pg_catalog."C") is distinct from ((after_row->'projects')::text collate pg_catalog."C");
  unsupported:=new.transcription is null or length(new.transcription)=0;
  update meeting_knowledge.source set content_revision=content_revision+case when raw_changed then 1 else 0 end,
    speaker_revision=speaker_revision+case when speaker_changed then 1 else 0 end,
    access_revision=access_revision+case when access_changed or (unsupported and integration_enabled) then 1 else 0 end,
    integration_enabled=integration_enabled and not unsupported,updated_at=now()
    where source_id=old.id::text and active and (raw_changed or speaker_changed or access_changed or (unsupported and integration_enabled));
  return new;
end $$;
commit;
