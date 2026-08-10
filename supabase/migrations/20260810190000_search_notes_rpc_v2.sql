-- F4 search RPC v2: make search_notes access-aware (owner + shared) and add
-- optional project + date-range filters, so it can fully replace the MCP
-- server's fetch-200-then-filter-in-JS search (which capped coverage at 200
-- notes and could not use the note_insight index).
--
-- Supersedes the 3-arg search_notes from 20260810180000. Signature changes
-- (new params + meeting_at in the result), so drop the old overload first.

drop function if exists public.search_notes(text, text, int);

create or replace function public.search_notes(
  p_user_id text,
  p_query text,
  p_limit int default 20,
  p_project_id text default null,
  p_start timestamptz default null,
  p_end timestamptz default null
)
returns table (
  note_id text,
  name text,
  summary text,
  created_at timestamptz,
  meeting_at timestamptz,
  score real,
  matched_people text[],
  matched_topics text[],
  matched_companies text[]
)
language sql
stable
as $$
  with params as (
    select
      trim(coalesce(p_query, '')) as query,
      greatest(1, least(coalesce(p_limit, 20), 100)) as lim
  ),
  scored as (
    select
      n.id as note_id,
      n.name,
      coalesce(nullif(n.summary_edit, ''), n.summary) as summary,
      n.created_at,
      n.meeting_at,
      -- Keyword signal is SUBSTRING (ilike, trgm-GIN accelerated); similarity is a
      -- fuzzy name boost only (a short query in a long summary has ~0 trgm similarity).
      (coalesce(n.name, '') ilike '%' || p.query || '%') as name_hit,
      (coalesce(n.summary, '') ilike '%' || p.query || '%'
        or coalesce(n.summary_edit, '') ilike '%' || p.query || '%') as summary_hit,
      (coalesce(n.transcription, '') ilike '%' || p.query || '%') as tx_hit,
      similarity(coalesce(n.name, ''), p.query) as name_sim,
      (select array_agg(x) from unnest(coalesce(ni.people, '{}'::text[])) x
        where x ilike '%' || p.query || '%') as matched_people,
      (select array_agg(x) from unnest(coalesce(ni.topics, '{}'::text[])) x
        where x ilike '%' || p.query || '%') as matched_topics,
      (select array_agg(x) from unnest(coalesce(ni.companies, '{}'::text[])) x
        where x ilike '%' || p.query || '%') as matched_companies
    from public.note n
    left join public.note_insight ni on ni.note_id = n.id
    cross join params p
    where p.query <> ''
      -- owner OR shared, matching the app/MCP access rules (arrays cast to text[]
      -- so the comparison works whether the column is text[] or bigint[]).
      and (n.user_id = p_user_id or p_user_id = any(coalesce(n.shared_users, '{}')::text[]))
      and (p_project_id is null or p_project_id = any(coalesce(n.projects, '{}')::text[]))
      and (p_start is null or coalesce(n.meeting_at, n.created_at) >= p_start)
      and (p_end is null or coalesce(n.meeting_at, n.created_at) <= p_end)
  )
  select
    s.note_id,
    s.name,
    s.summary,
    s.created_at,
    s.meeting_at,
    (
      case when s.name_hit then 1.0 else 0 end
      + case when s.summary_hit then 0.7 else 0 end
      + case when s.tx_hit then 0.3 else 0 end
      + s.name_sim * 0.5
      + case when s.matched_people is not null then 0.6 else 0 end
      + case when s.matched_topics is not null then 0.5 else 0 end
      + case when s.matched_companies is not null then 0.5 else 0 end
    )::real as score,
    coalesce(s.matched_people, '{}'::text[]),
    coalesce(s.matched_topics, '{}'::text[]),
    coalesce(s.matched_companies, '{}'::text[])
  from scored s
  where s.name_hit
     or s.summary_hit
     or s.tx_hit
     or s.name_sim > 0.2
     or s.matched_people is not null
     or s.matched_topics is not null
     or s.matched_companies is not null
  order by score desc, coalesce(s.meeting_at, s.created_at) desc
  limit (select lim from params);
$$;

grant execute on function public.search_notes(text, text, int, text, timestamptz, timestamptz) to authenticated, service_role;

-- Backfill helper: notes that still have no note_insight row but do have a
-- transcript worth extracting from. Lets the workflow-server backfill endpoint
-- pull batches server-side (instead of fetching every note's transcript to the
-- app just to filter). service_role only — it is an admin/maintenance path.
create or replace function public.notes_needing_insight(p_limit int default 25)
returns table (
  id text,
  user_id text,
  transcription text
)
language sql
stable
as $$
  select n.id, n.user_id, n.transcription
  from public.note n
  left join public.note_insight ni on ni.note_id = n.id
  where ni.note_id is null
    and coalesce(length(n.transcription), 0) > 40
  order by n.created_at desc
  limit greatest(1, least(coalesce(p_limit, 25), 100));
$$;

grant execute on function public.notes_needing_insight(int) to service_role;
