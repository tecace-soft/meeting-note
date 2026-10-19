-- =====================================================================================
-- F2 feedback / issue tracker: ownership by Microsoft object id (JWT `sub`), not by email.
-- Security review 2026-10-15 (supabase-token "tenant OR email domain" spoof, nOAuth class).
--
-- WHY: the JWT `email` claim is the Graph `mail` attribute, which the account's own tenant
-- admin can set to any address (e.g. hansoo@tecace.com in an outside tenant). The tenant gate
-- now blocks outside tenants at login, and ownership no longer trusts the email at all: the
-- object id is issued by Entra and cannot be chosen.
--
-- WHAT THIS DOES (one file, run it whole, once; re-running is safe / idempotent):
--   1. feedback_issues.author_id / triaged_by_id (text, Microsoft object id, lower-case).
--   2. feedback_issues_auth_sub(): the caller's JWT `sub`, lower-cased.
--   3. Insert trigger stamps author_id from the JWT (client value ignored); update trigger
--      keeps author_id immutable for users and stamps triaged_by_id with triaged_by.
--      author_email / triaged_by stay as display data.
--   4. soft_delete_feedback_issue(uuid): author = author_id = caller `sub`. Rows without
--      author_id (filed before this migration and not backfilled) can be deleted by admins only.
--   5. list_issue_directory(): one entry per Microsoft object id; an email claimed by more than
--      one object id is hidden unless the claimant is an admin id, so a second account using
--      someone's address cannot replace that person's name or admin flag in the directory.
--   NOTE (accepted in the 2026-10-15 review): rows with a null author_id, which includes every
--   F9 ops ticket (author ops-agent@tecace.com) and any legacy row STEP B does not fill, can be
--   soft-deleted by admins only. Before this migration nobody could delete an F9 ticket through
--   the RPC (no user owns ops-agent@tecace.com); now admins can.
--   No backfill runs here. Step B below is a separate, reviewed statement.
--
-- PRECONDITIONS
--   - 20261014120000_feedback_issues_parity.sql is applied (helpers, triggers, RPCs exist).
--
-- DEPLOY ORDER (see the 2026-10-15 rollout notes in the PR / handoff):
--   1. Run the PRE-CHECK below (read-only, one result).
--   2. Run THIS FILE in the Supabase SQL Editor (paste the whole file, run once).
--   3. Review the backfill candidates from the PRE-CHECK, then run STEP B if wanted.
--   4. Run the POST-CHECK (one result).
--   5. Only then push the code: the backend's issue-notify reads author_id, and the web
--      delete button uses it. Before this migration the new backend cannot read that column.
--   Mobile needs no change: the trigger stamps author_id from the same JWT.
--
-- PRE-CHECK (read-only; the SQL Editor shows only the last result, so this is ONE query):
--   select jsonb_build_object(
--     'parity_migration_applied', exists (select 1 from pg_proc where proname = 'feedback_issues_auth_email'),
--     'author_id_column_exists', exists (select 1 from information_schema.columns
--        where table_schema = 'public' and table_name = 'feedback_issues' and column_name = 'author_id'),
--     'issues_total', (select count(*) from public.feedback_issues),
--     'issues_live', (select count(*) from public.feedback_issues where deleted_at is null),
--     'emails_claimed_by_several_ids', (select coalesce(jsonb_agg(jsonb_build_object('email', e, 'ids', n)), '[]'::jsonb)
--        from (select lower(email) as e, count(distinct microsoft_id) as n from public.app_user
--               where position('@' in coalesce(email, '')) > 1 group by 1 having count(distinct microsoft_id) > 1) x),
--     'backfill_candidates', (select coalesce(jsonb_agg(jsonb_build_object(
--          'issue_key', f.issue_key, 'author_email', lower(f.author_email), 'deleted', f.deleted_at is not null,
--          'candidate_ids', (select coalesce(jsonb_agg(distinct lower(u.microsoft_id)), '[]'::jsonb)
--                              from public.app_user u where lower(u.email) = lower(f.author_email)))
--          order by f.created_at), '[]'::jsonb)
--        from public.feedback_issues f where lower(f.author_email) <> 'ops-agent@tecace.com')
--   ) as precheck;
--   Read it like this: an issue is backfilled by STEP B only when candidate_ids has exactly one
--   id. Before running STEP B, confirm each such id is a TecAce directory member (Entra admin
--   center > Users, search by object id). If an id is unknown, do not run STEP B for it.
--   emails_claimed_by_several_ids should be []: anything else is a sign of an earlier spoof
--   attempt or a duplicate account and is skipped by STEP B.
--   It also matters AFTER this migration: list_issue_directory() hides an address claimed by
--   two or more object ids (unless one is an admin id), so a leftover app_user row can hide a
--   real user from the assignee / recipient pickers. For each such address, check the ids in
--   Entra and delete the app_user row of the id that is not a TecAce directory member
--   (service role / SQL Editor), e.g.
--     delete from public.app_user where microsoft_id = '<id that is not in the directory>';
--   Run that only after the Entra check; it is a write and is not part of this file.
--
-- STEP B (optional backfill, run separately AFTER this file and after the review above):
--   update public.feedback_issues f
--      set author_id = c.microsoft_id
--     from (select lower(email) as email, lower(min(microsoft_id)) as microsoft_id
--             from public.app_user
--            where position('@' in coalesce(email, '')) > 1
--            group by lower(email)
--           having count(distinct microsoft_id) = 1) c
--    where f.author_id is null
--      and lower(f.author_email) = c.email
--      and lower(f.author_email) <> 'ops-agent@tecace.com'
--   returning f.issue_key, f.author_id;
--   (Runs as the SQL Editor role, so the user triggers do not overwrite the value.)
--   SIDE EFFECTS of STEP B: it is an UPDATE, so the BEFORE UPDATE triggers still run on every
--   backfilled row. (1) feedback_issues_stamp_update normalizes a legacy status such as
--   'TRIAGE' to 'OPEN' and recomputes severity from priority (a row with an invalid priority
--   makes the whole statement fail; fix it first, see the parity migration's pre-check (a)).
--   (2) feedback_issues_set_updated_at sets updated_at = now(), so those rows move to "recently
--   updated". author_email, triage fields and created_at are not changed.
--
-- POST-CHECK (one result):
--   select jsonb_build_object(
--     'columns', (select jsonb_agg(column_name order by column_name) from information_schema.columns
--        where table_schema = 'public' and table_name = 'feedback_issues' and column_name in ('author_id', 'triaged_by_id')),
--     'sub_helper', exists (select 1 from pg_proc where proname = 'feedback_issues_auth_sub'),
--     'soft_delete_by_author_id', (select position('author_id' in prosrc) > 0 from pg_proc where proname = 'soft_delete_feedback_issue'),
--     'directory_by_object_id', (select position('microsoft_id' in prosrc) > 0 from pg_proc where proname = 'list_issue_directory'),
--     'live_rows_without_author_id', (select count(*) from public.feedback_issues where deleted_at is null and author_id is null),
--     'live_ops_rows', (select count(*) from public.feedback_issues where deleted_at is null and lower(author_email) = 'ops-agent@tecace.com')
--   ) as postcheck;
--   Expect columns ["author_id","triaged_by_id"], the three booleans true, and
--   live_rows_without_author_id = live_ops_rows after STEP B (F9 ops rows keep a null author).
--
-- ROLLBACK (restores the email-based ownership of 20261014120000; run as one block if needed).
-- THE FRONTEND AND BACKEND MUST BE ROLLED BACK TOGETHER (they read author_id).
--   1. Re-run sections 2, 4 and 5 of 20261014120000_feedback_issues_parity.sql (the
--      feedback_issues_stamp_insert / _stamp_update triggers, soft_delete_feedback_issue and
--      list_issue_directory; all are `create or replace`).
--   2. Then:
--   begin;
--   drop function if exists public.feedback_issues_auth_sub();
--   drop index if exists public.idx_feedback_issues_author_id;
--   alter table public.feedback_issues drop column if exists triaged_by_id;
--   alter table public.feedback_issues drop column if exists author_id;
--   commit;
--   (Dropping the columns is optional; keeping them is harmless for the old code.)
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.feedback_issues add column if not exists author_id text;
alter table public.feedback_issues add column if not exists triaged_by_id text;

comment on column public.feedback_issues.author_id is
  'Microsoft object id (JWT sub, lower-case) of the author. Ownership key; author_email is display only.';
comment on column public.feedback_issues.triaged_by_id is
  'Microsoft object id (JWT sub, lower-case) of the last triage save. triaged_by is display only.';

create index if not exists idx_feedback_issues_author_id
  on public.feedback_issues (author_id);

-- ---------------------------------------------------------------------------
-- 2. Caller object id
-- ---------------------------------------------------------------------------

-- JWT `sub` of the signed-in caller, lower-cased; null for service_role / SQL editor.
create or replace function public.feedback_issues_auth_sub()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select lower(nullif(trim(coalesce(auth.jwt() ->> 'sub', '')), ''));
$$;

revoke all on function public.feedback_issues_auth_sub() from public, anon;
grant execute on function public.feedback_issues_auth_sub() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Server-stamped ownership (same bodies as 20261014120000 plus the id columns)
-- ---------------------------------------------------------------------------

create or replace function public.feedback_issues_stamp_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_email text := public.feedback_issues_auth_email();
begin
  if public.feedback_issues_is_end_user() then
    -- SEC-4: the author is whoever signed the request, never a client-sent value.
    if v_email is null then
      raise exception '로그인 이메일을 확인할 수 없어 이슈를 등록할 수 없습니다.' using errcode = '42501';
    end if;
    new.author_email := v_email;
    new.author_name := public.feedback_issues_auth_name();
    -- Ownership key: the Microsoft object id from the JWT (2026-10-15 review).
    new.author_id := public.feedback_issues_auth_sub();
    new.triaged_by_id := null;
    -- Ordering and F9 rate windows rely on created_at; it is never client-chosen.
    new.created_at := now();
    new.updated_at := now();
  end if;
  new.severity := public.feedback_issues_severity_of(new.priority);
  if new.severity is null then
    raise exception 'invalid priority: %', new.priority using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace function public.feedback_issues_stamp_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_email text;
begin
  if public.feedback_issues_is_end_user() then
    -- Fields no user write path may change (spec 7.5: ignored client values).
    new.id := old.id;
    new.issue_key := old.issue_key;
    new.title := old.title;
    new.description := old.description;
    new.author_email := old.author_email;
    new.author_name := old.author_name;
    new.author_id := old.author_id;
    new.ai_suggestion := old.ai_suggestion;
    new.attachments := old.attachments;
    new.created_at := old.created_at;
    -- Triage save sends a new triaged_at; the DB stamps the real time and the caller.
    if new.triaged_at is distinct from old.triaged_at then
      v_email := public.feedback_issues_auth_email();
      if v_email is null then
        raise exception '로그인 이메일을 확인할 수 없어 분류를 저장할 수 없습니다.' using errcode = '42501';
      end if;
      new.triaged_at := now();
      new.triaged_by := v_email;
      new.triaged_by_id := public.feedback_issues_auth_sub();
    else
      new.triaged_by := old.triaged_by;
      new.triaged_by_id := old.triaged_by_id;
    end if;
    -- AI-3: resolution save stamps its own time; other writes keep the old stamp.
    if new.resolution is distinct from old.resolution then
      new.resolution_generated_at := case when new.resolution is null then null else now() end;
    else
      new.resolution_generated_at := old.resolution_generated_at;
      new.resolution_model := old.resolution_model;
    end if;
  end if;
  -- DATA-3: only four statuses exist; legacy values (TRIAGE) become OPEN on write.
  if new.status not in ('OPEN', 'IN_PROGRESS', 'DONE', 'CLOSED') then
    new.status := 'OPEN';
  end if;
  new.severity := public.feedback_issues_severity_of(new.priority);
  if new.severity is null then
    raise exception 'invalid priority: %', new.priority using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.feedback_issues_stamp_insert() from public, anon;
revoke all on function public.feedback_issues_stamp_update() from public, anon;

-- ---------------------------------------------------------------------------
-- 4. Soft delete RPC (SEC-5): author by object id; legacy rows (no author_id) admin only
-- ---------------------------------------------------------------------------

create or replace function public.soft_delete_feedback_issue(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub text := public.feedback_issues_auth_sub();
begin
  if v_sub is null or not public.feedback_issues_can('issues') then
    raise exception '이슈를 삭제할 권한이 없습니다.' using errcode = '42501';
  end if;
  update public.feedback_issues
     set deleted_at = now()
   where id = p_id
     and deleted_at is null
     and (
       lower(author_id) = v_sub
       or (author_id is null and public.feedback_issues_can('issues.triage'))
     );
  if not found then
    raise exception '본인이 등록한 이슈만 삭제할 수 있습니다.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.soft_delete_feedback_issue(uuid) from public, anon;
grant execute on function public.soft_delete_feedback_issue(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. User directory keyed by object id
-- ---------------------------------------------------------------------------

-- One row per Microsoft object id (app_user's key). An address claimed by several ids is
-- dropped unless the claimant is an admin id: a second account using someone's address can
-- then neither rename that person nor clear their admin flag in the pickers. Same output
-- columns as before, so existing clients keep working.
create or replace function public.list_issue_directory()
returns table (email text, display_name text, is_admin boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with users as (
    select
      lower(u.microsoft_id) as microsoft_id,
      lower(trim(u.email)) as email,
      case
        when nullif(trim(u.display_name), '') is null then null
        when trim(u.display_name) in ('User', 'Unknown user') then null
        else trim(u.display_name)
      end as display_name
    from public.app_user u
    where public.feedback_issues_can('issues')
      and coalesce(trim(u.microsoft_id), '') <> ''
      and position('@' in coalesce(u.email, '')) > 1
  ),
  claims as (
    select users.email, count(*) as claimants
    from users
    group by users.email
  )
  select u.email, u.display_name, public.feedback_issues_is_admin_id(u.microsoft_id) as is_admin
  from users u
  join claims c on c.email = u.email
  where c.claimants = 1 or public.feedback_issues_is_admin_id(u.microsoft_id)
  order by lower(coalesce(u.display_name, u.email)), u.email;
$$;

revoke all on function public.list_issue_directory() from public, anon;
grant execute on function public.list_issue_directory() to authenticated, service_role;
