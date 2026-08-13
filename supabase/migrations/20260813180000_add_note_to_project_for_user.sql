-- M4 (MCP write tool): let the MCP server add an accessible note to a project ON BEHALF
-- OF a scoped user. The existing add_accessible_note_to_project derives the caller from
-- auth.jwt()->>'sub', which is NULL under the MCP's service_role client — so the MCP
-- (100% read-only until now) could not organize notes. This variant takes the user id
-- explicitly (the MCP's trusted scoped user, established by the M1 fail-closed auth) and
-- is granted to service_role ONLY, so a normal authenticated user cannot call it to spoof
-- another user's identity. Logic + ownership checks are identical to the auth-context RPC.
create or replace function public.add_note_to_project_for_user(p_note_id text, p_project_id text, p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id text := p_user_id;
  project_owner_id text;
  note_projects_type text;
  note_projects_element_type text;
  project_notes_type text;
  project_notes_element_type text;
begin
  if current_user_id is null or current_user_id = '' then
    raise exception 'Not authenticated';
  end if;

  select user_id into project_owner_id from public.project where id::text = p_project_id;
  if project_owner_id is null then
    raise exception 'Project not found';
  end if;
  if project_owner_id <> current_user_id then
    raise exception 'Only the project owner can add notes to this project';
  end if;

  if not exists (
    select 1 from public.note
    where id::text = p_note_id
      and (user_id = current_user_id or coalesce(shared_users, array[]::text[]) @> array[current_user_id])
  ) then
    raise exception 'Note not found or not accessible';
  end if;

  -- Match the actual array element types of note.projects / project.notes (they have
  -- differed across migrations), same defensive approach as add_accessible_note_to_project.
  select format_type(a.atttypid, a.atttypmod), format_type(t.typelem, null)
  into note_projects_type, note_projects_element_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  where n.nspname = 'public' and c.relname = 'note' and a.attname = 'projects' and not a.attisdropped;

  select format_type(a.atttypid, a.atttypmod), format_type(t.typelem, null)
  into project_notes_type, project_notes_element_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  where n.nspname = 'public' and c.relname = 'project' and a.attname = 'notes' and not a.attisdropped;

  if note_projects_type is null or note_projects_element_type = '-' then
    raise exception 'note.projects must be an array column';
  end if;
  if project_notes_type is null or project_notes_element_type = '-' then
    raise exception 'project.notes must be an array column';
  end if;

  execute format(
    'update public.note n
     set projects = coalesce(
       (select array_agg(distinct value) from unnest(coalesce(n.projects, array[]::%1$s) || array[$1::%2$s]) as value),
       array[]::%1$s
     )
     where n.id::text = $2',
    note_projects_type, note_projects_element_type
  ) using p_project_id, p_note_id;

  execute format(
    'update public.project p
     set notes = coalesce(
       (select array_agg(distinct value) from unnest(coalesce(p.notes, array[]::%1$s) || array[$1::%2$s]) as value),
       array[]::%1$s
     )
     where p.id::text = $2 and p.user_id = $3',
    project_notes_type, project_notes_element_type
  ) using p_note_id, p_project_id, current_user_id;
end;
$$;

revoke all on function public.add_note_to_project_for_user(text, text, text) from public;
grant execute on function public.add_note_to_project_for_user(text, text, text) to service_role;

notify pgrst, 'reload schema';
