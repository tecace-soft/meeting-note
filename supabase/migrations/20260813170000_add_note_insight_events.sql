-- F4 refinement (boss 2026-08-13): index the general cause->effect chains, not only
-- firm decisions, so reverse "what did I do / what happened" queries resolve. This is
-- the searchable-index counterpart of the F1' memory narrative layer.
--
-- Additive only: one nullable-with-default jsonb column. Existing rows get '[]' and
-- keep working; no drop/rewrite. events shape: [{ "cause": "", "effect": "" }].
alter table public.note_insight
  add column if not exists events jsonb not null default '[]'::jsonb;

-- Refresh PostgREST schema cache so the new column is visible to the API immediately.
notify pgrst, 'reload schema';
