-- F4 (metadata index layer) — alpha: keyword search + structured per-note insights.
-- Scope for this migration: pg_trgm keyword indexes over the existing note text
-- columns (covers the whole corpus immediately, no per-note processing), plus a
-- `note_insight` table holding one structured-extraction row per note. The
-- extraction is produced at summary time by the same LLM call that folds F1'
-- memory (integrated), and backfilled for existing notes as a fast-follow.
--
-- DEFERRED to the vector phase (see OPS_BACKLOG F4): note_chunk (speaker-turn
-- chunking) and pgvector semantic search. Keyword (pg_trgm) + structured
-- (note_insight) covers the four query types well enough for the alpha without
-- chunking, since keyword search runs directly on the note columns.

-- --- keyword search: trigram indexes over note text (whole corpus, immediate) ---
create extension if not exists pg_trgm;

create index if not exists note_name_trgm_idx
  on public.note using gin (name gin_trgm_ops);
create index if not exists note_summary_trgm_idx
  on public.note using gin (summary gin_trgm_ops);
create index if not exists note_summary_edit_trgm_idx
  on public.note using gin (summary_edit gin_trgm_ops);
create index if not exists note_transcription_trgm_idx
  on public.note using gin (transcription gin_trgm_ops);

-- --- structured per-note insights ---
-- One row per note. note.id and note.user_id are text (Microsoft 'sub'/oid),
-- so the FK and owner column are text to match. Structured fields are jsonb/array
-- so the extractor owns the exact contents without further migrations.
--   actions:   [{ "text", "owner", "due", "status" }]
--   decisions: [{ "text", "rationale" }]
--   topics/people/companies: text[]
create table if not exists public.note_insight (
  note_id text primary key references public.note(id) on delete cascade,
  user_id text not null,
  actions jsonb not null default '[]'::jsonb,
  decisions jsonb not null default '[]'::jsonb,
  topics text[] not null default array[]::text[],
  people text[] not null default array[]::text[],
  companies text[] not null default array[]::text[],
  source_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists note_insight_user_idx on public.note_insight (user_id);
create index if not exists note_insight_topics_idx on public.note_insight using gin (topics);
create index if not exists note_insight_people_idx on public.note_insight using gin (people);
create index if not exists note_insight_companies_idx on public.note_insight using gin (companies);

alter table public.note_insight enable row level security;

grant select, insert, update, delete on public.note_insight to authenticated;

-- Owner isolation, mirroring user_memory / speaker / project (user_id = the
-- Microsoft 'sub' claim on the app JWT). Shared-note access is a follow-on; the
-- MCP server reads via service_role, so search is not gated by this policy.
drop policy if exists note_insight_owner_all on public.note_insight;
create policy note_insight_owner_all
on public.note_insight
for all
to authenticated
using (user_id = auth.jwt() ->> 'sub')
with check (user_id = auth.jwt() ->> 'sub');

drop policy if exists note_insight_service_role_all on public.note_insight;
create policy note_insight_service_role_all
on public.note_insight
for all
to service_role
using (true)
with check (true);
