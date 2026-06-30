create table if not exists public.mcp_session (
  id uuid primary key default gen_random_uuid(),
  request_id text not null,
  user_id text,
  user_hash text,
  microsoft_user_id text,
  microsoft_email text,
  endpoint text,
  platform text,
  auth_mode text,
  method text,
  path text,
  user_agent text,
  client_ip text,
  status text not null default 'started',
  status_code integer,
  duration_ms integer,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists mcp_session_started_at_idx
  on public.mcp_session (started_at desc);

create index if not exists mcp_session_user_id_idx
  on public.mcp_session (user_id, started_at desc);

create index if not exists mcp_session_platform_idx
  on public.mcp_session (platform, started_at desc);

create table if not exists public.mcp_tool_call (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.mcp_session(id) on delete set null,
  request_id text,
  user_id text,
  user_hash text,
  tool_name text not null,
  arguments_preview jsonb,
  result_preview text,
  result_content_type text,
  is_error boolean not null default false,
  error_message text,
  duration_ms integer,
  started_at timestamptz not null default now(),
  completed_at timestamptz not null default now()
);

create index if not exists mcp_tool_call_started_at_idx
  on public.mcp_tool_call (started_at desc);

create index if not exists mcp_tool_call_tool_name_idx
  on public.mcp_tool_call (tool_name, started_at desc);

create index if not exists mcp_tool_call_session_id_idx
  on public.mcp_tool_call (session_id);

create table if not exists public.mcp_evaluation (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.mcp_session(id) on delete cascade,
  tool_call_id uuid references public.mcp_tool_call(id) on delete cascade,
  reviewed_by text,
  rating text,
  correct_tool boolean,
  wrong_tool boolean,
  insufficient_data boolean,
  bad_response boolean,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mcp_evaluation_session_id_idx
  on public.mcp_evaluation (session_id);

create index if not exists mcp_evaluation_tool_call_id_idx
  on public.mcp_evaluation (tool_call_id);

alter table public.mcp_session enable row level security;
alter table public.mcp_tool_call enable row level security;
alter table public.mcp_evaluation enable row level security;

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

drop policy if exists mcp_evaluation_service_role_all on public.mcp_evaluation;
create policy mcp_evaluation_service_role_all
on public.mcp_evaluation
for all
to service_role
using (true)
with check (true);
