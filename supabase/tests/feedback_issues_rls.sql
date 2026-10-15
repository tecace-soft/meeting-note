-- Run ONLY after feedback_issues_fixture_schema.sql + 20260812230000 + 20261014120000 in an
-- isolated local DB (workflow-server/scripts/verify-feedback-issues-sql.mjs).
-- Covers spec 12.4 (SEC, direct calls that skip the UI) plus mobile payload compatibility.
-- Transaction rollback leaves the synthetic database unchanged.
begin;
create temp table fb_checks (name text primary key);
grant select, insert on fb_checks to service_role, authenticated, anon;

create function pg_temp.expect(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAILED: %', label; end if;
  insert into fb_checks values (label);
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
  insert into fb_checks values (label);
end $$;

create function pg_temp.affected(statement text) returns integer language plpgsql as $$
declare n integer;
begin
  execute statement;
  get diagnostics n = row_count;
  return n;
end $$;

-- Claims for the synthetic callers.
create function pg_temp.as_user(p text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case p
    when 'admin' then '{"role":"authenticated","sub":"31d79bfe-2488-47c2-aa45-949375e93bde","email":"AndrewYoo@tecace.com","user_metadata":{"name":"Andrew Yoo"}}'
    when 'a' then '{"role":"authenticated","sub":"aaaaaaaa-0000-4000-8000-000000000001","email":"A.User@tecace.com","user_metadata":{"name":"User A"}}'
    when 'b' then '{"role":"authenticated","sub":"bbbbbbbb-0000-4000-8000-000000000002","email":"b@tecace.com","user_metadata":{"name":"User B"}}'
    when 'nomail' then '{"role":"authenticated","sub":"dddddddd-0000-4000-8000-000000000004","email":"","user_metadata":{"name":""}}'
    when 'noname' then '{"role":"authenticated","sub":"eeeeeeee-0000-4000-8000-000000000005","email":"e@tecace.com"}'
    when 'admin_nomail' then '{"role":"authenticated","sub":"31d79bfe-2488-47c2-aa45-949375e93bde","email":""}'
    when 'service' then '{"role":"service_role"}'
  end, true);
end $$;
grant execute on function pg_temp.as_user(text) to authenticated, service_role, anon;

insert into public.app_user (microsoft_id, display_name, email) values
  ('31d79bfe-2488-47c2-aa45-949375e93bde', 'Andrew Yoo', 'andrewyoo@tecace.com'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'User A', 'A.User@tecace.com'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'Unknown user', 'b@tecace.com'),
  ('cccccccc-0000-4000-8000-000000000003', 'No Mail', '');

-- ---- seed + grants ----------------------------------------------------------
select pg_temp.expect((select count(*) = 1 and bool_and(email = 'andrewyoo@tecace.com')
  from public.issue_notify_recipients), 'seed has exactly the first recipient after two runs');
select pg_temp.expect((select not public and file_size_limit = 10485760 from storage.buckets where id = 'feedback-attachments'),
  'bucket is private with a 10 MB cap');
select pg_temp.expect(not has_function_privilege('anon', 'public.soft_delete_feedback_issue(uuid)', 'EXECUTE'),
  'anon cannot execute soft delete');
select pg_temp.expect(not has_function_privilege('anon', 'public.list_issue_directory()', 'EXECUTE'),
  'anon cannot execute directory');

-- ---- mobile payload compatibility (meeting-note-mobile issues_repository.dart) ----
set local role authenticated;
select pg_temp.as_user('a');
insert into public.feedback_issues (issue_key, title, description, purpose, area, status, priority, severity,
  attachments, ai_suggestion, author_email, author_name)
values ('FB-20261014-AB12CD34', 'Mobile title', 'Mobile body', 'bug', 'meeting-note', 'OPEN', 'P2', 'Low',
  '[]', '{"purpose":"bug","area":"meeting-note","priority":"P2","severity":"High"}', 'spoof@evil.com', 'Spoofed');
select pg_temp.expect((select author_email = 'a.user@tecace.com' and author_name = 'User A' and severity = 'High'
  and status = 'OPEN' and triaged_at is null from public.feedback_issues where issue_key = 'FB-20261014-AB12CD34'),
  'mobile payload accepted; author from JWT; severity from priority');

-- ---- SEC-3: initial state only ------------------------------------------------
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email)
  values ('FB-20261014-AB12CD35', 't', 'd', 'bug', 'DONE', 'P3', 'x@y.z')$s$, '42501', null, 'insert with status DONE is rejected');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, assignee_email)
  values ('FB-20261014-AB12CD36', 't', 'd', 'bug', 'OPEN', 'P3', 'x@y.z', 'b@tecace.com')$s$, '42501', null, 'insert with assignee is rejected');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, resolution)
  values ('FB-20261014-AB12CD37', 't', 'd', 'bug', 'OPEN', 'P3', 'x@y.z', '{}')$s$, '42501', null, 'insert with resolution is rejected');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email)
  values ('OPS-20261014-AB12CD38', 't', 'd', 'bug', 'OPEN', 'P3', 'x@y.z')$s$, '42501', null, 'insert with a non-FB key is rejected');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email)
  values ('FB-20261014-AB12CD39', 't', 'd', 'bug', 'OPEN', 'P9', 'x@y.z')$s$, '22023', null, 'insert with an unknown priority is rejected');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email)
  values ('FB-20261014-AB12CD34', 't', 'd', 'bug', 'OPEN', 'P3', 'x@y.z')$s$, '23505', null, 'duplicate issue key is a unique violation (client retries)');

-- ---- read --------------------------------------------------------------------
select pg_temp.expect((select count(*) = 1 from public.feedback_issues), 'signed-in user reads the board');
reset role;
set local role anon;
select pg_temp.expect_error($s$select count(*) from public.feedback_issues$s$, '42501', null, 'anon cannot read issues');
reset role;

-- ---- triage permission -------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('a');
select pg_temp.expect(pg_temp.affected($s$update public.feedback_issues set status = 'DONE', triaged_at = now()
  where issue_key = 'FB-20261014-AB12CD34'$s$) = 0, 'non-admin triage save changes nothing');
select pg_temp.as_user('admin');
select pg_temp.expect(pg_temp.affected($s$update public.feedback_issues set status = 'IN_PROGRESS', priority = 'P1',
  assignee_email = 'b@tecace.com', assignee_name = 'User B', triage_note = 'note', triaged_at = '2000-01-01', triaged_by = 'spoof',
  author_email = 'evil@x.com', title = 'changed', ai_suggestion = '{}', resolution_generated_at = '2000-01-01'
  where issue_key = 'FB-20261014-AB12CD34'$s$) = 1, 'admin triage save updates one row');
select pg_temp.expect((select status = 'IN_PROGRESS' and severity = 'Critical' and triaged_by = 'andrewyoo@tecace.com'
  and triaged_at > now() - interval '1 minute' and author_email = 'a.user@tecace.com' and title = 'Mobile title'
  and ai_suggestion ? 'purpose' and resolution_generated_at is null
  from public.feedback_issues where issue_key = 'FB-20261014-AB12CD34'), 'triage save: server stamps, locked fields kept');
select pg_temp.expect_error($s$update public.feedback_issues set deleted_at = now() where issue_key = 'FB-20261014-AB12CD34'$s$,
  '42501', null, 'triage save cannot set deleted_at');

-- AI-3: resolution save touches only the resolution columns.
select pg_temp.expect(pg_temp.affected($s$update public.feedback_issues set resolution = '{"summary":"s"}', resolution_model = 'm'
  where issue_key = 'FB-20261014-AB12CD34'$s$) = 1, 'admin resolution save updates one row');
select pg_temp.expect((select resolution_generated_at is not null and resolution_model = 'm' and triaged_by = 'andrewyoo@tecace.com'
  from public.feedback_issues where issue_key = 'FB-20261014-AB12CD34'), 'resolution save stamps time, keeps triage stamp');
reset role;

-- ---- system path (F9 ops agent, service role) + legacy status ------------------
set local role service_role;
select pg_temp.as_user('service');
insert into public.feedback_issues (issue_key, title, description, purpose, area, status, priority, severity,
  ai_suggestion, resolution, resolution_generated_at, resolution_model, author_email, author_name)
values ('OPS-20261014-0A0B0C0D', '[운영] x', 'd', 'bug', 'ops', 'OPEN', 'P2', 'High',
  '{"source":"f9-ops-agent","fingerprint":"f"}', '{"summary":"rca"}', now(), 'm', 'ops-agent@tecace.com', 'Ops Agent (F9)');
update public.feedback_issues set ai_suggestion = '{"source":"f9-ops-agent","fingerprint":"f","occurrences":2}'
  where issue_key = 'OPS-20261014-0A0B0C0D';
select pg_temp.expect((select author_email = 'ops-agent@tecace.com' and (ai_suggestion ->> 'occurrences') = '2' and resolution is not null
  from public.feedback_issues where issue_key = 'OPS-20261014-0A0B0C0D'), 'service role keeps the F9 insert and bump path');
insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email)
values ('FB-20260901-11112222', 'legacy', 'd', 'other', 'TRIAGE', 'P3', 'b@tecace.com');
reset role;
set local role authenticated;
select pg_temp.as_user('admin');
select pg_temp.expect(pg_temp.affected($s$update public.feedback_issues set resolution = '{"summary":"s"}'
  where issue_key = 'FB-20260901-11112222'$s$) = 1, 'admin can write a legacy TRIAGE row');
select pg_temp.expect((select status = 'OPEN' from public.feedback_issues where issue_key = 'FB-20260901-11112222'),
  'legacy TRIAGE status becomes OPEN on write');

-- ---- SEC-5 soft delete ---------------------------------------------------------
select pg_temp.as_user('b');
select pg_temp.expect_error(format('select public.soft_delete_feedback_issue(%L)',
  (select id from public.feedback_issues where issue_key = 'FB-20261014-AB12CD34')),
  '42501', '본인이 등록한 이슈만 삭제할 수 있습니다.', 'deleting someone else''s issue is rejected');
select pg_temp.expect(pg_temp.affected($s$update public.feedback_issues set deleted_at = now() where issue_key = 'FB-20261014-AB12CD34'$s$) = 0,
  'direct soft-delete update by a non-admin changes nothing');
select pg_temp.as_user('a');
select public.soft_delete_feedback_issue((select id from public.feedback_issues where issue_key = 'FB-20261014-AB12CD34'));
select pg_temp.expect((select deleted_at is not null and status = 'IN_PROGRESS' and title = 'Mobile title'
  from public.feedback_issues where issue_key = 'FB-20261014-AB12CD34'), 'author soft delete sets only deleted_at; row stays readable');
select pg_temp.as_user('admin');
select pg_temp.expect(pg_temp.affected($s$update public.feedback_issues set status = 'DONE' where issue_key = 'FB-20261014-AB12CD34'$s$) = 0,
  'deleted issue cannot be triaged');
reset role;

-- ---- directory ------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('b');
select pg_temp.expect((select count(*) = 3 from public.list_issue_directory()), 'directory lists users with an email only');
select pg_temp.expect((select bool_and(is_admin = (email = 'andrewyoo@tecace.com')) from public.list_issue_directory()),
  'directory flags admins');
select pg_temp.expect((select display_name is null from public.list_issue_directory() where email = 'b@tecace.com'),
  'placeholder display names are hidden');
select pg_temp.expect((select count(*) = 1 from public.list_issue_directory() where email = 'a.user@tecace.com'),
  'directory emails are lower-cased');
reset role;

-- ---- recipients (SEC-9) -------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('a');
select pg_temp.expect((select count(*) = 1 from public.issue_notify_recipients), 'signed-in user reads recipients');
select pg_temp.expect_error($s$insert into public.issue_notify_recipients (email) values ('b@tecace.com')$s$, '42501', null,
  'non-admin cannot add a recipient');
select pg_temp.expect(pg_temp.affected($s$delete from public.issue_notify_recipients$s$) = 0, 'non-admin cannot remove a recipient');
select pg_temp.as_user('admin');
insert into public.issue_notify_recipients (email, added_by) values ('b@tecace.com', 'spoof');
select pg_temp.expect((select added_by = 'andrewyoo@tecace.com' from public.issue_notify_recipients where email = 'b@tecace.com'),
  'added_by is the caller');
select pg_temp.expect_error($s$insert into public.issue_notify_recipients (email) values ('Upper@tecace.com')$s$, '23514', null,
  'recipient email must be lower-case');
select pg_temp.expect(pg_temp.affected($s$delete from public.issue_notify_recipients where email = 'b@tecace.com'$s$) = 1,
  'admin removes a recipient');
reset role;

-- ---- storage (SEC-7) ------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('a');
insert into storage.objects (bucket_id, name, owner_id) values
  ('feedback-attachments', 'screenshots/1-abcdefg.png', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('feedback-attachments', 'screenshots/2-abcdefg.png', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('feedback-attachments', 'aaaaaaaa-0000-4000-8000-000000000001/legacy.png', 'aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.expect_error($s$insert into storage.objects (bucket_id, name, owner_id) values ('feedback-attachments', 'elsewhere/x.png', 'x')$s$,
  '42501', null, 'upload outside screenshots/ or own folder is rejected');
select pg_temp.as_user('b');
select pg_temp.expect((select count(*) = 3 from storage.objects where bucket_id = 'feedback-attachments'), 'signed-in user reads attachments');
select pg_temp.expect(pg_temp.affected($s$delete from storage.objects where name = 'screenshots/1-abcdefg.png'$s$) = 0,
  'cannot delete someone else''s upload');
reset role;
set local role service_role;
select pg_temp.as_user('service');
update public.feedback_issues set attachments = '[{"name":"s.png","path":"screenshots/2-abcdefg.png","type":"image/png"}]'
  where issue_key = 'FB-20261014-AB12CD34';
reset role;
set local role authenticated;
select pg_temp.as_user('a');
select pg_temp.expect(pg_temp.affected($s$delete from storage.objects where name = 'screenshots/2-abcdefg.png'$s$) = 0,
  'attachment of a (soft-deleted) issue cannot be deleted');
select pg_temp.expect(pg_temp.affected($s$delete from storage.objects where name = 'screenshots/1-abcdefg.png'$s$) = 1,
  'own unattached upload can be deleted');
reset role;
set local role anon;
select pg_temp.expect_error($s$select count(*) from storage.objects$s$, '42501', null, 'anon cannot read attachments');
reset role;

-- =====================================================================================
-- Security review 2026-10-15: attack scenarios (items 1, 3, 4, 6, 11).
-- =====================================================================================

-- ---- 1. F9 cannot be starved or spoofed by user rows -------------------------------
set local role authenticated;
select pg_temp.as_user('b');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, area, status, priority, author_email)
  values ('FB-20261015-0000F901', 't', 'd', 'bug', 'ops', 'OPEN', 'P3', 'x@y.z')$s$, '42501', null, 'user cannot file an ops-area row');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, ai_suggestion)
  values ('FB-20261015-0000F902', 't', 'd', 'bug', 'OPEN', 'P3', 'x@y.z', '{"source":"f9-ops-agent","fingerprint":"abc"}')$s$, '42501', null,
  'user cannot forge F9 ops metadata');
insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, created_at, updated_at)
values ('FB-20261015-0000F903', 'future', 'd', 'bug', 'OPEN', 'P3', 'x@y.z', '2099-01-01', '2099-01-01');
select pg_temp.expect((select created_at <= now() and updated_at <= now() from public.feedback_issues where issue_key = 'FB-20261015-0000F903'),
  'client created_at / updated_at are replaced by now()');
reset role;

-- ---- 4. identity claims are mandatory ----------------------------------------------------
set local role authenticated;
select pg_temp.as_user('nomail');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, author_name)
  values ('FB-20261015-0000E401', 't', 'd', 'bug', 'OPEN', 'P3', 'hansoo@tecace.com', 'Hansoo Lee')$s$, '42501', null,
  'a JWT without email cannot file an issue under a chosen author');
select pg_temp.as_user('noname');
insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, author_name)
values ('FB-20261015-0000E402', 't', 'd', 'bug', 'OPEN', 'P3', 'x@y.z', 'Hansoo Lee');
select pg_temp.expect((select author_email = 'e@tecace.com' and author_name is null
  from public.feedback_issues where issue_key = 'FB-20261015-0000E402'), 'author_name is the JWT value even when that is null');
select pg_temp.as_user('admin_nomail');
select pg_temp.expect_error($s$update public.feedback_issues set status = 'IN_PROGRESS', triaged_at = now(), triaged_by = 'hansoo@tecace.com'
  where issue_key = 'FB-20261015-0000E402'$s$, '42501', null, 'triage save without a JWT email is rejected (no triaged_by fallback)');
reset role;

-- ---- 6. attachments must be the caller's own uploads -----------------------------------
set local role authenticated;
select pg_temp.as_user('a');
insert into storage.objects (bucket_id, name, owner_id) values
  ('feedback-attachments', 'screenshots/1760000000000-11111111-2222-4333-8444-555555555555.png', 'aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.as_user('b');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, attachments)
  values ('FB-20261015-0000A601', 't', 'd', 'bug', 'OPEN', 'P3', 'x@y.z',
  '[{"name":"x.png","path":"screenshots/1760000000000-11111111-2222-4333-8444-555555555555.png","type":"image/png"}]')$s$, '42501', null,
  'cannot pin someone else''s upload as an attachment');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, attachments)
  values ('FB-20261015-0000A602', 't', 'd', 'bug', 'OPEN', 'P3', 'x@y.z',
  '[{"name":"x.png","path":"../meeting-note-images/victim/x.png","type":"image/png"}]')$s$, '42501', null,
  'path traversal attachment is rejected');
select pg_temp.expect_error($s$insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, attachments)
  values ('FB-20261015-0000A603', 't', 'd', 'bug', 'OPEN', 'P3', 'x@y.z', '{"path":"screenshots/a.png"}')$s$, '42501', null,
  'non-array attachments are rejected');
select pg_temp.as_user('a');
insert into public.feedback_issues (issue_key, title, description, purpose, status, priority, author_email, attachments)
values ('FB-20261015-0000A604', 't', 'd', 'bug', 'OPEN', 'P3', 'x@y.z',
  '[{"name":"x.png","path":"screenshots/1760000000000-11111111-2222-4333-8444-555555555555.png","type":"image/png"}]');
select pg_temp.expect((select jsonb_array_length(attachments) = 1 from public.feedback_issues where issue_key = 'FB-20261015-0000A604'),
  'own upload can be attached');
select pg_temp.expect(pg_temp.affected($s$delete from storage.objects where name = 'screenshots/1760000000000-11111111-2222-4333-8444-555555555555.png'$s$) = 0,
  'attached own upload can no longer be deleted');
reset role;

-- ---- 3. the user directory cannot be poisoned ---------------------------------------
set local role authenticated;
select pg_temp.as_user('a');
insert into public.app_user (microsoft_id, display_name, email, last_seen_at)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'Hansoo Lee', 'hansoo@tecace.com', '2099-01-01')
on conflict (microsoft_id) do update set display_name = excluded.display_name, email = excluded.email, last_seen_at = excluded.last_seen_at;
select pg_temp.expect((select email = 'a.user@tecace.com' and display_name = 'User A' and last_seen_at <= now()
  from public.app_user where microsoft_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'registerAppUser-style upsert keeps the JWT email / name and server time');
select pg_temp.expect_error($s$insert into public.app_user (microsoft_id, display_name, email)
  values ('ffffffff-0000-4000-8000-000000000006', 'Fake', 'fake@tecace.com')$s$, '42501', null, 'cannot create another user''s directory row');
select pg_temp.as_user('noname');
insert into public.app_user (microsoft_id, display_name, email) values ('eeeeeeee-0000-4000-8000-000000000005', 'Gene Kim', 'genekim@tecace.com');
select pg_temp.expect((select email = 'e@tecace.com' and display_name = 'User'
  from public.app_user where microsoft_id = 'eeeeeeee-0000-4000-8000-000000000005'), 'first registration also takes identity from the JWT');
select pg_temp.expect((select count(*) = 0 from public.list_issue_directory() where display_name in ('Hansoo Lee', 'Gene Kim')),
  'directory shows no planted names');
reset role;
set local role service_role;
select pg_temp.as_user('service');
update public.app_user set display_name = 'Admin Set' where microsoft_id = 'cccccccc-0000-4000-8000-000000000003';
select pg_temp.expect((select display_name = 'Admin Set' from public.app_user where microsoft_id = 'cccccccc-0000-4000-8000-000000000003'),
  'service role writes app_user unchanged');
reset role;

-- ---- 11. least-privilege function grants and hardened search_path --------------------
select pg_temp.expect(not has_function_privilege('anon', 'public.feedback_issues_is_admin_id(text)', 'EXECUTE'), 'anon cannot run the admin check');
select pg_temp.expect(not has_function_privilege('anon', 'public.feedback_issues_can(text)', 'EXECUTE'), 'anon cannot run the permission check');
select pg_temp.expect(not has_function_privilege('anon', 'public.feedback_attachments_owned(jsonb)', 'EXECUTE'), 'anon cannot run the ownership check');
select pg_temp.expect(not has_function_privilege('anon', 'public.feedback_attachment_in_use(text)', 'EXECUTE'), 'anon cannot run the in-use check');
select pg_temp.expect(has_function_privilege('authenticated', 'public.feedback_issues_can(text)', 'EXECUTE'), 'authenticated keeps the permission check');
select pg_temp.expect(not has_table_privilege('authenticated', 'public.issue_notify_recipients', 'UPDATE'), 'recipients have no UPDATE grant');
select pg_temp.expect(not has_table_privilege('anon', 'public.issue_notify_recipients', 'SELECT'), 'anon cannot read recipients');
select pg_temp.expect((select bool_and(coalesce(p.proconfig, '{}') @> array['search_path=public, pg_temp'])
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like 'feedback_%' or p.proname in
    ('soft_delete_feedback_issue', 'list_issue_directory', 'app_user_stamp_identity', 'issue_notify_recipients_stamp'))),
  'every helper pins search_path to public, pg_temp');

select count(*) as passed_feedback_checks from fb_checks;
rollback;
