-- Synthetic in-memory fixture only, never apply to a hosted database.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
grant usage on schema public, auth to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;
create table public.app_user (microsoft_id text primary key);
create table public.file (id text primary key, user_id text);
create table public.speaker (id text primary key, user_id text);
create table public.summary_prompt (id text primary key, user_id text);
create table public.project (
  id text primary key, user_id text, notes text[] default array[]::text[]
);
create table public.note (
  id text primary key, user_id text, name text, summary_edit text,
  shared_users text[] default array[]::text[], projects text[] default array[]::text[]
);
insert into public.project (id, user_id) values ('owned-project', 'note-owner');
insert into public.note (id, user_id, name, summary_edit, shared_users, projects)
values ('fixture-note', 'note-owner', 'Original title', 'Original summary', array['direct-reader'], array['owned-project']);
