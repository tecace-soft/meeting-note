alter table public.note
  add column if not exists summary_translations jsonb not null default '{}'::jsonb;

