-- Reconcile the two conflicting mcp_tracking migrations into one canonical shape.
--
-- Two migrations BOTH create the MCP tracking tables with incompatible
-- definitions (schema-ledger drift):
--   20260629120000_create_mcp_tracking_tables.sql  (the ABANDONED first design)
--     mcp_session.id      uuid, columns user_hash / microsoft_user_id /
--                         microsoft_email / completed_at, RLS enabled +
--                         service_role policy.
--     mcp_tool_call.id    uuid, session_id uuid references mcp_session(id)
--                         ON DELETE SET NULL, columns tool_name (NOT NULL) /
--                         arguments_preview / result_preview /
--                         result_content_type / is_error / started_at /
--                         completed_at.
--     mcp_evaluation      a review table that the application never reads.
--   20260702120000_create_mcp_tracking_tables.sql  (the SHIPPED design)
--     mcp_session.id      text, columns finished_at / final_answer /
--                         final_answer_logged_at / tool_names[] /
--                         tool_call_count / total_tokens / created_at /
--                         updated_at; revoke anon+authenticated, grant
--                         service_role (no RLS enable).
--     mcp_tool_call.id    text, session_id text references mcp_session(id)
--                         ON DELETE CASCADE, columns time / tool / user_intent /
--                         reason_for_tool_choice / expected_answer_type /
--                         input / output_preview / outcome.
--
-- REQUIRED shape = the 20260702 design. The live writer
-- (workflow-server/src/mcp/lib/mcpTracking.ts) upserts mcp_session with
-- tool_names / tool_call_count / finished_at / final_answer and inserts
-- mcp_tool_call with tool / time / outcome / input. It uses randomUUID() ids,
-- which are valid values for BOTH a text and a uuid primary key (see the comment
-- at mcpTracking.ts line 46), so the id-type divergence does not break the writer.
-- The admin dashboard reads these same 20260702 columns (with defensive
-- fallbacks). mcp_evaluation is referenced nowhere in code.
--
-- Because both files use `create table if not exists`, whichever ran first in a
-- given project "won" the table shape and the second's create was a no-op; only
-- the 20260702 file then ran ALTER ... ADD COLUMN IF NOT EXISTS, so a project
-- with BOTH applied ends up with a hybrid: uuid ids (from 629) carrying 702's
-- extra columns, PLUS a leftover mcp_tool_call.tool_name that is NOT NULL with no
-- default. The writer never sets tool_name, so that one leftover constraint is
-- the only thing that would break inserts in the both-applied state.
--
-- This forward migration converges any project (0, 1, or both originals applied)
-- to the working 20260702 shape, idempotently and without destructive surgery:
--   * create-if-not-exists leaves an existing table (and its id type) untouched
--     and only materializes the tables on a fresh project.
--   * add-column-if-not-exists back-fills the 20260702 columns onto a table that
--     was created by the 20260629 file.
--   * a guarded `drop not null` on the legacy mcp_tool_call.tool_name unblocks
--     inserts in the both-applied state. We only relax the constraint; we do NOT
--     drop the column or any data.
--   * RLS is enabled with anon/authenticated revoked and a service_role full
--     policy, unifying the 629 posture (RLS + policy) and the 702 posture
--     (revoke + grant) into their strict union.
-- No column, index, data, or the unused mcp_evaluation table is dropped. Safe to
-- run even if a project already matches the target shape (every statement is a
-- no-op in that case).

-- ============================ mcp_session ============================

-- Fresh projects get the canonical 20260702 definition. On a project where the
-- 20260629 file already created mcp_session (uuid id), this is a no-op and the
-- existing id type is preserved (the writer's uuid-string ids work either way).
create table if not exists public.mcp_session (
  id text primary key,
  request_id text not null,
  user_id text,
  endpoint text,
  platform text,
  auth_mode text,
  method text,
  path text,
  user_agent text,
  client_ip text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text,
  status_code integer,
  duration_ms integer,
  error_message text,
  final_answer text,
  final_answer_logged_at timestamptz,
  tool_names text[] not null default array[]::text[],
  tool_call_count integer not null default 0,
  total_tokens integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Back-fill the 20260702 columns onto a table created by the 20260629 file.
-- Every column is nullable or has a default, so this is safe on a table with
-- existing rows.
alter table public.mcp_session
  add column if not exists request_id text,
  add column if not exists user_id text,
  add column if not exists endpoint text,
  add column if not exists platform text,
  add column if not exists auth_mode text,
  add column if not exists method text,
  add column if not exists path text,
  add column if not exists user_agent text,
  add column if not exists client_ip text,
  add column if not exists started_at timestamptz not null default now(),
  add column if not exists finished_at timestamptz,
  add column if not exists status text,
  add column if not exists status_code integer,
  add column if not exists duration_ms integer,
  add column if not exists error_message text,
  add column if not exists final_answer text,
  add column if not exists final_answer_logged_at timestamptz,
  add column if not exists tool_names text[] not null default array[]::text[],
  add column if not exists tool_call_count integer not null default 0,
  add column if not exists total_tokens integer,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists mcp_session_started_at_idx
  on public.mcp_session (started_at desc);

create index if not exists mcp_session_user_started_at_idx
  on public.mcp_session (user_id, started_at desc);

create index if not exists mcp_session_status_idx
  on public.mcp_session (status);

-- ============================ mcp_tool_call ============================

create table if not exists public.mcp_tool_call (
  id text primary key,
  session_id text not null references public.mcp_session(id) on delete cascade,
  request_id text,
  user_id text,
  time timestamptz not null default now(),
  tool text not null,
  user_intent text,
  reason_for_tool_choice text,
  expected_answer_type text,
  input jsonb not null default '{}'::jsonb,
  output_preview text,
  outcome text not null,
  duration_ms integer not null default 0,
  error_message text,
  created_at timestamptz not null default now()
);

-- Back-fill the 20260702 columns onto a table created by the 20260629 file.
-- tool / outcome are added nullable here (unlike the fresh-create NOT NULL) so
-- ADD COLUMN succeeds on a table that already holds rows; the writer always
-- supplies them.
alter table public.mcp_tool_call
  add column if not exists session_id text,
  add column if not exists request_id text,
  add column if not exists user_id text,
  add column if not exists time timestamptz not null default now(),
  add column if not exists tool text,
  add column if not exists user_intent text,
  add column if not exists reason_for_tool_choice text,
  add column if not exists expected_answer_type text,
  add column if not exists input jsonb not null default '{}'::jsonb,
  add column if not exists output_preview text,
  add column if not exists outcome text,
  add column if not exists duration_ms integer not null default 0,
  add column if not exists error_message text,
  add column if not exists created_at timestamptz not null default now();

-- Legacy 20260629 column: tool_name was NOT NULL with no default. The writer
-- never sets it (it writes `tool`), so in a both-applied project this constraint
-- would reject every insert. Relax it if (and only if) the column exists. The
-- column and its data are left in place; nothing is dropped.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'mcp_tool_call'
      and column_name = 'tool_name'
  ) then
    execute 'alter table public.mcp_tool_call alter column tool_name drop not null';
  end if;
end
$$;

create index if not exists mcp_tool_call_session_time_idx
  on public.mcp_tool_call (session_id, time);

create index if not exists mcp_tool_call_tool_time_idx
  on public.mcp_tool_call (tool, time desc);

create index if not exists mcp_tool_call_user_time_idx
  on public.mcp_tool_call (user_id, time desc);

-- ============================ access control ============================

-- Strict union of both originals' intent: RLS on (20260629), anon/authenticated
-- revoked and service_role granted (20260702), plus an explicit service_role
-- full policy. service_role bypasses RLS in Supabase; the explicit policy keeps
-- server access working regardless of that configuration. All statements are
-- idempotent.
alter table public.mcp_session enable row level security;
alter table public.mcp_tool_call enable row level security;

revoke all on table public.mcp_session from anon, authenticated;
revoke all on table public.mcp_tool_call from anon, authenticated;

grant select, insert, update, delete on table public.mcp_session to service_role;
grant select, insert, update, delete on table public.mcp_tool_call to service_role;

drop policy if exists mcp_session_service_role_all on public.mcp_session;
create policy mcp_session_service_role_all
on public.mcp_session
for all
to service_role
using (true)
with check (true);

drop policy if exists mcp_tool_call_service_role_all on public.mcp_tool_call;
create policy mcp_tool_call_service_role_all
on public.mcp_tool_call
for all
to service_role
using (true)
with check (true);

-- Note: public.mcp_evaluation (created only by the 20260629 file, never read by
-- the application) is intentionally left untouched. It may or may not exist in a
-- given project; dropping it would be a destructive change to a data-bearing
-- table for no functional gain, so this migration neither requires nor removes
-- it. Remove it later in a dedicated migration only after confirming prod has no
-- rows worth keeping.
