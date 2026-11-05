-- Decision Graph, Phase 2 / M2: cross-meeting decision links (Job B, Prompt B).
-- docs/decision-graph-mcp-plan.md §3 (M2). Additive.
--   * mn_meeting_records.linked_version / linked_at: which linking version last processed a note,
--     so the linking backfill is idempotent per version.
--   * mn_apply_decision_links: atomically replaces the LLM links whose NEW side is in one note,
--     inserts the validated new ones, and recomputes invalid_at for every affected older decision
--     (invalid_at = earliest valid_from among decisions that supersede it; NULL if none remain).
--     Rows are never deleted for supersession; only invalid_at changes (bi-temporal, rule 3).
--     Human-made or reviewed links are never touched. service_role only.

alter table public.mn_meeting_records add column if not exists linked_version text;
alter table public.mn_meeting_records add column if not exists linked_at timestamptz;

-- p_links: [{ "new": "<decision id in p_note_id>", "old": "<decision id>", "rel": "...",
--             "confidence": 0.0-1.0, "reason": "..." }]
-- A link is accepted only if: new belongs to p_note_id; old belongs to ANOTHER note owned by the
-- same user; old.valid_from <= new.valid_from; rel is one of the six relations; confidence >= 0.7.
create or replace function public.mn_apply_decision_links(p_user_id text, p_note_id text, p_version text, p_links jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item jsonb;
  v_new public.mn_decisions%rowtype;
  v_old public.mn_decisions%rowtype;
  v_affected text[] := array[]::text[];
  v_inserted int := 0;
  v_rejected int := 0;
  v_conf real;
begin
  if not exists (
    select 1 from public.mn_meeting_records r
    join public.note n on n.id = r.note_id
    where r.note_id = p_note_id and r.user_id = p_user_id and n.user_id = p_user_id
  ) then
    raise exception 'mn_apply_decision_links: note % has no meeting record owned by the given user', p_note_id;
  end if;

  -- Old decisions whose invalid_at may change because this note's previous LLM links go away.
  select coalesce(array_agg(distinct l.old_decision), array[]::text[]) into v_affected
  from public.mn_decision_links l
  join public.mn_decisions d on d.id = l.new_decision
  where d.note_id = p_note_id and l.source = 'llm' and l.reviewed = false;

  delete from public.mn_decision_links l
  using public.mn_decisions d
  where l.new_decision = d.id and d.note_id = p_note_id and l.source = 'llm' and l.reviewed = false;

  for v_item in select value from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    select * into v_new from public.mn_decisions where id = v_item ->> 'new';
    select * into v_old from public.mn_decisions where id = v_item ->> 'old';
    v_conf := nullif(v_item ->> 'confidence', '')::real;
    if v_new.id is null or v_old.id is null
       or v_new.note_id <> p_note_id
       or v_old.note_id = p_note_id
       or not exists (select 1 from public.mn_meeting_records r where r.note_id = v_old.note_id and r.user_id = p_user_id)
       or v_old.valid_from > v_new.valid_from
       or coalesce(v_item ->> 'rel', '') not in ('supersedes', 'revises', 'refines', 'confirms', 'resolves', 'conflicts_with')
       or v_conf is null or v_conf < 0.7 or v_conf > 1 then
      v_rejected := v_rejected + 1;
      continue;
    end if;
    insert into public.mn_decision_links (new_decision, old_decision, rel, confidence, reason, source, reviewed)
    values (v_new.id, v_old.id, v_item ->> 'rel', v_conf, left(v_item ->> 'reason', 500), 'llm', false)
    on conflict (new_decision, old_decision, rel) do nothing;
    if found then v_inserted := v_inserted + 1; end if;
    v_affected := array_append(v_affected, v_old.id);
  end loop;

  update public.mn_decisions d
  set invalid_at = (
        select min(n.valid_from)
        from public.mn_decision_links l
        join public.mn_decisions n on n.id = l.new_decision
        where l.old_decision = d.id and l.rel = 'supersedes'
      ),
      updated_at = now()
  where d.id = any(v_affected);

  update public.mn_meeting_records
  set linked_version = p_version, linked_at = now()
  where note_id = p_note_id;

  return jsonb_build_object(
    'inserted', v_inserted,
    'rejected', v_rejected,
    'superseded', (select count(*) from public.mn_decisions d where d.id = any(v_affected) and d.invalid_at is not null)
  );
end;
$$;

revoke all on function public.mn_apply_decision_links(text, text, text, jsonb) from public;
revoke all on function public.mn_apply_decision_links(text, text, text, jsonb) from anon, authenticated;
grant execute on function public.mn_apply_decision_links(text, text, text, jsonb) to service_role;
