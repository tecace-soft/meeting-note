create table if not exists public.file (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  bucket text not null default 'meeting-recordings',
  storage_path text not null,
  public_url text not null,
  mime_type text,
  size_bytes bigint,
  source text not null default 'upload' check (source in ('upload', 'recording')),
  created_at timestamptz not null default now()
);

create index if not exists file_user_created_at_idx
  on public.file (user_id, created_at desc);

create index if not exists file_user_name_idx
  on public.file (user_id, name);
