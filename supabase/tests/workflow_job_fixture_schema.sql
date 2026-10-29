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
create table public.note (
  id text primary key, user_id text, user_name text, transcription text,
  transcription_language text, transcription_translations jsonb,
  summary text, summary_translations jsonb, audio_file text, name text, tags text[],
  diarization jsonb, diarization_translations jsonb, meeting_at timestamptz,
  audio_file_id uuid, duration_seconds double precision
);
alter table public.note enable row level security;
-- Enrichment tables for the real S12 fenced RPCs; synthetic data only.
create table public.user_memory (
  user_id text primary key, memory jsonb not null default '{}', processed_note_ids text[] not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.note_insight (
  note_id text primary key references public.note(id), user_id text not null,
  actions jsonb not null default '[]', decisions jsonb not null default '[]', events jsonb not null default '[]',
  topics text[] not null default '{}', people text[] not null default '{}', companies text[] not null default '{}',
  source_model text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.user_memory enable row level security;
alter table public.note_insight enable row level security;
