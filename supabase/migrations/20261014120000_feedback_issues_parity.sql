-- =====================================================================================
-- F2 feedback / issue tracker: permission + data parity with the FEEDBACK-ISSUES SPEC
-- (docs/feedback-issues-porting-prompt.md, sections 3.1 SEC, 3.2 DATA, 4, 5.1, 5.2),
-- hardened after the 2026-10-15 security review.
--
-- WHAT THIS DOES (one file, run it whole, once; re-running is safe / idempotent):
--   1. Permission helpers. Three levels (SEC-2) on a two-role app:
--        'issues'        = any signed-in user (Supabase JWT minted by supabase-token)
--        'issues.triage' = app admin   (triage save, AI resolution save)
--        'issues.notify' = app admin   (notification recipient changes)
--      Admin = the same Microsoft object ids as src/lib/adminAccess.ts (SEC-10).
--   2. feedback_issues RLS: replaces the old team-wide OPEN policies (any signed-in user
--      could triage / soft-delete anyone's issue) with: read = issues, insert = issues +
--      initial state only (SEC-3), update = issues.triage on live rows only (SEC-6).
--      Users cannot file rows that look like F9 ops tickets, and may only attach objects
--      they uploaded themselves.
--   3. Server-stamped columns (SEC-4, SEC-4b, DATA-4): author, created_at / updated_at from
--      the server on insert, severity = severityOf(priority) on every write, triaged_at/by
--      and resolution_generated_at stamped by the DB, immutable fields locked on update.
--      A user JWT without an email claim is rejected (no client-chosen author).
--   4. soft_delete_feedback_issue(uuid) RPC: author-only soft delete (SEC-5).
--   5. list_issue_directory() RPC: name + email of app users for the assignee filter and
--      recipient picker (spec C3). app_user email / display_name now come from the JWT, so a
--      user cannot plant a fake name or someone else's address in the directory.
--   6. issue_notify_recipients table (RCPT-1) + seed of the first recipient (empty only).
--   7. Storage bucket feedback-attachments: private, 10 MB, explicit image types + PDF (no
--      SVG); read/upload = issues, delete = own upload that no issue references (SEC-7).
--
-- PRECONDITIONS
--   - 20260812230000_create_feedback_issues.sql is applied (table + bucket exist).
--   - 20260528120000_create_app_user_table.sql is applied (public.app_user exists).
--   - supabase-token edge function mints JWTs with `sub` (Microsoft object id), `email` and
--     `user_metadata.name` claims (already true in prod; mobile uses the same exchange).
--
-- DEPLOY ORDER (confirmed 2026-10-15, option "B"):
--   1. Push to main. Render deploys workflow-server and the frontend (both work before this
--      migration, except that new screenshot uploads are refused by the OLD storage policy
--      until step 2 runs; the error is shown on screen).
--   2. Immediately run THIS FILE in the Supabase SQL Editor (paste the whole file, run once).
--   3. Run the post-check queries below.
--   Mobile needs no change: its insert payload (status OPEN, attachments [], no assignee /
--   triage / resolution / deleted_at, FB-YYYYMMDD-XXXXXXXX key) passes the new insert
--   policy, and its author fields are overwritten from the same JWT.
--
-- PRE-CHECK QUERIES (run first, read-only):
--   select policyname, cmd from pg_policies where tablename = 'feedback_issues';
--   select policyname from pg_policies where schemaname = 'storage' and policyname like 'feedback_attachments%';
--   select status, count(*) from public.feedback_issues group by status;          -- TRIAGE rows read as OPEN
--   select count(*) from public.feedback_issues where issue_key !~ '^(FB|OPS)-[0-9]{8}-[0-9A-F]{8}$';
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'feedback-attachments';
--   select count(*) from public.app_user where position('@' in coalesce(email, '')) > 1;
--   select proname from pg_proc where proname in ('feedback_issues_can', 'soft_delete_feedback_issue',
--     'list_issue_directory', 'feedback_attachment_in_use');                      -- expect 0 rows before
--   -- (a) Rows with an invalid priority. Any later update of such a row is REJECTED by the
--   --     severity trigger. If the count is > 0, fix them first:
--   --       update public.feedback_issues set priority = 'P3' where priority not in ('P1','P2','P3','P4');
--   select count(*) from public.feedback_issues where priority not in ('P1', 'P2', 'P3', 'P4');
--   -- (b) Issues whose author_email matches no app_user email. Those authors were stored with
--   --     a different spelling (e.g. UPN vs mail) and cannot delete their own issue through the
--   --     RPC, which compares with the JWT email. If the count is > 0, review the rows and,
--   --     when the person is clearly the same, align author_email to their app_user.email.
--   --     F9 rows (author ops-agent@tecace.com) are expected here and need no action.
--   select count(*) from public.feedback_issues f
--    where not exists (select 1 from public.app_user u where lower(u.email) = lower(f.author_email));
--
-- POST-CHECK QUERIES (after running):
--   select policyname, cmd from pg_policies where tablename in ('feedback_issues', 'issue_notify_recipients', 'app_user');
--   select * from public.issue_notify_recipients;                                 -- expect the seed row
--   select allowed_mime_types from storage.buckets where id = 'feedback-attachments';
--
-- ROLLBACK (restores the pre-migration open behaviour; run as one block if needed).
-- The FRONTEND MUST BE ROLLED BACK TOGETHER: the old storage insert policy only accepts the
-- <sub>/... prefix, so the new frontend's screenshots/... uploads break after this rollback.
--   begin;
--   drop policy if exists feedback_issues_read_by_feature on public.feedback_issues;
--   drop policy if exists feedback_issues_insert_by_feature on public.feedback_issues;
--   drop policy if exists feedback_issues_update_by_triage on public.feedback_issues;
--   drop policy if exists feedback_issues_authenticated_read on public.feedback_issues;
--   create policy feedback_issues_authenticated_read on public.feedback_issues for select to authenticated using (true);
--   drop policy if exists feedback_issues_authenticated_insert on public.feedback_issues;
--   create policy feedback_issues_authenticated_insert on public.feedback_issues for insert to authenticated with check (true);
--   drop policy if exists feedback_issues_authenticated_update on public.feedback_issues;
--   create policy feedback_issues_authenticated_update on public.feedback_issues for update to authenticated using (true) with check (true);
--   drop trigger if exists trg_feedback_issues_stamp_insert on public.feedback_issues;
--   drop trigger if exists trg_feedback_issues_stamp_update on public.feedback_issues;
--   drop trigger if exists trg_app_user_stamp_identity on public.app_user;
--   drop function if exists public.soft_delete_feedback_issue(uuid);
--   drop function if exists public.list_issue_directory();
--   drop policy if exists feedback_attachments_read_by_feature on storage.objects;
--   drop policy if exists feedback_attachments_insert_by_feature on storage.objects;
--   drop policy if exists feedback_attachments_delete_unattached on storage.objects;
--   drop policy if exists feedback_attachments_service_role on storage.objects;
--   drop policy if exists feedback_attachments_authenticated_read on storage.objects;
--   create policy feedback_attachments_authenticated_read on storage.objects for select to authenticated
--     using (bucket_id = 'feedback-attachments');
--   drop policy if exists feedback_attachments_authenticated_insert on storage.objects;
--   create policy feedback_attachments_authenticated_insert on storage.objects for insert to authenticated
--     with check (bucket_id = 'feedback-attachments' and (storage.foldername(name))[1] = auth.jwt() ->> 'sub');
--   drop policy if exists feedback_attachments_authenticated_delete on storage.objects;
--   create policy feedback_attachments_authenticated_delete on storage.objects for delete to authenticated
--     using (bucket_id = 'feedback-attachments' and (storage.foldername(name))[1] = auth.jwt() ->> 'sub');
--   update storage.buckets
--      set allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif','application/pdf']
--    where id = 'feedback-attachments';
--   drop function if exists public.feedback_attachment_in_use(text);
--   drop function if exists public.feedback_attachments_owned(jsonb);
--   -- issue_notify_recipients is kept on rollback (the server falls back when it is missing,
--   -- dropping it loses the admin-chosen list). To remove it as well:
--   --   drop table if exists public.issue_notify_recipients;
--   commit;
--   (The helper functions feedback_issues_* are harmless to keep; drop them last if wanted.)
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 1. Permission helpers
-- ---------------------------------------------------------------------------

-- Email of the signed-in caller, lower-cased; null for service_role / SQL editor.
-- Same source as the server's "self" checks (Graph mail, else UPN) -> SEC-11.
create or replace function public.feedback_issues_auth_email()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select lower(nullif(trim(coalesce(auth.jwt() ->> 'email', '')), ''));
$$;

-- Display name of the signed-in caller from the JWT; null when absent.
create or replace function public.feedback_issues_auth_name()
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select nullif(trim(coalesce(auth.jwt() -> 'user_metadata' ->> 'name', '')), '');
$$;

-- True only for a browser / mobile request carrying a user JWT.
create or replace function public.feedback_issues_is_end_user()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'authenticated'
     and coalesce(auth.jwt() ->> 'sub', '') <> '';
$$;

-- SEC-10: SAME RULE AS src/lib/issues/permissions.ts (canIssue) + src/lib/adminAccess.ts
-- (ADMIN_MICROSOFT_USER_IDS) and workflow-server/src/issues.ts (ISSUE_ADMIN_MICROSOFT_IDS).
-- Change all three together.
create or replace function public.feedback_issues_is_admin_id(p_microsoft_id text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_microsoft_id, '') = any (array[
    'd84c9149-2261-4ced-b14c-01b1a377ba6b',  -- Hansoo Lee
    'd9eb0f3d-819e-4b45-8df6-e9f229de2447',  -- Gene Kim
    '31d79bfe-2488-47c2-aa45-949375e93bde'   -- Andrew Yoo
  ]);
$$;

-- SEC-2 / SEC-10: can(caller, key). Keys: 'issues' | 'issues.triage' | 'issues.notify'.
create or replace function public.feedback_issues_can(p_key text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case p_key
    when 'issues' then public.feedback_issues_is_end_user()
    when 'issues.triage' then public.feedback_issues_is_end_user()
      and public.feedback_issues_is_admin_id(auth.jwt() ->> 'sub')
    when 'issues.notify' then public.feedback_issues_is_end_user()
      and public.feedback_issues_is_admin_id(auth.jwt() ->> 'sub')
    else false
  end;
$$;

-- DATA-4: severityOf(priority). Null for an unknown priority (the trigger rejects it).
create or replace function public.feedback_issues_severity_of(p_priority text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_priority
    when 'P1' then 'Critical'
    when 'P2' then 'High'
    when 'P3' then 'Medium'
    when 'P4' then 'Low'
  end;
$$;

-- Attachment object path allowed in this bucket: screenshots/<file> (new) or <uuid>/<file>
-- (legacy). Same rule as isSafeAttachmentPath in workflow-server/src/issues.ts.
create or replace function public.feedback_attachment_path_ok(p_path text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_path, '') ~ '^(screenshots|[0-9a-f-]{36})/[A-Za-z0-9._-]+$'
     and position('..' in p_path) = 0;
$$;

-- True when every attachment of a new issue is an object the caller uploaded, so a user
-- cannot pin someone else's file as "in use" (which would block its deletion).
create or replace function public.feedback_attachments_owned(p_attachments jsonb)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_attachments is null then true
    when jsonb_typeof(p_attachments) <> 'array' then false
    else not exists (
      select 1
      from jsonb_array_elements(p_attachments) a
      where jsonb_typeof(a) <> 'object'
         or not public.feedback_attachment_path_ok(a ->> 'path')
         or not exists (
           select 1 from storage.objects o
           where o.bucket_id = 'feedback-attachments'
             and o.name = a ->> 'path'
             and o.owner_id = auth.jwt() ->> 'sub'
         )
    )
  end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.feedback_issues_auth_email()',
    'public.feedback_issues_auth_name()',
    'public.feedback_issues_is_end_user()',
    'public.feedback_issues_is_admin_id(text)',
    'public.feedback_issues_can(text)',
    'public.feedback_issues_severity_of(text)',
    'public.feedback_attachment_path_ok(text)',
    'public.feedback_attachments_owned(jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Server-stamped columns (triggers)
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
    else
      new.triaged_by := old.triaged_by;
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

-- The updated_at trigger function from 20260812230000 gets the same hardened search_path.
alter function public.feedback_issues_set_updated_at() set search_path = public, pg_temp;
revoke all on function public.feedback_issues_set_updated_at() from public, anon;

revoke all on function public.feedback_issues_stamp_insert() from public, anon;
revoke all on function public.feedback_issues_stamp_update() from public, anon;

drop trigger if exists trg_feedback_issues_stamp_insert on public.feedback_issues;
create trigger trg_feedback_issues_stamp_insert
  before insert on public.feedback_issues
  for each row execute function public.feedback_issues_stamp_insert();

drop trigger if exists trg_feedback_issues_stamp_update on public.feedback_issues;
create trigger trg_feedback_issues_stamp_update
  before update on public.feedback_issues
  for each row execute function public.feedback_issues_stamp_update();

-- ---------------------------------------------------------------------------
-- 3. feedback_issues row level security
-- ---------------------------------------------------------------------------

alter table public.feedback_issues enable row level security;
grant select, insert, update on public.feedback_issues to authenticated;

-- Permissive policies OR together, so the old open ones must go first.
drop policy if exists feedback_issues_authenticated_read on public.feedback_issues;
drop policy if exists feedback_issues_authenticated_insert on public.feedback_issues;
drop policy if exists feedback_issues_authenticated_update on public.feedback_issues;

-- DATA-5: the read rule does NOT hide soft-deleted rows (lists filter deleted_at instead).
drop policy if exists feedback_issues_read_by_feature on public.feedback_issues;
create policy feedback_issues_read_by_feature
  on public.feedback_issues for select to authenticated
  using (public.feedback_issues_can('issues'));

-- SEC-3 + DATA-2: a new issue arrives only in its initial state with an FB key. Rows that
-- look like F9 ops tickets (area 'ops' / ops metadata) are reserved for the service role,
-- and attachments must be the caller's own uploads.
drop policy if exists feedback_issues_insert_by_feature on public.feedback_issues;
create policy feedback_issues_insert_by_feature
  on public.feedback_issues for insert to authenticated
  with check (
    public.feedback_issues_can('issues')
    and status = 'OPEN'
    and assignee_email is null
    and assignee_name is null
    and triage_note is null
    and triaged_at is null
    and triaged_by is null
    and resolution is null
    and resolution_generated_at is null
    and resolution_model is null
    and deleted_at is null
    and issue_key ~ '^FB-[0-9]{8}-[0-9A-F]{8}$'
    and area <> 'ops'
    and coalesce(ai_suggestion ->> 'source', '') <> 'f9-ops-agent'
    and public.feedback_attachments_owned(attachments)
  );

-- SEC-6: triage writes only live rows and can never set deleted_at.
drop policy if exists feedback_issues_update_by_triage on public.feedback_issues;
create policy feedback_issues_update_by_triage
  on public.feedback_issues for update to authenticated
  using (public.feedback_issues_can('issues.triage') and deleted_at is null)
  with check (public.feedback_issues_can('issues.triage') and deleted_at is null);

-- The workflow-server (F9 ops agent, email rendering) keeps full access.
drop policy if exists feedback_issues_service_role on public.feedback_issues;
create policy feedback_issues_service_role
  on public.feedback_issues for all to service_role using (true) with check (true);

create index if not exists idx_feedback_issues_attachments
  on public.feedback_issues using gin (attachments jsonb_path_ops);
create index if not exists idx_feedback_issues_author_created
  on public.feedback_issues (lower(author_email), created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Soft delete RPC (SEC-5): author only, sets deleted_at only
-- ---------------------------------------------------------------------------

create or replace function public.soft_delete_feedback_issue(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := public.feedback_issues_auth_email();
begin
  if v_email is null or not public.feedback_issues_can('issues') then
    raise exception '이슈를 삭제할 권한이 없습니다.' using errcode = '42501';
  end if;
  update public.feedback_issues
     set deleted_at = now()
   where id = p_id
     and deleted_at is null
     and lower(author_email) = v_email;
  if not found then
    raise exception '본인이 등록한 이슈만 삭제할 수 있습니다.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.soft_delete_feedback_issue(uuid) from public, anon;
grant execute on function public.soft_delete_feedback_issue(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. User directory (spec C3)
-- ---------------------------------------------------------------------------

-- app_user identity comes from the JWT, not from the client payload, so the directory
-- cannot be poisoned with a fake name or another person's address. The service role
-- (admin tools, SQL editor) is not affected.
create or replace function public.app_user_stamp_identity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if public.feedback_issues_is_end_user() then
    new.email := coalesce(public.feedback_issues_auth_email(), '');
    new.display_name := coalesce(public.feedback_issues_auth_name(), 'User');
    new.last_seen_at := now();
    new.updated_at := now();
    if tg_op = 'UPDATE' then
      new.microsoft_id := old.microsoft_id;
      new.first_seen_at := old.first_seen_at;
      new.created_at := old.created_at;
    else
      new.first_seen_at := now();
      new.created_at := now();
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.app_user_stamp_identity() from public, anon;

drop trigger if exists trg_app_user_stamp_identity on public.app_user;
create trigger trg_app_user_stamp_identity
  before insert or update on public.app_user
  for each row execute function public.app_user_stamp_identity();

create or replace function public.list_issue_directory()
returns table (email text, display_name text, is_admin boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.email, d.display_name, d.is_admin
  from (
    select distinct on (lower(u.email))
      lower(u.email) as email,
      case
        when nullif(trim(u.display_name), '') is null then null
        when trim(u.display_name) in ('User', 'Unknown user') then null
        else trim(u.display_name)
      end as display_name,
      public.feedback_issues_is_admin_id(u.microsoft_id) as is_admin
    from public.app_user u
    where public.feedback_issues_can('issues')
      and position('@' in coalesce(u.email, '')) > 1
    order by lower(u.email), u.last_seen_at desc
  ) d
  order by lower(coalesce(d.display_name, d.email)), d.email;
$$;

revoke all on function public.list_issue_directory() from public, anon;
grant execute on function public.list_issue_directory() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Notification recipients (RCPT-1, SEC-9)
-- ---------------------------------------------------------------------------

create table if not exists public.issue_notify_recipients (
  email     text primary key check (email = lower(email) and position('@' in email) > 1),
  added_by  text default public.feedback_issues_auth_email(),
  added_at  timestamptz not null default now()
);

create or replace function public.issue_notify_recipients_stamp()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- SEC-9: added_by is the signed-in caller, never a client-sent value.
  if public.feedback_issues_is_end_user() then
    new.added_by := public.feedback_issues_auth_email();
  end if;
  new.added_at := now();
  return new;
end;
$$;

revoke all on function public.issue_notify_recipients_stamp() from public, anon;

drop trigger if exists trg_issue_notify_recipients_stamp on public.issue_notify_recipients;
create trigger trg_issue_notify_recipients_stamp
  before insert on public.issue_notify_recipients
  for each row execute function public.issue_notify_recipients_stamp();

alter table public.issue_notify_recipients enable row level security;
revoke all on public.issue_notify_recipients from anon;
grant select, insert, delete on public.issue_notify_recipients to authenticated;
grant select, insert, update, delete on public.issue_notify_recipients to service_role;

drop policy if exists issue_notify_recipients_read on public.issue_notify_recipients;
create policy issue_notify_recipients_read
  on public.issue_notify_recipients for select to authenticated
  using (public.feedback_issues_can('issues'));

drop policy if exists issue_notify_recipients_insert on public.issue_notify_recipients;
create policy issue_notify_recipients_insert
  on public.issue_notify_recipients for insert to authenticated
  with check (public.feedback_issues_can('issues.notify'));

drop policy if exists issue_notify_recipients_delete on public.issue_notify_recipients;
create policy issue_notify_recipients_delete
  on public.issue_notify_recipients for delete to authenticated
  using (public.feedback_issues_can('issues.notify'));

drop policy if exists issue_notify_recipients_service_role on public.issue_notify_recipients;
create policy issue_notify_recipients_service_role
  on public.issue_notify_recipients for all to service_role using (true) with check (true);

-- Seed only when empty, so a re-run never overwrites the list an admin edited.
insert into public.issue_notify_recipients (email, added_by)
select 'andrewyoo@tecace.com', 'migration'
where not exists (select 1 from public.issue_notify_recipients);

-- ---------------------------------------------------------------------------
-- 7. Attachment storage (SEC-7, section 4.4)
-- ---------------------------------------------------------------------------

-- Explicit raster image types + PDF. SVG is not allowed (it can carry script).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback-attachments', 'feedback-attachments', false, 10485760, array[
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/heic', 'image/heif', 'application/pdf'
])
on conflict (id) do update
  set public = false,
      file_size_limit = 10485760,
      allowed_mime_types = array[
        'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/heic', 'image/heif', 'application/pdf'
      ];

-- True when any issue (soft-deleted included) references the object path.
create or replace function public.feedback_attachment_in_use(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.feedback_issues i
    where i.attachments @> jsonb_build_array(jsonb_build_object('path', p_path))
  );
$$;

revoke all on function public.feedback_attachment_in_use(text) from public, anon;
grant execute on function public.feedback_attachment_in_use(text) to authenticated, service_role;

drop policy if exists feedback_attachments_authenticated_read on storage.objects;
drop policy if exists feedback_attachments_authenticated_insert on storage.objects;
drop policy if exists feedback_attachments_authenticated_delete on storage.objects;

drop policy if exists feedback_attachments_read_by_feature on storage.objects;
create policy feedback_attachments_read_by_feature
  on storage.objects for select to authenticated
  using (bucket_id = 'feedback-attachments' and public.feedback_issues_can('issues'));

-- New uploads go to screenshots/...; the legacy <sub>/... prefix stays allowed so an
-- older client build keeps working during the deploy window.
drop policy if exists feedback_attachments_insert_by_feature on storage.objects;
create policy feedback_attachments_insert_by_feature
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'feedback-attachments'
    and public.feedback_issues_can('issues')
    and (storage.foldername(name))[1] in ('screenshots', auth.jwt() ->> 'sub')
  );

-- Delete only your own upload (owner_id, AGENTS.md storage rule) and only while no issue
-- references it (a soft-deleted issue still counts).
drop policy if exists feedback_attachments_delete_unattached on storage.objects;
create policy feedback_attachments_delete_unattached
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'feedback-attachments'
    and public.feedback_issues_can('issues')
    and owner_id = auth.jwt() ->> 'sub'
    and not public.feedback_attachment_in_use(name)
  );

drop policy if exists feedback_attachments_service_role on storage.objects;
create policy feedback_attachments_service_role
  on storage.objects for all to service_role
  using (bucket_id = 'feedback-attachments')
  with check (bucket_id = 'feedback-attachments');

notify pgrst, 'reload schema';

-- END OF MIGRATION 20261014120000_feedback_issues_parity.sql (run this whole file once)
