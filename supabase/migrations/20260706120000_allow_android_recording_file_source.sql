alter table public.file
  drop constraint if exists file_source_check;

alter table public.file
  add constraint file_source_check
  check (source in ('upload', 'recording', 'android_recording'));
