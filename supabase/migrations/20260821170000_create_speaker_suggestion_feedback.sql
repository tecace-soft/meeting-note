-- Speaker-suggestion feedback loop (Stage 0): capture every human speaker decision as
-- ground truth (what the model SUGGESTED vs what the human CHOSE) so we can
--   Stage 1: measure suggestion accuracy over time via the F8 eval harness, and
--   Stage 2: feed confirmed identities back into the speaker roster/ontology.
-- This is the feasible, measurable form of the "recursive training" ask: we do NOT train
-- model weights (hosted Gemini, lite-only cost cap); the system improves via a DATA loop.
-- Append-only. user_id is the Microsoft 'sub' claim on the app JWT (same as user_memory).

create table if not exists public.speaker_suggestion_feedback (
  id                    uuid primary key default gen_random_uuid(),
  user_id               text not null,        -- Microsoft 'sub' claim on the app JWT
  note_id               uuid,                 -- meeting note (nullable)
  label                 text not null,        -- anonymous diarization label, e.g. "Speaker C"
  suggested_name        text,                 -- what identify-speakers proposed (null = no suggestion was shown)
  suggested_speaker_id  text,
  suggested_confidence  double precision,
  suggested_is_self     boolean,
  chosen_name           text not null,        -- the identity the human actually set
  chosen_speaker_id     text,
  outcome               text not null,        -- accepted | overridden | manual
  source                text not null,        -- suggest_sheet | manual_rename
  client                text,                 -- web | mobile
  created_at            timestamptz not null default now()
);

create index if not exists idx_ssf_user on public.speaker_suggestion_feedback(user_id, created_at desc);
create index if not exists idx_ssf_note on public.speaker_suggestion_feedback(note_id);
create index if not exists idx_ssf_outcome on public.speaker_suggestion_feedback(outcome);

alter table public.speaker_suggestion_feedback enable row level security;
grant select, insert on public.speaker_suggestion_feedback to authenticated;

-- Owner isolation: a user may only read/insert their own feedback rows (append-only,
-- no update/delete grant). Mirrors user_memory's owner policy.
drop policy if exists ssf_owner_select on public.speaker_suggestion_feedback;
create policy ssf_owner_select
on public.speaker_suggestion_feedback
for select to authenticated
using (user_id = auth.jwt() ->> 'sub');

drop policy if exists ssf_owner_insert on public.speaker_suggestion_feedback;
create policy ssf_owner_insert
on public.speaker_suggestion_feedback
for insert to authenticated
with check (user_id = auth.jwt() ->> 'sub');

-- Service role bypass: the eval harness / workflow-server reads all rows to compute the
-- accuracy trend and (later) fold confirmed identities into the roster.
drop policy if exists ssf_service_role_all on public.speaker_suggestion_feedback;
create policy ssf_service_role_all
on public.speaker_suggestion_feedback
for all to service_role
using (true) with check (true);

-- Refresh PostgREST schema cache so the new table is visible immediately.
notify pgrst, 'reload schema';
