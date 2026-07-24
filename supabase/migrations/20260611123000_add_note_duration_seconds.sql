alter table public.note
  add column if not exists duration_seconds double precision;

notify pgrst, 'reload schema';
