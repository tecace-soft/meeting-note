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

create index if not exists mcp_tool_call_session_time_idx
  on public.mcp_tool_call (session_id, time);

create index if not exists mcp_tool_call_tool_time_idx
  on public.mcp_tool_call (tool, time desc);

create index if not exists mcp_tool_call_user_time_idx
  on public.mcp_tool_call (user_id, time desc);

revoke all on table public.mcp_session from anon, authenticated;
revoke all on table public.mcp_tool_call from anon, authenticated;

grant select, insert, update, delete on table public.mcp_session to service_role;
grant select, insert, update, delete on table public.mcp_tool_call to service_role;
