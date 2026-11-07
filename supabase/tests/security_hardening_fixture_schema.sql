-- Synthetic in-memory fixture only, never apply to a hosted database.
-- Mirrors just enough of the hosted schema (roles, auth.jwt, storage.objects/foldername,
-- note/note_image/project/chat and the two *_for_user RPC signatures) to execute
-- 20261107120000_security_audit_hardening.sql against real PostgreSQL policy evaluation.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1];
$$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
create table storage.objects (id serial primary key, bucket_id text, name text, owner_id text);
alter table storage.objects enable row level security;
grant select on storage.objects to authenticated;

create table public.project (id text primary key, user_id text, shared_users text[] default array[]::text[]);
create table public.note (id text primary key, user_id text, shared_users text[] default array[]::text[]);
create table public.note_image (
  id text primary key default gen_random_uuid()::text, note_id text, user_id text,
  bucket text default 'meeting-note-images', storage_path text, thumbnail_storage_path text
);
alter table public.note_image enable row level security;
grant select, insert, update on public.note_image to authenticated;
create policy note_image_read on public.note_image for select to authenticated using (true);
grant select on public.project, public.note to authenticated;
create table public.chat (id text primary key, user_id text, project_id text, message text);
alter table public.chat enable row level security;
grant select, update on public.chat to authenticated;
create policy chat_read on public.chat for select to authenticated using (true);

-- Supabase's default privileges grant EXECUTE on new public functions directly to anon and
-- authenticated; reproduce that so the migration's revoke is actually exercised.
create function public.add_note_to_project_for_user(p_note_id text, p_project_id text, p_user_id text)
returns void language sql security definer as $$ select null::void $$;
create function public.remove_note_from_project_for_user(p_note_id text, p_project_id text, p_user_id text)
returns void language sql security definer as $$ select null::void $$;
grant execute on function public.add_note_to_project_for_user(text, text, text) to anon, authenticated, service_role;
grant execute on function public.remove_note_from_project_for_user(text, text, text) to anon, authenticated, service_role;

insert into public.project (id, user_id, shared_users) values ('victim-project', 'victim', array[]::text[]), ('attacker-project', 'attacker', array[]::text[]);
insert into public.note (id, user_id, shared_users) values ('victim-note', 'victim', array['reader']), ('attacker-note', 'attacker', array[]::text[]);
insert into storage.objects (bucket_id, name, owner_id) values
  ('meeting-note-images', 'victim/victim-note/img1.png', 'victim'),
  ('meeting-note-images', 'victim/victim-note/img1-thumb.jpg', 'victim');
insert into public.note_image (id, note_id, user_id, storage_path, thumbnail_storage_path)
values ('victim-image', 'victim-note', 'victim', 'victim/victim-note/img1.png', 'victim/victim-note/img1-thumb.jpg');
-- A row forged BEFORE the migration (so its WITH CHECK never saw it): the attacker points a row
-- on their own note at the victim's thumbnail.
insert into public.note_image (id, note_id, user_id, storage_path, thumbnail_storage_path)
values ('forged-image', 'attacker-note', 'attacker', 'attacker/attacker-note/x.png', 'victim/victim-note/img1-thumb.jpg');
insert into public.chat (id, user_id, project_id, message) values ('attacker-msg', 'attacker', 'attacker-project', 'hi');
