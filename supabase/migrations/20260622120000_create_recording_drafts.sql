insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'recording-drafts',
  'recording-drafts',
  false,
  52428800,
  array[
    'audio/mp4',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/aac',
    'audio/webm',
    'audio/webm;codecs=opus'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.recording_draft (
  id uuid primary key,
  user_id text not null,
  file_name text not null,
  mime_type text not null,
  started_at timestamptz not null default now(),
  last_chunk_at timestamptz,
  chunk_count integer not null default 0,
  total_bytes bigint not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.recording_draft_chunk (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.recording_draft(id) on delete cascade,
  user_id text not null,
  chunk_index integer not null,
  bucket text not null default 'recording-drafts',
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null,
  created_at timestamptz not null default now(),
  unique (draft_id, chunk_index),
  unique (bucket, storage_path)
);

create index if not exists recording_draft_user_status_idx
  on public.recording_draft (user_id, status, updated_at desc);

create index if not exists recording_draft_chunk_draft_idx
  on public.recording_draft_chunk (draft_id, chunk_index);

alter table public.recording_draft enable row level security;
alter table public.recording_draft_chunk enable row level security;

grant select, insert, update, delete on public.recording_draft to authenticated;
grant select, insert, update, delete on public.recording_draft_chunk to authenticated;

drop policy if exists recording_draft_owner_all on public.recording_draft;
create policy recording_draft_owner_all
on public.recording_draft
for all
to authenticated
using (user_id = auth.jwt() ->> 'sub')
with check (user_id = auth.jwt() ->> 'sub');

drop policy if exists recording_draft_chunk_owner_all on public.recording_draft_chunk;
create policy recording_draft_chunk_owner_all
on public.recording_draft_chunk
for all
to authenticated
using (user_id = auth.jwt() ->> 'sub')
with check (user_id = auth.jwt() ->> 'sub');

drop policy if exists recording_draft_service_role_all on public.recording_draft;
create policy recording_draft_service_role_all
on public.recording_draft
for all
to service_role
using (true)
with check (true);

drop policy if exists recording_draft_chunk_service_role_all on public.recording_draft_chunk;
create policy recording_draft_chunk_service_role_all
on public.recording_draft_chunk
for all
to service_role
using (true)
with check (true);

drop policy if exists recording_drafts_authenticated_select on storage.objects;
create policy recording_drafts_authenticated_select
on storage.objects
for select
to authenticated
using (
  bucket_id = 'recording-drafts'
  and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
);

drop policy if exists recording_drafts_authenticated_insert on storage.objects;
create policy recording_drafts_authenticated_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'recording-drafts'
  and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
);

drop policy if exists recording_drafts_authenticated_update on storage.objects;
create policy recording_drafts_authenticated_update
on storage.objects
for update
to authenticated
using (
  bucket_id = 'recording-drafts'
  and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
)
with check (
  bucket_id = 'recording-drafts'
  and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
);

drop policy if exists recording_drafts_authenticated_delete on storage.objects;
create policy recording_drafts_authenticated_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'recording-drafts'
  and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
);
