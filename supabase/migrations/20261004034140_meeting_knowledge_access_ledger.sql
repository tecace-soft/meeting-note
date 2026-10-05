-- Inactive foundation: enrolling a verified owner does NOT enable integration.
-- The HTTP server verifies the signed tenant/object ID before service-role RPCs.
-- No transcript, summary, title, name or email is copied into this ledger.
begin;

create schema if not exists meeting_knowledge;
revoke all on schema meeting_knowledge from public, anon, authenticated;
grant usage on schema meeting_knowledge to service_role;

create table if not exists meeting_knowledge.source (
  source_id text primary key check (length(source_id) between 1 and 256),
  tenant_id uuid not null,
  owner_object_id uuid not null,
  active boolean not null default true,
  integration_enabled boolean not null default false,
  content_revision bigint not null default 1 check (content_revision between 1 and 9007199254740991),
  speaker_revision bigint not null default 1 check (speaker_revision between 1 and 9007199254740991),
  access_revision bigint not null default 1 check (access_revision between 1 and 9007199254740991),
  integration_generation bigint not null default 1 check (integration_generation between 1 and 9007199254740991),
  enrolled_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists meeting_knowledge_source_owner_idx
  on meeting_knowledge.source (owner_object_id) where active;

create table if not exists meeting_knowledge.participant (
  source_id text not null references meeting_knowledge.source(source_id),
  object_id uuid not null,
  confirmed_by uuid not null,
  verification_ref text not null check (length(verification_ref) between 1 and 512),
  confirmed_at timestamptz not null default now(),
  primary key (source_id, object_id)
);
create table if not exists meeting_knowledge.denial (
  source_id text not null references meeting_knowledge.source(source_id),
  object_id uuid not null,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (source_id, object_id)
);
create table if not exists meeting_knowledge.access_event (
  id bigint generated always as identity primary key,
  source_id text not null references meeting_knowledge.source(source_id),
  tenant_id uuid not null,
  actor_object_id uuid not null,
  action text not null check (action in ('initialize','confirm_participant','revoke','restore','enable','disable')),
  subject_object_id uuid,
  verification_ref text,
  access_revision bigint not null,
  created_at timestamptz not null default now()
);

alter table meeting_knowledge.source enable row level security;
alter table meeting_knowledge.participant enable row level security;
alter table meeting_knowledge.denial enable row level security;
alter table meeting_knowledge.access_event enable row level security;
revoke all on all tables in schema meeting_knowledge from public, anon, authenticated;
revoke all on all sequences in schema meeting_knowledge from public, anon, authenticated;
grant select, insert, update on meeting_knowledge.source, meeting_knowledge.participant, meeting_knowledge.denial to service_role;
grant select, insert on meeting_knowledge.access_event to service_role;
grant usage, select on all sequences in schema meeting_knowledge to service_role;
-- Explicit policy remains valid even if service_role does not have BYPASSRLS.
drop policy if exists service_only on meeting_knowledge.source;
create policy service_only on meeting_knowledge.source to service_role using (true) with check (true);
drop policy if exists service_only on meeting_knowledge.participant;
create policy service_only on meeting_knowledge.participant to service_role using (true) with check (true);
drop policy if exists service_only on meeting_knowledge.denial;
create policy service_only on meeting_knowledge.denial to service_role using (true) with check (true);
drop policy if exists service_only on meeting_knowledge.access_event;
create policy service_only on meeting_knowledge.access_event to service_role using (true) with check (true);

-- One SQL statement gives the loader a consistent MVCC snapshot of all authority.
create or replace function public.meeting_knowledge_current_source(p_tenant_id uuid, p_source_id text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'tenantId', s.tenant_id::text, 'sourceId', s.source_id,
    'contentRevision', s.content_revision, 'speakerRevision', s.speaker_revision,
    'accessRevision', s.access_revision, 'integrationGeneration', s.integration_generation,
    'sourceHash', encode(sha256(convert_to(n.transcription, 'UTF8')), 'hex'),
    'owner', jsonb_build_object('tenantId', s.tenant_id::text, 'objectId', s.owner_object_id::text),
    'ownerIdentityVerified', true, 'active', s.active, 'integrationEnabled', s.integration_enabled,
    'confirmedParticipants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'identity', jsonb_build_object('tenantId', s.tenant_id::text, 'objectId', a.object_id::text),
        'confirmedBy', jsonb_build_object('tenantId', s.tenant_id::text, 'objectId', a.confirmed_by::text),
        'verificationRef', a.verification_ref) order by a.object_id)
      from meeting_knowledge.participant a where a.source_id = s.source_id), '[]'::jsonb),
    'denies', coalesce((select jsonb_agg(jsonb_build_object('tenantId', s.tenant_id::text, 'objectId', d.object_id::text) order by d.object_id)
      from meeting_knowledge.denial d where d.source_id = s.source_id and d.active), '[]'::jsonb),
    'directShares', coalesce((select jsonb_agg(jsonb_build_object('tenantId', s.tenant_id::text, 'objectId', member) order by member)
      from (select distinct member from unnest(n.shared_users) member
        where member ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') valid), '[]'::jsonb),
    'noteProjectIds', coalesce((select jsonb_agg(id::text order by id::text) from unnest(n.projects) id), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(jsonb_build_object(
      'projectId', p.id::text,
      'owner', jsonb_build_object('tenantId', s.tenant_id::text, 'objectId', s.owner_object_id::text),
      'sharedWith', coalesce((select jsonb_agg(jsonb_build_object('tenantId', s.tenant_id::text, 'objectId', member) order by member)
        from (select distinct member from unnest(p.shared_users) member
          where member ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') valid), '[]'::jsonb)
      ) order by p.id::text)
      from public.project p
      where lower(p.user_id) = s.owner_object_id::text
        and exists (select 1 from unnest(n.projects) id where id::text = p.id::text)), '[]'::jsonb)
  )
  from meeting_knowledge.source s join public.note n on n.id::text = s.source_id
  where s.tenant_id = p_tenant_id and s.source_id = p_source_id and s.active
    and lower(n.user_id) = s.owner_object_id::text
    -- Whitespace is part of the exact hash; never trim or replace the transcript.
    and n.transcription is not null and length(n.transcription) > 0;
$$;

create or replace function public.meeting_knowledge_initialize(
  p_tenant_id uuid, p_source_id text, p_owner_object_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare existing meeting_knowledge.source%rowtype; inserted boolean := false;
begin
  if p_tenant_id is null or p_owner_object_id is null or p_source_id is null or length(p_source_id) not between 1 and 256 then
    raise exception using errcode = 'P0001', message = 'INVALID_LEDGER_COMMAND';
  end if;
  -- Note-before-ledger lock order agrees with the AFTER note trigger.
  perform 1 from public.note n where n.id::text = p_source_id
    and lower(n.user_id) = p_owner_object_id::text and n.transcription is not null and length(n.transcription) > 0 for share;
  if not found then raise exception using errcode = 'P0001', message = 'SOURCE_UNAVAILABLE'; end if;
  insert into meeting_knowledge.source(source_id,tenant_id,owner_object_id)
    values(p_source_id,p_tenant_id,p_owner_object_id) on conflict(source_id) do nothing;
  inserted := found;
  select * into existing from meeting_knowledge.source where source_id = p_source_id for update;
  if not existing.active or existing.tenant_id <> p_tenant_id or existing.owner_object_id <> p_owner_object_id then
    raise exception using errcode = 'P0001', message = 'SOURCE_UNAVAILABLE';
  end if;
  if inserted then
    insert into meeting_knowledge.access_event(source_id,tenant_id,actor_object_id,action,access_revision)
      values(p_source_id,p_tenant_id,p_owner_object_id,'initialize',existing.access_revision);
  end if;
  return public.meeting_knowledge_current_source(p_tenant_id,p_source_id);
end;
$$;

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
    and n.transcription is not null and length(n.transcription) > 0 for share;
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
  return public.meeting_knowledge_current_source(p_tenant_id,p_source_id);
end;
$$;

-- Only trigger execution uses definer rights: normal browser edits cannot write
-- the private ledger directly. Closed search_path and fully qualified tables.
create or replace function meeting_knowledge.note_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare before_row jsonb := to_jsonb(old); after_row jsonb;
begin
  if tg_op = 'DELETE' then
    update meeting_knowledge.source set active = false, integration_enabled = false,
      access_revision = access_revision + 1, updated_at = now() where source_id = old.id::text and active;
    return old;
  end if;
  after_row := to_jsonb(new);
  if old.id::text is distinct from new.id::text or lower(old.user_id) is distinct from lower(new.user_id) then
    -- Owner reassignment or note-ID reuse must never revive the old audience.
    update meeting_knowledge.source set active = false, integration_enabled = false,
      access_revision = access_revision + 1, updated_at = now() where source_id = old.id::text and active;
    return new;
  end if;
  update meeting_knowledge.source set
    content_revision = content_revision + case when before_row->'transcription' is distinct from after_row->'transcription'
      or before_row->'diarization' is distinct from after_row->'diarization' then 1 else 0 end,
    speaker_revision = speaker_revision + case when before_row->'diarization' is distinct from after_row->'diarization'
      or before_row->'speakers' is distinct from after_row->'speakers' then 1 else 0 end,
    access_revision = access_revision + case when before_row->'shared_users' is distinct from after_row->'shared_users'
      or before_row->'projects' is distinct from after_row->'projects' then 1 else 0 end,
    updated_at = now()
    where source_id = old.id::text and active and (
      before_row->'transcription' is distinct from after_row->'transcription'
      or before_row->'diarization' is distinct from after_row->'diarization'
      or before_row->'speakers' is distinct from after_row->'speakers'
      or before_row->'shared_users' is distinct from after_row->'shared_users'
      or before_row->'projects' is distinct from after_row->'projects');
  return new;
end;
$$;

create or replace function meeting_knowledge.project_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare previous_id text; current_id text;
begin
  if tg_op <> 'INSERT' then previous_id := old.id::text; end if;
  if tg_op <> 'DELETE' then current_id := new.id::text; end if;
  if tg_op = 'UPDATE' and old.id::text is not distinct from new.id::text
    and old.user_id is not distinct from new.user_id and old.shared_users is not distinct from new.shared_users then return new; end if;
  update meeting_knowledge.source s set access_revision = s.access_revision + 1, updated_at = now()
    where s.active and exists (select 1 from public.note n where n.id::text = s.source_id
      and exists (select 1 from unnest(n.projects) id where id::text = previous_id or id::text = current_id));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create or replace function meeting_knowledge.speaker_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare previous_owner text; current_owner text;
begin
  if tg_op <> 'INSERT' then previous_owner := lower(old.user_id); end if;
  if tg_op <> 'DELETE' then current_owner := lower(new.user_id); end if;
  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then return new; end if;
  -- Conservative invalidation: speaker profiles have no stable per-note FK.
  update meeting_knowledge.source set speaker_revision = speaker_revision + 1, updated_at = now()
    where active and (owner_object_id::text = previous_owner or owner_object_id::text = current_owner);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists meeting_knowledge_note_changed on public.note;
create trigger meeting_knowledge_note_changed after update or delete on public.note
  for each row execute function meeting_knowledge.note_changed();
drop trigger if exists meeting_knowledge_project_changed on public.project;
create trigger meeting_knowledge_project_changed after insert or update or delete on public.project
  for each row execute function meeting_knowledge.project_changed();
drop trigger if exists meeting_knowledge_speaker_changed on public.speaker;
create trigger meeting_knowledge_speaker_changed after insert or update or delete on public.speaker
  for each row execute function meeting_knowledge.speaker_changed();

revoke all on all functions in schema meeting_knowledge from public, anon, authenticated, service_role;
revoke all on function public.meeting_knowledge_current_source(uuid,text) from public, anon, authenticated;
revoke all on function public.meeting_knowledge_initialize(uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.meeting_knowledge_mutate(uuid,text,uuid,bigint,text,uuid,text) from public, anon, authenticated;
grant execute on function public.meeting_knowledge_current_source(uuid,text) to service_role;
grant execute on function public.meeting_knowledge_initialize(uuid,text,uuid) to service_role;
grant execute on function public.meeting_knowledge_mutate(uuid,text,uuid,bigint,text,uuid,text) to service_role;
commit;
