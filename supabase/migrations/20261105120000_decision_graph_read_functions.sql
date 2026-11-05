-- Decision Graph, Phase 2 / M1: read functions for the MCP tools (docs/decision-graph-mcp-plan.md).
-- The MCP server reads with service_role, which bypasses RLS, so visibility must be applied
-- explicitly. These functions apply exactly the app's rule:
--   * the note is visible to the user: owner, in note.shared_users, or in a project the note's
--     owner shared with the user (same predicate as the note_owner_select policy), AND
--   * the meeting record is normal sensitivity, or the user owns the note (mn_meeting_records
--     policy).
-- decision-graph-sql.test.ts checks mn_user_can_view_note against the live note RLS policy for
-- every fixture user, so a change to one without the other fails the test.
-- Executable by service_role only. Additive: no table or policy changes.

create or replace function public.mn_user_can_view_note(p_user_id text, p_note_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_user_id, '') <> '' and exists (
    select 1
    from public.note n
    where n.id = p_note_id
      and (
        n.user_id = p_user_id
        or coalesce(n.shared_users, array[]::text[]) @> array[p_user_id]
        or exists (
          select 1
          from public.project p
          where p.user_id = n.user_id
            and coalesce(p.shared_users, array[]::text[]) @> array[p_user_id]
            and n.projects is not null
            and exists (select 1 from unnest(n.projects) as project_id where project_id::text = p.id::text)
        )
      )
  );
$$;

create or replace function public.mn_user_can_view_record(p_user_id text, p_note_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.mn_user_can_view_note(p_user_id, p_note_id)
    and exists (
      select 1 from public.mn_meeting_records r
      where r.note_id = p_note_id and (r.sensitivity = 'normal' or r.user_id = p_user_id)
    );
$$;

-- Decisions visible to the user, with optional filters. Text filters are ILIKE patterns
-- (the caller escapes % and _). Ordered newest meeting first. total_count is the count before
-- limit/offset. limit is clamped to 1..50.
create or replace function public.mn_visible_decisions(
  p_user_id text,
  p_note_ids text[] default null,
  p_statuses text[] default null,
  p_from date default null,
  p_to date default null,
  p_person text default null,
  p_project text default null,
  p_query text default null,
  p_decision_ids text[] default null,
  p_include_superseded boolean default false,
  p_limit int default 20,
  p_offset int default 0
)
returns table (
  id text, note_id text, seq int, text text, status text, side text, decided_by text,
  participants text[], why text, trigger text, alternatives_rejected text[], assumptions text[],
  effective_date text, project text, evidence_quote text, evidence_segment_ids text[],
  evidence_match boolean, valid_from date, invalid_at date, human_verified boolean,
  meeting_title text, meeting_kind text, sensitivity text, total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.note_id, d.seq, d.text, d.status, d.side, d.decided_by, d.participants, d.why,
    d.trigger, d.alternatives_rejected, d.assumptions, d.effective_date, d.project, d.evidence_quote,
    d.evidence_segment_ids, d.evidence_match, d.valid_from, d.invalid_at, d.human_verified,
    r.title, r.meeting_kind, r.sensitivity, count(*) over ()
  from public.mn_decisions d
  join public.mn_meeting_records r on r.note_id = d.note_id
  where public.mn_user_can_view_note(p_user_id, d.note_id)
    and (r.sensitivity = 'normal' or r.user_id = p_user_id)
    and (p_note_ids is null or d.note_id = any(p_note_ids))
    and (p_statuses is null or d.status = any(p_statuses))
    and (p_from is null or d.valid_from >= p_from)
    and (p_to is null or d.valid_from <= p_to)
    and (p_decision_ids is null or d.id = any(p_decision_ids))
    and (p_include_superseded or d.invalid_at is null)
    and (p_person is null or d.decided_by ilike p_person
         or exists (select 1 from unnest(d.participants) x where x ilike p_person))
    and (p_project is null or d.project ilike p_project
         or exists (select 1 from public.mn_entities e
                    where e.id = d.project_entity_id
                      and (e.canonical_name ilike p_project
                           or exists (select 1 from unnest(e.aliases) a where a ilike p_project))))
    and (p_query is null or d.text ilike p_query or coalesce(d.why, '') ilike p_query)
  order by d.valid_from desc, d.note_id, d.seq
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Actions on visible meetings, optionally only those derived from given decisions.
create or replace function public.mn_visible_actions(p_user_id text, p_decision_ids text[] default null, p_note_ids text[] default null)
returns table (id text, note_id text, text text, owner text, due text, from_decision text, status text, evidence_quote text, evidence_match boolean, human_verified boolean)
language sql
stable
security definer
set search_path = public
as $$
  select a.id, a.note_id, a.text, a.owner, a.due, a.from_decision, a.status, a.evidence_quote, a.evidence_match, a.human_verified
  from public.mn_actions a
  where public.mn_user_can_view_record(p_user_id, a.note_id)
    and (p_decision_ids is null or a.from_decision = any(p_decision_ids))
    and (p_note_ids is null or a.note_id = any(p_note_ids))
  order by a.note_id, a.seq
  limit 200;
$$;

-- Links where BOTH decisions are visible to the user.
create or replace function public.mn_visible_links(p_user_id text, p_decision_ids text[])
returns table (new_decision text, old_decision text, rel text, confidence real, reason text, reviewed boolean)
language sql
stable
security definer
set search_path = public
as $$
  select l.new_decision, l.old_decision, l.rel, l.confidence, l.reason, l.reviewed
  from public.mn_decision_links l
  join public.mn_decisions dn on dn.id = l.new_decision
  join public.mn_decisions dold on dold.id = l.old_decision
  where (l.new_decision = any(p_decision_ids) or l.old_decision = any(p_decision_ids))
    and public.mn_user_can_view_record(p_user_id, dn.note_id)
    and public.mn_user_can_view_record(p_user_id, dold.note_id)
  limit 200;
$$;

-- How many meetings (optionally among given notes) have decision data visible to the user.
create or replace function public.mn_visible_record_count(p_user_id text, p_note_ids text[] default null)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from public.mn_meeting_records r
  where public.mn_user_can_view_note(p_user_id, r.note_id)
    and (r.sensitivity = 'normal' or r.user_id = p_user_id)
    and (p_note_ids is null or r.note_id = any(p_note_ids));
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.mn_user_can_view_note(text, text)',
    'public.mn_user_can_view_record(text, text)',
    'public.mn_visible_decisions(text, text[], text[], date, date, text, text, text, text[], boolean, int, int)',
    'public.mn_visible_actions(text, text[], text[])',
    'public.mn_visible_links(text, text[])',
    'public.mn_visible_record_count(text, text[])'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
