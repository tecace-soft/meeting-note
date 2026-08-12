-- F2: in-app feedback / issue tracker (mini-Jira). One table + one private attachment
-- bucket + RLS, created together so there is never an intermediate half-applied state
-- (the boss's spec §9-2/§9-3: ship the migration whole; bucket and its policies are a set).
--
-- ACCESS MODEL: this is an internal, team-wide tracker — every authenticated user can see
-- and triage every issue (like a shared board), so RLS here is intentionally open to
-- `authenticated` for read/write, the SAME level as the rest of this app's tables. Access
-- control lives at the app layer (Azure MSAL SSO + the tenant/domain allowlist in the
-- supabase-token edge function). The DB does NOT enforce per-issue ownership; author-only
-- delete is enforced in the app/service layer (soft delete via deleted_at).

create table if not exists public.feedback_issues (
  id             uuid primary key default gen_random_uuid(),
  issue_key      text not null unique,            -- FB-20260812-9DC24392 (date + random8, client-generated)
  title          text not null,
  description    text not null,
  purpose        text not null default 'other',   -- bug | feature | question | other
  area           text not null default 'general', -- app screen/area
  status         text not null default 'OPEN',    -- OPEN | TRIAGE | IN_PROGRESS | DONE | CLOSED
  priority       text not null default 'P3',      -- P1..P4
  severity       text not null default 'Medium',  -- Low | Medium | High | Critical
  assignee_email text,
  assignee_name  text,
  triage_note    text,
  ai_suggestion  jsonb,                            -- auto-classify result at creation (display only)
  attachments    jsonb not null default '[]'::jsonb,  -- [{name,url,type,path}]
  resolution     jsonb,                            -- LLM resolution (see IssueResolution)
  resolution_generated_at timestamptz,
  resolution_model text,
  author_email   text not null,
  author_name    text,
  triaged_at     timestamptz,                      -- null = needs triage
  triaged_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz default null          -- soft delete
);

create index if not exists idx_feedback_issues_active
  on public.feedback_issues(deleted_at) where deleted_at is null;
create index if not exists idx_feedback_issues_created on public.feedback_issues(created_at desc);
create index if not exists idx_feedback_issues_status on public.feedback_issues(status);
create index if not exists idx_feedback_issues_assignee on public.feedback_issues(assignee_email);

-- Own, uniquely-named trigger function so this migration cannot possibly overwrite any
-- existing shared function in prod (keeps it fully isolated / non-destructive).
create or replace function public.feedback_issues_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_feedback_issues_updated_at on public.feedback_issues;
create trigger trg_feedback_issues_updated_at
  before update on public.feedback_issues
  for each row execute function public.feedback_issues_set_updated_at();

alter table public.feedback_issues enable row level security;
grant select, insert, update on public.feedback_issues to authenticated;

-- Team-wide board: any authenticated user reads/creates/updates; delete is soft (an update
-- of deleted_at) and author-restricted in the app layer. Service role bypasses for the
-- workflow-server (email/resolution helpers).
drop policy if exists feedback_issues_authenticated_read on public.feedback_issues;
create policy feedback_issues_authenticated_read
  on public.feedback_issues for select to authenticated using (true);

drop policy if exists feedback_issues_authenticated_insert on public.feedback_issues;
create policy feedback_issues_authenticated_insert
  on public.feedback_issues for insert to authenticated with check (true);

drop policy if exists feedback_issues_authenticated_update on public.feedback_issues;
create policy feedback_issues_authenticated_update
  on public.feedback_issues for update to authenticated using (true) with check (true);

drop policy if exists feedback_issues_service_role on public.feedback_issues;
create policy feedback_issues_service_role
  on public.feedback_issues for all to service_role using (true) with check (true);

-- Attachment bucket: private (signed URLs only). Screenshots may hold sensitive UI, so it
-- is NOT public. Any authenticated user can read (shared board); a user may only write
-- under their own id-prefixed folder (mirrors meeting-note-images).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'feedback-attachments',
  'feedback-attachments',
  false,
  10485760, -- 10 MB
  array['image/png','image/jpeg','image/webp','image/gif','application/pdf']
)
on conflict (id) do nothing;

drop policy if exists feedback_attachments_authenticated_read on storage.objects;
create policy feedback_attachments_authenticated_read
  on storage.objects for select to authenticated
  using (bucket_id = 'feedback-attachments');

drop policy if exists feedback_attachments_authenticated_insert on storage.objects;
create policy feedback_attachments_authenticated_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'feedback-attachments'
    and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
  );

drop policy if exists feedback_attachments_authenticated_delete on storage.objects;
create policy feedback_attachments_authenticated_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'feedback-attachments'
    and (storage.foldername(name))[1] = auth.jwt() ->> 'sub'
  );

-- Refresh PostgREST schema cache so the new table is visible immediately (spec §9-2).
notify pgrst, 'reload schema';
