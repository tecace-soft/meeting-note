-- Drop hand-made anon storage policies and make meeting-recordings private.
--
-- INCIDENT (found and fixed 2026-10-28): the live prod DB carried two policies on
-- storage.objects that were created by hand in the Supabase dashboard and existed in
-- no migration:
--   "Public read access 1kkks50_0"  SELECT for role anon, USING (bucket_id = 'meeting-recordings')
--   "Allow uploads 1kkks50_0"       INSERT for role anon
-- The anon key is public, so anyone could list, download and upload meeting
-- recordings. The 2026-10-09 fix (20261009120000_scope_meeting_recordings_rls.sql)
-- only replaced the policies named in the repo, so these two survived.
--
-- ALREADY APPLIED IN PROD by Andrew on 2026-10-28 via the SQL Editor (post-check:
-- bucket public = false, 0 anon/public policies on storage.objects). This file records
-- the fix; applying it again is a no-op. No app flow uses the anon role for this
-- bucket: playback goes through the note-audio-url edge function with the service role.
--
-- Authenticated and service_role policies are NOT touched.

begin;

drop policy if exists "Public read access 1kkks50_0" on storage.objects;
drop policy if exists "Allow uploads 1kkks50_0" on storage.objects;

update storage.buckets set public = false where id = 'meeting-recordings';

-- DEFENSIVE sweep: drop ANY remaining policy on storage.objects that applies to the
-- anon or public role and mentions one of our buckets. Today's live count is 0, so
-- this loop does nothing in prod; it guards against future dashboard-made policies
-- on a fresh or drifted environment. The loop is bounded by the (small) policy list
-- and additionally capped at 100 iterations.
do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select policyname
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (roles && array['anon', 'public']::name[])
      and (
        coalesce(qual, '') || ' ' || coalesce(with_check, '') ~
          '(meeting-recordings|meeting-note-images|recording-drafts|feedback-attachments)'
      )
    order by policyname
    limit 100
  loop
    execute format('drop policy if exists %I on storage.objects', r.policyname);
    n := n + 1;
  end loop;
  raise notice 'dropped % residual anon/public storage.objects policies', n;
end
$$;

commit;
