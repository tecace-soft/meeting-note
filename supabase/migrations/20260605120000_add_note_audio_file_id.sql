alter table public.note
  add column if not exists audio_file_id uuid references public.file(id) on delete set null;

create index if not exists note_audio_file_id_idx
  on public.note (audio_file_id);
