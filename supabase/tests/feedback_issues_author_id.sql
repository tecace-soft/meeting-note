-- Run ONLY after feedback_issues_fixture_schema.sql + 20260812230000 + 20261014120000 +
-- 20261015120000 in an isolated local DB (workflow-server/scripts/verify-feedback-issues-sql.mjs).
-- Covers the 2026-10-15 review: ownership by Microsoft object id, and a second account that
-- carries someone else's email (nOAuth-style `mail` spoof) gaining nothing from it.
-- Transaction rollback leaves the synthetic database unchanged.
begin;
create temp table fb_author_checks (name text primary key);
grant select, insert on fb_author_checks to service_role, authenticated, anon;

create function pg_temp.expect(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAILED: %', label; end if;
  insert into fb_author_checks values (label);
end $$;

create function pg_temp.expect_error(statement text, expected_state text, expected_message text, label text)
returns void language plpgsql as $$
declare actual_state text; actual_message text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_state = returned_sqlstate, actual_message = message_text;
  end;
  if not (actual_state is not distinct from expected_state
          and (expected_message is null or actual_message = expected_message)) then
    raise exception 'FAILED: % (state %, message %)', label, actual_state, actual_message;
  end if;
  insert into fb_author_checks values (label);
end $$;

create function pg_temp.affected(statement text) returns integer language plpgsql as $$
declare n integer;
begin
  execute statement;
  get diagnostics n = row_count;
  return n;
end $$;

-- 'spoof' has its own object id but the same JWT email as 'a' (and later as the admin): that is
-- what an outside tenant admin gets by setting a user's Graph mail to the victim's address.
create function pg_temp.as_user(p text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case p
    when 'admin' then '{"role":"authenticated","sub":"31d79bfe-2488-47c2-aa45-949375e93bde","email":"andrewyoo@tecace.com","user_metadata":{"name":"Andrew Yoo"}}'
    when 'a' then '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-000000000001","email":"a.user@tecace.com","user_metadata":{"name":"User A"}}'
    when 'spoof' then '{"role":"authenticated","sub":"ffffffff-0000-4000-8000-00000000000f","email":"A.User@tecace.com","user_metadata":{"name":"User A"}}'
    when 'spoof_admin' then '{"role":"authenticated","sub":"ffffffff-0000-4000-8000-00000000000f","email":"andrewyoo@tecace.com","user_metadata":{"name":"Not Andrew"}}'
    when 'service' then '{"role":"service_role"}'
  end, true);
end $$;
grant execute on function pg_temp.as_user(text) to authenticated, service_role, anon;

-- ---- schema ---------------------------------------------------------------------
select pg_temp.expect((select count(*) = 2 from information_schema.columns
  where table_schema = 'public' and table_name = 'feedback_issues' and column_name in ('author_id', 'triaged_by_id')),
  'author_id and triaged_by_id columns exist');
select pg_temp.expect(not has_function_privilege('anon', 'public.feedback_issues_auth_sub()', 'EXECUTE'),
  'anon cannot run the sub helper');
select pg_temp.expect((select coalesce(proconfig, '{}') @> array['search_path=public, pg_temp']
  from pg_proc where proname = 'feedback_issues_auth_sub'), 'sub helper pins search_path');

-- ---- author_id is stamped from the JWT ----------------------------------------------
set local role authenticated;
select pg_temp.as_user('a');
insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, author_id, triaged_by_id)
values ('FB-20261015-A0000001', 'A issue', 'd', 'bug', 'OPEN', 'P3', 'x@y.z', '31d79bfe-2488-47c2-aa45-949375e93bde', 'forged');
select pg_temp.expect((select author_id = 'aaaaaaaa-0000-4000-8000-000000000001' and triaged_by_id is null
  from public.feedback_issues where issue_key = 'FB-20261015-A0000001'), 'insert stamps author_id from sub; client ids ignored');
select pg_temp.as_user('spoof');
insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email)
values ('FB-20261015-F0000001', 'Spoof issue', 'd', 'bug', 'OPEN', 'P3', 'x@y.z');
select pg_temp.expect((select author_id = 'ffffffff-0000-4000-8000-00000000000f' and author_email = 'a.user@tecace.com'
  from public.feedback_issues where issue_key = 'FB-20261015-F0000001'), 'spoofed email still gets the spoofer''s own author_id');
reset role;

-- ---- soft delete by object id ----------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('spoof');
select pg_temp.expect_error(format('select public.soft_delete_feedback_issue(%L)',
  (select id from public.feedback_issues where issue_key = 'FB-20261015-A0000001')),
  '42501', '본인이 등록한 이슈만 삭제할 수 있습니다.', 'same email, other object id cannot delete the victim''s issue');
select pg_temp.as_user('a');
select pg_temp.expect_error(format('select public.soft_delete_feedback_issue(%L)',
  (select id from public.feedback_issues where issue_key = 'FB-20261015-F0000001')),
  '42501', '본인이 등록한 이슈만 삭제할 수 있습니다.', 'victim cannot delete the spoofer''s issue either (no email match)');
select public.soft_delete_feedback_issue((select id from public.feedback_issues where issue_key = 'FB-20261015-A0000001'));
select pg_temp.expect((select deleted_at is not null from public.feedback_issues where issue_key = 'FB-20261015-A0000001'),
  'author deletes own issue by object id');
reset role;

-- Legacy row (filed before author_id existed): admin only.
set local role service_role;
select pg_temp.as_user('service');
insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email)
values ('FB-20260901-0000L001', 'legacy', 'd', 'other', 'OPEN', 'P3', 'a.user@tecace.com');
select pg_temp.expect((select author_id is null from public.feedback_issues where issue_key = 'FB-20260901-0000L001'),
  'service-role insert keeps a null author_id (F9 / legacy)');
reset role;
set local role authenticated;
select pg_temp.as_user('a');
select pg_temp.expect_error(format('select public.soft_delete_feedback_issue(%L)',
  (select id from public.feedback_issues where issue_key = 'FB-20260901-0000L001')),
  '42501', '본인이 등록한 이슈만 삭제할 수 있습니다.', 'matching email alone cannot delete a legacy row');
select pg_temp.as_user('admin');
select public.soft_delete_feedback_issue((select id from public.feedback_issues where issue_key = 'FB-20260901-0000L001'));
select pg_temp.expect((select deleted_at is not null from public.feedback_issues where issue_key = 'FB-20260901-0000L001'),
  'admin deletes a legacy row without author_id');
select pg_temp.expect_error(format('select public.soft_delete_feedback_issue(%L)',
  (select id from public.feedback_issues where issue_key = 'FB-20261015-F0000001')),
  '42501', '본인이 등록한 이슈만 삭제할 수 있습니다.', 'admin cannot delete another user''s owned issue');
reset role;

-- ---- triage keeps author_id and stamps triaged_by_id ------------------------------------
set local role authenticated;
select pg_temp.as_user('admin');
select pg_temp.expect(pg_temp.affected($s$update public.feedback_issues set status = 'IN_PROGRESS', triaged_at = now(),
  author_id = 'hijack', triaged_by_id = 'forged' where issue_key = 'FB-20261015-F0000001'$s$) = 1, 'admin triage save updates one row');
select pg_temp.expect((select author_id = 'ffffffff-0000-4000-8000-00000000000f'
  and triaged_by_id = '31d79bfe-2488-47c2-aa45-949375e93bde' and triaged_by = 'andrewyoo@tecace.com'
  from public.feedback_issues where issue_key = 'FB-20261015-F0000001'), 'author_id is immutable; triaged_by_id is the lower-cased caller sub');
select pg_temp.expect(pg_temp.affected($s$update public.feedback_issues set priority = 'P1', triaged_by_id = 'forged'
  where issue_key = 'FB-20261015-F0000001'$s$) = 1, 'admin save without a new triaged_at updates one row');
select pg_temp.expect((select triaged_by_id = '31d79bfe-2488-47c2-aa45-949375e93bde'
  from public.feedback_issues where issue_key = 'FB-20261015-F0000001'), 'triaged_by_id is kept when triaged_at does not change');
reset role;

-- Service role (backfill, F9) can set author_id.
set local role service_role;
select pg_temp.as_user('service');
update public.feedback_issues set author_id = 'aaaaaaaa-0000-4000-8000-000000000001' where issue_key = 'FB-20260901-0000L001';
select pg_temp.expect((select author_id = 'aaaaaaaa-0000-4000-8000-000000000001'
  from public.feedback_issues where issue_key = 'FB-20260901-0000L001'), 'service role can backfill author_id');
reset role;

-- ---- directory keyed by object id ----------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('a');
insert into public.app_user (microsoft_id, display_name, email) values ('aaaaaaaa-0000-4000-8000-000000000001', 'x', 'x');
select pg_temp.as_user('admin');
insert into public.app_user (microsoft_id, display_name, email) values ('31d79bfe-2488-47c2-aa45-949375e93bde', 'x', 'x');
select pg_temp.expect((select count(*) = 1 from public.list_issue_directory() where email = 'a.user@tecace.com' and display_name = 'User A'),
  'directory lists a single-claimant address');
select pg_temp.expect((select bool_and(is_admin) from public.list_issue_directory() where email = 'andrewyoo@tecace.com'),
  'directory flags the admin object id');
select pg_temp.as_user('spoof');
insert into public.app_user (microsoft_id, display_name, email) values ('ffffffff-0000-4000-8000-00000000000f', 'x', 'x');
select pg_temp.expect((select count(*) = 0 from public.list_issue_directory() where email = 'a.user@tecace.com'),
  'an address claimed by two object ids is hidden (no hijacked name)');
select pg_temp.as_user('spoof_admin');
update public.app_user set last_seen_at = now() where microsoft_id = 'ffffffff-0000-4000-8000-00000000000f';
select pg_temp.expect((select count(*) = 1 and bool_and(is_admin) and bool_and(display_name = 'Andrew Yoo')
  from public.list_issue_directory() where email = 'andrewyoo@tecace.com'),
  'a second claimant of an admin address cannot replace the admin entry');
reset role;

select count(*) as passed_author_checks from fb_author_checks;
rollback;
