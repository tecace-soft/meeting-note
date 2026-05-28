create table if not exists public.mcp_token (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null default 'Claude Desktop',
  token_hash text not null unique,
  token_prefix text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mcp_token_user_created_at_idx
  on public.mcp_token (user_id, created_at desc);

create index if not exists mcp_token_active_hash_idx
  on public.mcp_token (token_hash)
  where revoked_at is null;
