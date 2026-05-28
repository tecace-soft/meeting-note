create table if not exists public.app_user (
  microsoft_id text primary key,
  display_name text not null default 'User',
  email text not null default '',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists app_user_last_seen_at_idx
  on public.app_user (last_seen_at desc);

create index if not exists app_user_email_idx
  on public.app_user (lower(email));

do $$
begin
  if to_regclass('public.note') is not null then
    insert into public.app_user (microsoft_id, display_name, email, first_seen_at, last_seen_at)
    select
      user_id,
      coalesce(nullif(max(user_name), ''), 'Unknown user') as display_name,
      '',
      min(created_at),
      max(created_at)
    from public.note
    where user_id is not null and user_id <> ''
    group by user_id
    on conflict (microsoft_id) do nothing;
  end if;

  if to_regclass('public.speaker') is not null then
    insert into public.app_user (microsoft_id, display_name, email)
    select distinct user_id, 'Unknown user', ''
    from public.speaker
    where user_id is not null and user_id <> ''
    on conflict (microsoft_id) do nothing;
  end if;

  if to_regclass('public.file') is not null then
    insert into public.app_user (microsoft_id, display_name, email)
    select distinct user_id, 'Unknown user', ''
    from public.file
    where user_id is not null and user_id <> ''
    on conflict (microsoft_id) do nothing;
  end if;

  if to_regclass('public.project') is not null then
    insert into public.app_user (microsoft_id, display_name, email)
    select distinct user_id, 'Unknown user', ''
    from public.project
    where user_id is not null and user_id <> ''
    on conflict (microsoft_id) do nothing;
  end if;
end $$;
