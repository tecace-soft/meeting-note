-- Owner-scope the meeting-recordings storage RLS policies.
--
-- The original policies (20260602125000_enable_audio_storage_rls.sql) scoped
-- every authenticated SELECT/INSERT/UPDATE/DELETE on storage.objects to only
-- `bucket_id = 'meeting-recordings'`. With no owner predicate, any authenticated
-- user could list, download, overwrite, or delete ANY other user's raw audio.
--
-- We scope reads and writes by `storage.objects.owner_id`, which Supabase sets
-- automatically at upload time to the uploader's JWT `sub`. That value equals
-- the `public.file.user_id` recorded for the same object (verified in prod,
-- 2026-10-09), so owner_id is the authoritative owner for this flat bucket.
--
-- WHY NOT a join to public.file (the meeting-note-images pattern):
-- the upload path is upload-then-record. The client uploads the object FIRST,
-- then polls storage to confirm visibility (ensureStorageObjectReady in
-- src/lib/storagePublicReady.ts does a user-client list/SELECT), and only AFTER
-- that writes the public.file row. A SELECT policy that requires a matching
-- file row therefore fails during that confirmation poll (the row does not
-- exist yet), which BROKE uploads in prod when first shipped. owner_id is
-- populated by Supabase at INSERT time, so the owner's own post-upload SELECT
-- passes immediately while other users still get zero rows.
--
-- Raw audio is never shared between users, so ownership is strict (no
-- shared_users branch, unlike the note-image policy).
--
-- INSERT keeps only the bucket predicate: owner_id is assigned by Supabase
-- during the insert, so it cannot be asserted in WITH CHECK. The flat
-- random-uuid prefix plus upsert:false means a user still cannot clobber
-- another user's object on INSERT, and the owner-scoped SELECT/UPDATE/DELETE
-- below prevent reading, overwriting, or deleting anything they do not own.

drop policy if exists meeting_recordings_authenticated_select on storage.objects;
create policy meeting_recordings_authenticated_select
on storage.objects
for select
to authenticated
using (
  bucket_id = 'meeting-recordings'
  and owner_id = auth.jwt() ->> 'sub'
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
  and owner_id = auth.jwt() ->> 'sub'
)
with check (
  bucket_id = 'meeting-recordings'
  and owner_id = auth.jwt() ->> 'sub'
);

drop policy if exists meeting_recordings_authenticated_delete on storage.objects;
create policy meeting_recordings_authenticated_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'meeting-recordings'
  and owner_id = auth.jwt() ->> 'sub'
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
