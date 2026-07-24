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
