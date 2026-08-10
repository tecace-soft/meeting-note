-- F4 (metadata index layer) — hybrid search RPC over note + note_insight.
--
-- Combines two signals the alpha schema already indexes:
--   1. keyword similarity / substring over the note text columns (pg_trgm GIN
--      indexes on name/summary/summary_edit/transcription).
--   2. structured hits in note_insight arrays (people / topics / companies),
--      which the server-side extraction fills per note.
--
-- Scoped by p_user_id so it is safe under both callers: the app (RLS already
-- restricts note/note_insight to the owner) and the MCP server (service_role,
-- which bypasses RLS and relies on this explicit user filter). SECURITY INVOKER
-- (the default) — no privilege escalation.

create or replace function public.search_notes(
  p_user_id text,
  p_query text,
  p_limit int default 20
)
returns table (
  note_id text,
  name text,
  summary text,
  created_at timestamptz,
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
      -- Keyword signal is SUBSTRING (ilike, trgm-GIN accelerated), not whole-string
      -- similarity: a short query inside a long summary has near-zero trgm similarity
      -- and would otherwise be missed. Similarity is kept only as a fuzzy name boost.
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
    where n.user_id = p_user_id
      and p.query <> ''
  )
  select
    s.note_id,
    s.name,
    s.summary,
    s.created_at,
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
  order by score desc, s.created_at desc
  limit (select lim from params);
$$;

grant execute on function public.search_notes(text, text, int) to authenticated, service_role;
