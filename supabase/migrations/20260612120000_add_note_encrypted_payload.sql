alter table public.note
  add column if not exists encrypted_payload jsonb,
  add column if not exists encryption_version integer not null default 0,
  add column if not exists encryption_algorithm text,
  add column if not exists encrypted_at timestamptz;

create index if not exists note_encryption_version_idx
  on public.note (encryption_version);

notify pgrst, 'reload schema';
