alter table public.speaker
  add column if not exists email text,
  add column if not exists microsoft_id text;

create index if not exists speaker_user_email_idx
  on public.speaker (user_id, lower(email))
  where email is not null;

create unique index if not exists speaker_user_microsoft_id_unique_idx
  on public.speaker (user_id, microsoft_id)
  where microsoft_id is not null;
