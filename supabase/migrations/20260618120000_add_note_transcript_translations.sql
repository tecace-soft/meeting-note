alter table public.note
  add column if not exists transcription_language text,
  add column if not exists transcription_translations jsonb not null default '{}'::jsonb,
  add column if not exists diarization_translations jsonb not null default '{}'::jsonb;

