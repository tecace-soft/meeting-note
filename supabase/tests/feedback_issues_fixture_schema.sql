-- LOCAL SYNTHETIC DATABASE ONLY. Minimal stand-ins for the Supabase pieces the F2
-- feedback-issues migrations touch (roles, auth.jwt(), storage schema, app_user).
-- Never run this fixture bootstrap against a hosted project.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create schema if not exists storage;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
-- Supabase gives service_role full table privileges by default.
alter default privileges in schema public grant all on tables to service_role;

-- Same contract as Supabase: the request's JWT claims, or null outside a request.
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner_id text,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;

create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)];
$$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

-- Mirrors 20260528120000_create_app_user_table.sql + 20260602124000_enable_user_data_rls.sql.
create table public.app_user (
  microsoft_id text primary key,
  display_name text not null default 'User',
  email text not null default '',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.app_user enable row level security;
grant select, insert, update on public.app_user to authenticated;
create policy app_user_self_select on public.app_user for select to authenticated
  using (microsoft_id = auth.jwt() ->> 'sub');
create policy app_user_self_insert on public.app_user for insert to authenticated
  with check (microsoft_id = auth.jwt() ->> 'sub');
create policy app_user_self_update on public.app_user for update to authenticated
  using (microsoft_id = auth.jwt() ->> 'sub') with check (microsoft_id = auth.jwt() ->> 'sub');
