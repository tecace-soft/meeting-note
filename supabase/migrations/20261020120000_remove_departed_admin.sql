-- =====================================================================================
-- Remove a departed admin from public.feedback_issues_is_admin_id (hardcoded allowlist).
-- Run it whole, once (idempotent: `create or replace`, re-running is safe).
--
-- WHY: a departed teammate must no longer be an issue-tracker admin (triage, notify, delete).
-- The same id was removed from the code lists in the same change: ADMIN_MICROSOFT_USER_IDS
-- (src/lib/adminAccess.ts), ISSUE_ADMIN_MICROSOFT_IDS (workflow-server/src/issues.ts) and the
-- admin-analytics / admin-controls edge functions. Keep all of them in step.
--
-- PRECONDITIONS
--   - 20261014120000_feedback_issues_parity.sql is applied (the function exists).
--
-- PRE-CHECK (read-only, ONE result): the current allowlist size is 3.
--   select jsonb_build_object(
--     'function_exists', exists (select 1 from pg_proc where proname = 'feedback_issues_is_admin_id'),
--     'admin_id_count', (select count(*) from pg_proc p, regexp_matches(p.prosrc, '[0-9a-f]{8}-', 'g')
--                         where p.proname = 'feedback_issues_is_admin_id'),
--     'def', (select prosrc from pg_proc where proname = 'feedback_issues_is_admin_id')
--   ) as precheck;
--   Expect function_exists true and a body listing three ids.
--
-- POST-CHECK (read-only, ONE result): the body lists two ids and the function still works.
--   select jsonb_build_object(
--     'def', (select prosrc from pg_proc where proname = 'feedback_issues_is_admin_id'),
--     'null_is_not_admin', public.feedback_issues_is_admin_id(null) = false,
--     'unknown_is_not_admin', public.feedback_issues_is_admin_id('00000000-0000-4000-8000-000000000000') = false
--   ) as postcheck;
--   Expect two ids in def and both booleans true.
--
-- ROLLBACK (restores the previous three-id definition from 20261014120000; run as one block):
--   create or replace function public.feedback_issues_is_admin_id(p_microsoft_id text)
--   returns boolean
--   language sql
--   immutable
--   set search_path = public, pg_temp
--   as $fn$
--     select coalesce(p_microsoft_id, '') = any (array[
--       'd84c9149-2261-4ced-b14c-01b1a377ba6b',  -- Hansoo Lee
--       'd9eb0f3d-819e-4b45-8df6-e9f229de2447',  -- (departed admin, restored by rollback only)
--       '31d79bfe-2488-47c2-aa45-949375e93bde'   -- Andrew Yoo
--     ]);
--   $fn$;
-- =====================================================================================

create or replace function public.feedback_issues_is_admin_id(p_microsoft_id text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_microsoft_id, '') = any (array[
    'd84c9149-2261-4ced-b14c-01b1a377ba6b',  -- Hansoo Lee
    '31d79bfe-2488-47c2-aa45-949375e93bde'   -- Andrew Yoo
  ]);
$$;
