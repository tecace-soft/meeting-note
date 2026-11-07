-- Security audit hardening (2026-11-07). Each block is independent and idempotent.
-- None of these changes affect the legitimate app paths:
--   * the two *_for_user RPCs are only called by workflow-server with the service-role key;
--   * every client writes note images under "<own sub>/<noteId>/..." (web and mobile),
--     and the storage INSERT policy already forces that first folder to be the uploader;
--   * chat messages are only ever inserted or edited inside a project the author can access.

-- ---------------------------------------------------------------------------------------------
-- 1) Service-only SECURITY DEFINER RPCs must not be callable by anon/authenticated.
--    They trust p_user_id as the caller identity. `revoke ... from public` does not remove the
--    direct EXECUTE grants Supabase's default privileges give anon and authenticated, so with
--    only the public anon key anyone could add/remove notes in another user's project.
-- ---------------------------------------------------------------------------------------------
revoke all on function public.add_note_to_project_for_user(text, text, text) from public, anon, authenticated;
grant execute on function public.add_note_to_project_for_user(text, text, text) to service_role;

revoke all on function public.remove_note_from_project_for_user(text, text, text) from public, anon, authenticated;
grant execute on function public.remove_note_from_project_for_user(text, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2) meeting-note-images: a note_image row must not grant read access to someone else's object.
--    note_image rows are client-written and storage_path/thumbnail_storage_path were unchecked,
--    so a user who once learned an object path (e.g. a former share recipient) could point a row
--    on their own note at it and keep minting signed URLs. Require the object to live in the
--    folder of the row's author (who is always the note owner), and require new/edited rows to
--    reference only the author's own folder.
-- ---------------------------------------------------------------------------------------------
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
      and (storage.foldername(storage.objects.name))[1] = ni.user_id
      and ni.user_id = n.user_id
      and (
        ni.user_id = auth.jwt() ->> 'sub'
        or n.user_id = auth.jwt() ->> 'sub'
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
  and split_part(storage_path, '/', 1) = auth.jwt() ->> 'sub'
  and (thumbnail_storage_path is null or split_part(thumbnail_storage_path, '/', 1) = auth.jwt() ->> 'sub')
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
with check (
  user_id = auth.jwt() ->> 'sub'
  and split_part(storage_path, '/', 1) = auth.jwt() ->> 'sub'
  and (thumbnail_storage_path is null or split_part(thumbnail_storage_path, '/', 1) = auth.jwt() ->> 'sub')
);

-- ---------------------------------------------------------------------------------------------
-- 3) chat: an author editing their own message must not move it into a project they cannot
--    access (the INSERT policy already requires project access; UPDATE only checked user_id).
-- ---------------------------------------------------------------------------------------------
drop policy if exists chat_author_update on public.chat;
create policy chat_author_update
on public.chat
for update
to authenticated
using (user_id = auth.jwt() ->> 'sub')
with check (
  user_id = auth.jwt() ->> 'sub'
  and project_id in (
    select id from public.project
    where user_id = auth.jwt() ->> 'sub'
       or coalesce(shared_users, array[]::text[]) @> array[auth.jwt() ->> 'sub']
  )
);
