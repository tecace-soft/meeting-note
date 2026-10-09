-- Owner-scope the meeting-recordings storage RLS policies.
--
-- The original policies (20260602125000_enable_audio_storage_rls.sql) scoped
-- every authenticated SELECT/INSERT/UPDATE/DELETE on storage.objects to only
-- `bucket_id = 'meeting-recordings'`. With no owner predicate, any authenticated
-- user could list, download, overwrite, or delete ANY other user's raw audio.
--
-- Object names in this bucket are FLAT: the upload path is `${fileId}-${name}`
-- with no per-user folder prefix (see src/pages/TranscriptionSummary.tsx), so
-- `storage.foldername(name)` cannot carry the owner. We therefore scope reads
-- and writes by joining storage.objects to the public.file metadata row that
-- records each upload, mirroring the meeting-note-images policy pattern:
--   file.bucket       = storage.objects.bucket_id
--   file.storage_path = storage.objects.name
--   file.user_id      = auth.jwt() ->> 'sub'  (the owner)
-- Raw audio is never shared between users, so ownership is strict (no
-- shared_users branch, unlike the note-image policy).
--
-- INSERT keeps only the bucket predicate: the public.file row is written AFTER
-- the storage object is uploaded (upload-then-record flow), so no owning file
-- row exists yet at INSERT time. Tightening INSERT further would require
-- reordering the upload path, which is intentionally out of scope here. The
-- flat random-uuid prefix plus upsert:false means a user still cannot clobber
-- another user's object on INSERT, and the owner-scoped SELECT/UPDATE/DELETE
-- below prevent reading, overwriting, or deleting anything they do not own.

drop policy if exists meeting_recordings_authenticated_select on storage.objects;
create policy meeting_recordings_authenticated_select
on storage.objects
for select
to authenticated
using (
  bucket_id = 'meeting-recordings'
  and exists (
    select 1
    from public.file f
    where f.bucket = storage.objects.bucket_id
      and f.storage_path = storage.objects.name
      and f.user_id = auth.jwt() ->> 'sub'
  )
);

drop policy if exists meeting_recordings_authenticated_insert on storage.objects;
create policy meeting_recordings_authenticated_insert
on storage.objects
for insert
to authenticated
with check (bucket_id = 'meeting-recordings');

drop policy if exists meeting_recordings_authenticated_update on storage.objects;
create policy meeting_recordings_authenticated_update
on storage.objects
for update
to authenticated
using (
  bucket_id = 'meeting-recordings'
  and exists (
    select 1
    from public.file f
    where f.bucket = storage.objects.bucket_id
      and f.storage_path = storage.objects.name
      and f.user_id = auth.jwt() ->> 'sub'
  )
)
with check (
  bucket_id = 'meeting-recordings'
  and exists (
    select 1
    from public.file f
    where f.bucket = storage.objects.bucket_id
      and f.storage_path = storage.objects.name
      and f.user_id = auth.jwt() ->> 'sub'
  )
);

drop policy if exists meeting_recordings_authenticated_delete on storage.objects;
create policy meeting_recordings_authenticated_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'meeting-recordings'
  and exists (
    select 1
    from public.file f
    where f.bucket = storage.objects.bucket_id
      and f.storage_path = storage.objects.name
      and f.user_id = auth.jwt() ->> 'sub'
  )
);

-- Keep server-side (service_role) access working explicitly, mirroring the
-- recording-drafts bucket. service_role bypasses RLS in Supabase, but an
-- explicit full-access policy keeps server operations robust regardless of
-- that configuration.
drop policy if exists meeting_recordings_service_role_all on storage.objects;
create policy meeting_recordings_service_role_all
on storage.objects
for all
to service_role
using (bucket_id = 'meeting-recordings')
with check (bucket_id = 'meeting-recordings');
