-- Decision Graph, Phase 1 (P0): per-meeting structured decisions, actions, issues and
-- normalized entities, extracted from the FULL transcript after a note is finalized.
-- Design note: docs/decision-graph.md. Reference schema: the 2026-11-01 handoff schema.sql.
--
-- Safe to apply ahead of the code: nothing writes these tables unless the backend runs with
-- DECISION_GRAPH_ENABLED=true. Adds tables only; no existing table or policy is altered.
--
-- Visibility (handoff rule 4):
--   * A meeting record is readable exactly when its parent note is readable by the caller.
--     The policy runs `exists (select 1 from public.note ...)` as the caller, so the note's
--     own RLS (owner, shared_users, shared project) decides; nothing is re-implemented here.
--   * sensitivity <> 'normal' (customer-commercial / financial / hr) narrows that to the note
--     owner. The handoff also allows "participants", but we have no verified participant
--     identity (Microsoft oid) per meeting yet, so this is deliberately stricter for now.
--   * Child rows (decisions, actions, issues, meeting entities) are readable when their
--     meeting record is readable, so they inherit both rules above.
--   * Clients only read. All writes go through the backend (service_role) and the
--     mn_replace_note_extraction function below. Human edits (F5) will add narrow UPDATE
--     policies in a later migration.
--
-- note.id and note.user_id are text (Microsoft 'sub'/oid), so FKs and owner columns are text.

-- --- extraction runs (one row per attempt; also the monitoring log) ---
create table if not exists public.mn_extraction_runs (
  id uuid primary key default gen_random_uuid(),
  note_id text not null references public.note(id) on delete cascade,
  user_id text not null,
  prompt_version text not null,
  model text,
  status text not null check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  input_chars int,
  output_json jsonb,
  error text,
  -- Unknown names and "alias 후보: A → B" hints from quality_notes, for curating aliases.
  alias_candidates jsonb not null default '[]'::jsonb,
  -- Monitoring: status distribution, decided ratio, evidence match rate, latency, tokens.
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists mn_extraction_runs_note_idx
  on public.mn_extraction_runs (note_id, prompt_version, created_at desc);

-- --- meeting record (1:1 with note) ---
create table if not exists public.mn_meeting_records (
  note_id text primary key references public.note(id) on delete cascade,
  user_id text not null,
  run_id uuid references public.mn_extraction_runs(id) on delete set null,
  prompt_version text,
  meeting_date date not null,
  title text,
  meeting_kind text check (meeting_kind in ('internal', 'internal-dev', 'internal-exec', 'customer', 'partner', 'vendor', 'hiring', 'out-of-scope')),
  purpose text,
  sensitivity text not null default 'normal' check (sensitivity in ('normal', 'customer-commercial', 'financial', 'hr')),
  quality text not null default 'ok' check (quality in ('ok', 'thin', 'garbled', 'summary-only')),
  quality_notes text,
  duplicate_of text,
  -- "지난번에 ~하기로 했던" mentions; the Phase 2 linking job reads these first.
  references_to_past jsonb not null default '[]'::jsonb,
  source text not null default 'llm' check (source in ('llm', 'human', 'backfill')),
  human_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mn_meeting_records_user_date_idx
  on public.mn_meeting_records (user_id, meeting_date);

-- --- normalized entities (people / orgs / projects), scoped to the note owner ---
create table if not exists public.mn_entities (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  type text not null check (type in ('person', 'org', 'project')),
  canonical_name text not null,
  aliases text[] not null default array[]::text[],
  attrs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, type, canonical_name)
);

create table if not exists public.mn_meeting_entities (
  note_id text not null references public.mn_meeting_records(note_id) on delete cascade,
  entity_id uuid not null references public.mn_entities(id) on delete cascade,
  role text not null check (role in ('participant', 'involved_org', 'about_project')),
  primary key (note_id, entity_id, role)
);

-- --- decisions ---
create table if not exists public.mn_decisions (
  id text primary key, -- 'D:<yymmdd>-<note6>-<nn>'
  note_id text not null references public.mn_meeting_records(note_id) on delete cascade,
  seq int not null,
  text text not null,
  status text not null check (status in ('decided', 'direction', 'proposed', 'deferred', 'status_report', 'info', 'customer_decided', 'customer_stated')),
  side text not null check (side in ('tecace', 'customer', 'partner')),
  decided_by text,
  participants text[] not null default array[]::text[],
  why text,
  trigger text,
  alternatives_rejected text[] not null default array[]::text[],
  assumptions text[] not null default array[]::text[],
  effective_date text,
  project text, -- canonical name, denormalized so shared readers need not read mn_entities
  project_entity_id uuid references public.mn_entities(id) on delete set null,
  evidence_quote text, -- verbatim transcript quote, or 'summary'
  evidence_segment_ids text[] not null default array[]::text[],
  evidence_match boolean, -- quote found in transcript (null when evidence is 'summary')
  valid_from date not null, -- = meeting_date
  invalid_at date, -- set by the Phase 2 linking job when superseded; rows are never deleted for that
  prompt_version text,
  source text not null default 'llm' check (source in ('llm', 'human', 'backfill')),
  human_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (note_id, seq)
);

create index if not exists mn_decisions_project_date_idx on public.mn_decisions (project_entity_id, valid_from);
create index if not exists mn_decisions_status_idx on public.mn_decisions (status);
create index if not exists mn_decisions_note_idx on public.mn_decisions (note_id);

-- --- actions ---
create table if not exists public.mn_actions (
  id text primary key, -- 'A:<yymmdd>-<note6>-<nn>'
  note_id text not null references public.mn_meeting_records(note_id) on delete cascade,
  seq int not null,
  text text not null,
  owner text,
  due text,
  from_decision text references public.mn_decisions(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'done', 'dropped')),
  evidence_quote text,
  evidence_segment_ids text[] not null default array[]::text[],
  evidence_match boolean,
  source text not null default 'llm' check (source in ('llm', 'human', 'backfill')),
  human_verified boolean not null default false,
  created_at timestamptz not null default now(),
  unique (note_id, seq)
);

create index if not exists mn_actions_note_idx on public.mn_actions (note_id);

-- --- issues / risks / open questions ---
create table if not exists public.mn_issues (
  id text primary key, -- 'I:<yymmdd>-<note6>-<nn>'
  note_id text not null references public.mn_meeting_records(note_id) on delete cascade,
  seq int not null,
  text text not null,
  type text not null check (type in ('issue', 'risk', 'open_question')),
  raised_by text,
  evidence_quote text,
  evidence_segment_ids text[] not null default array[]::text[],
  evidence_match boolean,
  source text not null default 'llm' check (source in ('llm', 'human', 'backfill')),
  human_verified boolean not null default false,
  created_at timestamptz not null default now(),
  unique (note_id, seq)
);

create index if not exists mn_issues_note_idx on public.mn_issues (note_id);

-- --- cross-meeting decision links (written by the Phase 2 linking job) ---
create table if not exists public.mn_decision_links (
  new_decision text not null references public.mn_decisions(id) on delete cascade,
  old_decision text not null references public.mn_decisions(id) on delete cascade,
  rel text not null check (rel in ('supersedes', 'revises', 'refines', 'confirms', 'resolves', 'conflicts_with')),
  confidence real,
  reason text,
  source text not null default 'llm' check (source in ('llm', 'human', 'backfill')),
  reviewed boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (new_decision, old_decision, rel)
);

create index if not exists mn_decision_links_old_idx on public.mn_decision_links (old_decision);

-- --- RLS ---
alter table public.mn_extraction_runs enable row level security;
alter table public.mn_meeting_records enable row level security;
alter table public.mn_entities enable row level security;
alter table public.mn_meeting_entities enable row level security;
alter table public.mn_decisions enable row level security;
alter table public.mn_actions enable row level security;
alter table public.mn_issues enable row level security;
alter table public.mn_decision_links enable row level security;

grant select on public.mn_extraction_runs, public.mn_meeting_records, public.mn_entities,
  public.mn_meeting_entities, public.mn_decisions, public.mn_actions, public.mn_issues,
  public.mn_decision_links to authenticated;
grant select, insert, update, delete on public.mn_extraction_runs, public.mn_meeting_records,
  public.mn_entities, public.mn_meeting_entities, public.mn_decisions, public.mn_actions,
  public.mn_issues, public.mn_decision_links to service_role;

-- Runs hold the raw model output, so only the note owner reads them.
drop policy if exists mn_extraction_runs_owner_select on public.mn_extraction_runs;
create policy mn_extraction_runs_owner_select on public.mn_extraction_runs
for select to authenticated
using (user_id = auth.jwt() ->> 'sub');

drop policy if exists mn_meeting_records_note_select on public.mn_meeting_records;
create policy mn_meeting_records_note_select on public.mn_meeting_records
for select to authenticated
using (
  exists (select 1 from public.note n where n.id = mn_meeting_records.note_id)
  and (sensitivity = 'normal' or user_id = auth.jwt() ->> 'sub')
);

drop policy if exists mn_entities_owner_select on public.mn_entities;
create policy mn_entities_owner_select on public.mn_entities
for select to authenticated
using (user_id = auth.jwt() ->> 'sub');

drop policy if exists mn_meeting_entities_record_select on public.mn_meeting_entities;
create policy mn_meeting_entities_record_select on public.mn_meeting_entities
for select to authenticated
using (exists (select 1 from public.mn_meeting_records r where r.note_id = mn_meeting_entities.note_id));

drop policy if exists mn_decisions_record_select on public.mn_decisions;
create policy mn_decisions_record_select on public.mn_decisions
for select to authenticated
using (exists (select 1 from public.mn_meeting_records r where r.note_id = mn_decisions.note_id));

drop policy if exists mn_actions_record_select on public.mn_actions;
create policy mn_actions_record_select on public.mn_actions
for select to authenticated
using (exists (select 1 from public.mn_meeting_records r where r.note_id = mn_actions.note_id));

drop policy if exists mn_issues_record_select on public.mn_issues;
create policy mn_issues_record_select on public.mn_issues
for select to authenticated
using (exists (select 1 from public.mn_meeting_records r where r.note_id = mn_issues.note_id));

-- A link is visible only when the caller can see BOTH decisions.
drop policy if exists mn_decision_links_both_select on public.mn_decision_links;
create policy mn_decision_links_both_select on public.mn_decision_links
for select to authenticated
using (
  exists (select 1 from public.mn_decisions d where d.id = mn_decision_links.new_decision)
  and exists (select 1 from public.mn_decisions d where d.id = mn_decision_links.old_decision)
);

do $$
declare t text;
begin
  foreach t in array array['mn_extraction_runs', 'mn_meeting_records', 'mn_entities', 'mn_meeting_entities',
    'mn_decisions', 'mn_actions', 'mn_issues', 'mn_decision_links'] loop
    execute format('drop policy if exists %I on public.%I', t || '_service_role_all', t);
    execute format('create policy %I on public.%I for all to service_role using (true) with check (true)', t || '_service_role_all', t);
  end loop;
end $$;

-- --- atomic, idempotent replace of one note's extraction ---
-- Replaces the note's NON-human-verified decisions/actions/issues/entity links with a fresh
-- extraction in one transaction. Human-verified rows are never touched (handoff rule 5): new
-- rows are numbered after the highest verified seq, so ids never collide with them. A
-- human-verified meeting record keeps its fields. Re-running with the same payload yields the
-- same ids and the same rows.
--
-- p_payload shape (built by workflow-server/src/decisions/store.ts):
-- { "id_prefix": "261104-abc123", "run_id": uuid|null, "prompt_version": "...",
--   "record": { meeting_date, title, meeting_kind, purpose, sensitivity, quality,
--               quality_notes, duplicate_of, references_to_past },
--   "entities": [{ type, canonical_name, aliases[], attrs{}, role }],
--   "decisions": [{ local_id: "D-1", text, status, side, decided_by, participants[], why,
--                   trigger, alternatives_rejected[], assumptions[], effective_date, project,
--                   evidence_quote, evidence_segment_ids[], evidence_match }],
--   "actions": [{ text, owner, due, from_decision: "D-1"|null, evidence_quote,
--                 evidence_segment_ids[], evidence_match }],
--   "issues": [{ text, type, raised_by, evidence_quote, evidence_segment_ids[], evidence_match }] }
create or replace function public.mn_replace_note_extraction(p_note_id text, p_user_id text, p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_record jsonb := coalesce(p_payload -> 'record', '{}'::jsonb);
  v_prefix text := p_payload ->> 'id_prefix';
  v_date date := (v_record ->> 'meeting_date')::date;
  v_offset int;
  v_seq int;
  v_id text;
  v_map jsonb := '{}'::jsonb;
  v_item jsonb;
  v_ord bigint;
  v_entity_id uuid;
  v_project_ids jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_preserved int;
begin
  if v_prefix is null or v_prefix = '' or v_date is null then
    raise exception 'mn_replace_note_extraction: id_prefix and record.meeting_date are required';
  end if;
  if not exists (select 1 from public.note n where n.id = p_note_id and n.user_id = p_user_id) then
    raise exception 'mn_replace_note_extraction: note % is not owned by the given user', p_note_id;
  end if;

  insert into public.mn_meeting_records as r (
    note_id, user_id, run_id, prompt_version, meeting_date, title, meeting_kind, purpose,
    sensitivity, quality, quality_notes, duplicate_of, references_to_past, source, updated_at
  ) values (
    p_note_id, p_user_id, nullif(p_payload ->> 'run_id', '')::uuid, p_payload ->> 'prompt_version', v_date,
    v_record ->> 'title', v_record ->> 'meeting_kind', v_record ->> 'purpose',
    coalesce(v_record ->> 'sensitivity', 'normal'), coalesce(v_record ->> 'quality', 'ok'),
    v_record ->> 'quality_notes', v_record ->> 'duplicate_of',
    coalesce(v_record -> 'references_to_past', '[]'::jsonb), 'llm', now()
  )
  on conflict (note_id) do update set
    run_id = excluded.run_id,
    prompt_version = excluded.prompt_version,
    meeting_date = excluded.meeting_date,
    title = excluded.title,
    meeting_kind = excluded.meeting_kind,
    purpose = excluded.purpose,
    sensitivity = excluded.sensitivity,
    quality = excluded.quality,
    quality_notes = excluded.quality_notes,
    duplicate_of = excluded.duplicate_of,
    references_to_past = excluded.references_to_past,
    source = excluded.source,
    updated_at = now()
  where r.human_verified = false and r.user_id = p_user_id;

  if not exists (select 1 from public.mn_meeting_records r where r.note_id = p_note_id and r.user_id = p_user_id) then
    raise exception 'mn_replace_note_extraction: meeting record for % belongs to another user', p_note_id;
  end if;

  -- Entities: upsert (alias lists are merged), then rebuild this note's entity links.
  delete from public.mn_meeting_entities where note_id = p_note_id;
  for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'entities', '[]'::jsonb)) loop
    insert into public.mn_entities as e (user_id, type, canonical_name, aliases, attrs)
    values (
      p_user_id, v_item ->> 'type', v_item ->> 'canonical_name',
      coalesce(array(select jsonb_array_elements_text(coalesce(v_item -> 'aliases', '[]'::jsonb))), array[]::text[]),
      coalesce(v_item -> 'attrs', '{}'::jsonb)
    )
    on conflict (user_id, type, canonical_name) do update set
      aliases = array(select distinct a from unnest(e.aliases || excluded.aliases) as a where a is not null and a <> ''),
      attrs = e.attrs || excluded.attrs
    returning id into v_entity_id;
    if v_item ->> 'role' is not null then
      insert into public.mn_meeting_entities (note_id, entity_id, role)
      values (p_note_id, v_entity_id, v_item ->> 'role')
      on conflict do nothing;
    end if;
    if v_item ->> 'type' = 'project' then
      v_project_ids := v_project_ids || jsonb_build_object(v_item ->> 'canonical_name', v_entity_id);
    end if;
  end loop;

  -- Actions first (they reference decisions), then issues, then decisions.
  delete from public.mn_actions where note_id = p_note_id and human_verified = false;
  delete from public.mn_issues where note_id = p_note_id and human_verified = false;
  delete from public.mn_decisions where note_id = p_note_id and human_verified = false;

  select count(*) into v_preserved from public.mn_decisions where note_id = p_note_id;

  select coalesce(max(seq), 0) into v_offset from public.mn_decisions where note_id = p_note_id;
  for v_item, v_ord in select value, ordinality from jsonb_array_elements(coalesce(p_payload -> 'decisions', '[]'::jsonb)) with ordinality loop
    v_seq := v_offset + v_ord::int;
    v_id := 'D:' || v_prefix || '-' || lpad(v_seq::text, greatest(2, length(v_seq::text)), '0');
    if v_item ->> 'local_id' is not null then
      v_map := v_map || jsonb_build_object(v_item ->> 'local_id', v_id);
    end if;
    insert into public.mn_decisions (
      id, note_id, seq, text, status, side, decided_by, participants, why, trigger,
      alternatives_rejected, assumptions, effective_date, project, project_entity_id,
      evidence_quote, evidence_segment_ids, evidence_match, valid_from, prompt_version, source
    ) values (
      v_id, p_note_id, v_seq, v_item ->> 'text', v_item ->> 'status', v_item ->> 'side',
      v_item ->> 'decided_by',
      coalesce(array(select jsonb_array_elements_text(coalesce(v_item -> 'participants', '[]'::jsonb))), array[]::text[]),
      v_item ->> 'why', v_item ->> 'trigger',
      coalesce(array(select jsonb_array_elements_text(coalesce(v_item -> 'alternatives_rejected', '[]'::jsonb))), array[]::text[]),
      coalesce(array(select jsonb_array_elements_text(coalesce(v_item -> 'assumptions', '[]'::jsonb))), array[]::text[]),
      v_item ->> 'effective_date', v_item ->> 'project',
      nullif(v_project_ids ->> coalesce(v_item ->> 'project', ''), '')::uuid,
      v_item ->> 'evidence_quote',
      coalesce(array(select jsonb_array_elements_text(coalesce(v_item -> 'evidence_segment_ids', '[]'::jsonb))), array[]::text[]),
      (v_item ->> 'evidence_match')::boolean, v_date, p_payload ->> 'prompt_version', 'llm'
    );
  end loop;
  v_counts := v_counts || jsonb_build_object('decisions', jsonb_array_length(coalesce(p_payload -> 'decisions', '[]'::jsonb)));

  select coalesce(max(seq), 0) into v_offset from public.mn_actions where note_id = p_note_id;
  for v_item, v_ord in select value, ordinality from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) with ordinality loop
    v_seq := v_offset + v_ord::int;
    insert into public.mn_actions (
      id, note_id, seq, text, owner, due, from_decision, evidence_quote, evidence_segment_ids, evidence_match, source
    ) values (
      'A:' || v_prefix || '-' || lpad(v_seq::text, greatest(2, length(v_seq::text)), '0'),
      p_note_id, v_seq, v_item ->> 'text', v_item ->> 'owner', v_item ->> 'due',
      v_map ->> coalesce(v_item ->> 'from_decision', ''),
      v_item ->> 'evidence_quote',
      coalesce(array(select jsonb_array_elements_text(coalesce(v_item -> 'evidence_segment_ids', '[]'::jsonb))), array[]::text[]),
      (v_item ->> 'evidence_match')::boolean, 'llm'
    );
  end loop;
  v_counts := v_counts || jsonb_build_object('actions', jsonb_array_length(coalesce(p_payload -> 'actions', '[]'::jsonb)));

  select coalesce(max(seq), 0) into v_offset from public.mn_issues where note_id = p_note_id;
  for v_item, v_ord in select value, ordinality from jsonb_array_elements(coalesce(p_payload -> 'issues', '[]'::jsonb)) with ordinality loop
    v_seq := v_offset + v_ord::int;
    insert into public.mn_issues (
      id, note_id, seq, text, type, raised_by, evidence_quote, evidence_segment_ids, evidence_match, source
    ) values (
      'I:' || v_prefix || '-' || lpad(v_seq::text, greatest(2, length(v_seq::text)), '0'),
      p_note_id, v_seq, v_item ->> 'text', v_item ->> 'type', v_item ->> 'raised_by',
      v_item ->> 'evidence_quote',
      coalesce(array(select jsonb_array_elements_text(coalesce(v_item -> 'evidence_segment_ids', '[]'::jsonb))), array[]::text[]),
      (v_item ->> 'evidence_match')::boolean, 'llm'
    );
  end loop;
  v_counts := v_counts || jsonb_build_object('issues', jsonb_array_length(coalesce(p_payload -> 'issues', '[]'::jsonb)));

  return v_counts || jsonb_build_object('preserved_verified_decisions', v_preserved);
end;
$$;

revoke all on function public.mn_replace_note_extraction(text, text, jsonb) from public;
revoke all on function public.mn_replace_note_extraction(text, text, jsonb) from anon, authenticated;
grant execute on function public.mn_replace_note_extraction(text, text, jsonb) to service_role;
