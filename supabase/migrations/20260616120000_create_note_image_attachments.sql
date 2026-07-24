insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'meeting-note-images',
  'meeting-note-images',
  false,
  52428800,
  array[
    'text/html',
    'text/css',
    'text/plain',
    'text/xml',
    'text/csv',
    'text/rtf',
    'text/javascript',
    'application/json',
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/bmp',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/avi',
    'video/x-flv',
    'video/mpg',
    'video/webm',
    'video/wmv',
    'video/3gpp',
    'audio/wav',
    'audio/mp3',
    'audio/mpeg',
    'audio/aiff',
    'audio/aac',
    'audio/ogg',
    'audio/flac'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.note_image (
  id uuid primary key default gen_random_uuid(),
  note_id text not null references public.note(id) on delete cascade,
  user_id text not null,
  bucket text not null default 'meeting-note-images',
  storage_path text not null,
  thumbnail_storage_path text,
  thumbnail_mime_type text,
  thumbnail_size_bytes bigint,
  thumbnail_width integer,
  thumbnail_height integer,
  name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  width integer,
  height integer,
  created_at timestamptz not null default now(),
  unique (bucket, storage_path)
);

create index if not exists note_image_note_id_idx
  on public.note_image (note_id, created_at);

create index if not exists note_image_user_id_idx
  on public.note_image (user_id);

alter table public.note_image enable row level security;

grant select, insert, update, delete on public.note_image to authenticated;

drop policy if exists note_image_access_select on public.note_image;
create policy note_image_access_select
on public.note_image
for select
to authenticated
using (
  user_id = auth.jwt() ->> 'sub'
  or exists (
    select 1
    from public.note n
    where n.id = note_image.note_id
      and (
        n.user_id = auth.jwt() ->> 'sub'
        or coalesce(n.shared_users, array[]::text[]) @> array[auth.jwt() ->> 'sub']
      )
  )
);

drop policy if exists note_image_owner_insert on public.note_image;
create policy note_image_owner_insert
on public.note_image
for insert
to authenticated
with check (
  user_id = auth.jwt() ->> 'sub'
  and exists (
    select 1
    from public.note n
    where n.id = note_image.note_id
      and n.user_id = auth.jwt() ->> 'sub'
  )
);

drop policy if exists note_image_owner_update on public.note_image;
create policy note_image_owner_update
on public.note_image
for update
to authenticated
using (user_id = auth.jwt() ->> 'sub')
with check (user_id = auth.jwt() ->> 'sub');

drop policy if exists note_image_owner_delete on public.note_image;
create policy note_image_owner_delete
on public.note_image
for delete
to authenticated
using (user_id = auth.jwt() ->> 'sub');

drop policy if exists note_image_service_role_all on public.note_image;
create policy note_image_service_role_all
on public.note_image
for all
to service_role
using (true)
with check (true);

drop policy if exists meeting_note_images_authenticated_select on storage.objects;
create policy meeting_note_images_authenticated_select
on storage.objects
for select
to authenticated
using (
  bucket_id = 'meeting-note-images'
  and exists (
    select 1
    from public.note_image ni
    join public.note n on n.id = ni.note_id
    where ni.bucket = storage.objects.bucket_id
      and (
        ni.storage_path = storage.objects.name
        or ni.thumbnail_storage_path = storage.objects.name
      )
      and (
        ni.user_id = auth.jwt() ->> 'sub'
        or n.user_id = auth.jwt() ->> 'sub'
        or coalesce(n.shared_users, array[]::text[]) @> array[auth.jwt() ->> 'sub']
      )
  )
);

drop policy if exists meeting_note_images_authenticated_insert on storage.objects;
create policy meeting_note_images_authenticated_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'meeting-note-images'
  and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
);

drop policy if exists meeting_note_images_authenticated_update on storage.objects;
create policy meeting_note_images_authenticated_update
on storage.objects
for update
to authenticated
using (
  bucket_id = 'meeting-note-images'
  and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
)
with check (
  bucket_id = 'meeting-note-images'
  and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
);

drop policy if exists meeting_note_images_authenticated_delete on storage.objects;
create policy meeting_note_images_authenticated_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'meeting-note-images'
  and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
);
