-- LOCAL SYNTHETIC DATABASE ONLY. This models the existing legacy tables, not a
-- migration. Never run this fixture bootstrap against a hosted project.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create table public.note (
  id text primary key, user_id text not null, transcription text, diarization jsonb,
  summary text, name text, meeting_at timestamptz, shared_users text[] default '{}', projects text[] default '{}'
);
create table public.project (id text primary key, user_id text not null, shared_users text[] default '{}');
create table public.speaker (id text primary key, user_id text not null, name text);
alter table public.note enable row level security;
alter table public.project enable row level security;
alter table public.speaker enable row level security;
grant usage on schema public to service_role, authenticated, anon;
grant select, insert, update, delete on public.note, public.project, public.speaker to service_role, authenticated;
create policy service_fixture on public.note to service_role using (true) with check (true);
create policy service_fixture on public.project to service_role using (true) with check (true);
create policy service_fixture on public.speaker to service_role using (true) with check (true);
-- Fixtures simulate the existing legacy note owner's browser RLS access.
create policy owner_fixture on public.note to authenticated
  using (user_id = '22222222-2222-4222-8222-000000000001') with check (user_id = '22222222-2222-4222-8222-000000000001');
create policy owner_fixture on public.project to authenticated
  using (user_id = '22222222-2222-4222-8222-000000000001') with check (user_id = '22222222-2222-4222-8222-000000000001');
create policy owner_fixture on public.speaker to authenticated
  using (user_id = '22222222-2222-4222-8222-000000000001') with check (user_id = '22222222-2222-4222-8222-000000000001');
