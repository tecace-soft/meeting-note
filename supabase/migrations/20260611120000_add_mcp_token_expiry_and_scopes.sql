alter table public.mcp_token
  add column if not exists expires_at timestamptz,
  add column if not exists scopes text[] not null default array['notes:metadata', 'notes:summary', 'notes:transcript']::text[];

update public.mcp_token
set scopes = array['notes:metadata', 'notes:summary', 'notes:transcript']::text[]
where scopes is null or scopes = '{}'::text[];

update public.mcp_token
set expires_at = now() + interval '90 days'
where expires_at is null and revoked_at is null;

create index if not exists mcp_token_active_expiry_idx
  on public.mcp_token (expires_at)
  where revoked_at is null;
