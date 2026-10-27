-- Synthetic in-memory fixture only, never apply to a hosted database.
-- Recreates the Supabase roles and default privileges that the real workflow_job
-- migrations revoke from and grant to, so the PGlite harness runs those files as-is.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
-- 20260602123000_enable_backend_table_rls.sql also locks down mcp_token; this stub
-- lets that real migration run unchanged.
create table public.mcp_token (id text primary key);
-- note stub for the S10 claim's "note already saved" check. Production note.id is text
-- (other tables reference it from text columns). RLS on with no policy, like a table only
-- service_role (bypassrls) may read through the claim.
create table public.note (id text primary key, user_id text);
alter table public.note enable row level security;
