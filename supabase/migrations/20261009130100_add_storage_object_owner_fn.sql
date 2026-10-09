-- Authoritative storage-object ownership lookup for the note-audio-url edge function (R01).
--
-- note-audio-url signs private audio objects with the service role after checking
-- only the caller's access to the NOTE. The object path it signs comes from
-- client-editable data: note.audio_file_id (a file row) or the note.audio_file URL.
-- The public.file table is itself client-writable (its INSERT RLS checks only
-- user_id = self, not that storage_path is actually the user's upload), so a
-- file-table ownership check is forgeable: a user can insert a file row in their
-- own name pointing at someone else's storage_path.
--
-- The only owner signal a client cannot forge is storage.objects.owner_id, which
-- Supabase sets to the uploader's JWT sub at upload time. This SECURITY DEFINER
-- function lets the service role (and ONLY the service role) read that owner for a
-- given bucket/name, so note-audio-url can refuse to sign an object the note owner
-- does not actually own.
--
-- Apply this migration BEFORE deploying the note-audio-url change that calls it:
-- that function fails closed when the RPC is absent (it will not sign), so an
-- early deploy would break audio playback until this is applied.
create or replace function public.storage_object_owner(p_bucket text, p_name text)
returns text
language sql
security definer
set search_path = storage, public
as $$
  select owner_id
  from storage.objects
  where bucket_id = p_bucket and name = p_name
  limit 1;
$$;

-- Service-role only. No anon/authenticated caller should enumerate object owners.
revoke all on function public.storage_object_owner(text, text) from public;
revoke all on function public.storage_object_owner(text, text) from anon;
revoke all on function public.storage_object_owner(text, text) from authenticated;
grant execute on function public.storage_object_owner(text, text) to service_role;
