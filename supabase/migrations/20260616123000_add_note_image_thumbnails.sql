alter table public.note_image
  add column if not exists thumbnail_storage_path text,
  add column if not exists thumbnail_mime_type text,
  add column if not exists thumbnail_size_bytes bigint,
  add column if not exists thumbnail_width integer,
  add column if not exists thumbnail_height integer;
