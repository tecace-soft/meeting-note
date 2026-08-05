-- F1c: per-user personal memory — a durable, reusable, view-agnostic context
-- base aggregated across ALL of a user's meetings (distinct from the per-speaker
-- "self" profile, which only captures what the user personally said).
--
-- Design: ONE row per user. The structured base lives in a single `memory` jsonb
-- column (not fixed per-category columns) so new categories can be added without
-- a migration and future consumers (a Memory screen, series analysis, export)
-- read the same base. Mirrors the speaker.profile "one column holds the ontology"
-- approach and the guiding principle that the store is the primary asset.
--
-- Shape of `memory` (all optional, each item carries source/confidence like the
-- speaker ontology; the merge engine owns the exact contents):
--   {
--     "open_action_items": [{ "text", "assigned_by", "source_note_id", "confidence" }],
--     "collaborators":      [{ "name", "speaker_id", "meeting_count", "last_seen", "confidence" }],
--     "active_projects":    [{ "name", "status", "confidence" }],
--     "recurring_topics":   [{ "topic", "confidence" }]
--   }
--
-- `processed_note_ids` gives durable per-note dedup so the same note is never
-- merged twice (stronger than F1a's in-session-only dedup).

create table if not exists public.user_memory (
  user_id text primary key,
  memory jsonb not null default '{}'::jsonb,
  processed_note_ids text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_memory enable row level security;

grant select, insert, update, delete on public.user_memory to authenticated;

-- Owner isolation: a user may only read/write their own row. Mirrors the
-- speaker/project/file policies (user_id = the Microsoft 'sub' claim on the app JWT).
drop policy if exists user_memory_owner_all on public.user_memory;
create policy user_memory_owner_all
on public.user_memory
for all
to authenticated
using (user_id = auth.jwt() ->> 'sub')
with check (user_id = auth.jwt() ->> 'sub');

-- Service role bypass (parity with the other tables; lets a trusted backend/edge
-- function maintain the base if we later move the write off the client).
drop policy if exists user_memory_service_role_all on public.user_memory;
create policy user_memory_service_role_all
on public.user_memory
for all
to service_role
using (true)
with check (true);
