-- M4 follow-up (symmetric to add_note_to_project_for_user): let the MCP server REMOVE a
-- note from a project ON BEHALF OF a scoped user. The existing remove_note_from_owned_project
-- derives the caller from auth.jwt()->>'sub', which is NULL under the MCP's service_role
-- client. This variant takes the user id explicitly (the MCP's trusted scoped user, from the
-- M1 fail-closed auth) and is granted to service_role ONLY, so a normal authenticated user
-- cannot call it to mutate another user's data. Logic + ownership checks mirror the
-- auth-context RPC: the project must be owned by the user; the note is unlinked only where the
-- user owns or is shared on it.
create or replace function public.remove_note_from_project_for_user(p_note_id text, p_project_id text, p_user_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id text := p_user_id;
  note_projects_type text;
  project_notes_type text;
begin
  if current_user_id is null or current_user_id = '' then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1 from public.project
    where id::text = p_project_id and user_id = current_user_id
  ) then
    raise exception 'Project not found or not owned by current user';
  end if;

  -- Match the actual array element types of note.projects / project.notes (they have
  -- differed across migrations), same defensive approach as remove_note_from_owned_project.
  select format_type(a.atttypid, a.atttypmod)
  into note_projects_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'note' and a.attname = 'projects' and not a.attisdropped;

  select format_type(a.atttypid, a.atttypmod)
  into project_notes_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'project' and a.attname = 'notes' and not a.attisdropped;

  execute format(
    'update public.note n
     set projects = coalesce(
       (select array_agg(value) from unnest(coalesce(n.projects, array[]::%1$s)) as value where value::text <> $1),
       array[]::%1$s
     )
     where n.id::text = $2
       and (n.user_id = $3 or coalesce(n.shared_users, array[]::text[]) @> array[$3])',
    note_projects_type
  ) using p_project_id, p_note_id, current_user_id;

  execute format(
    'update public.project p
     set notes = coalesce(
       (select array_agg(value) from unnest(coalesce(p.notes, array[]::%1$s)) as value where value::text <> $1),
       array[]::%1$s
     )
     where p.id::text = $2 and p.user_id = $3',
    project_notes_type
  ) using p_note_id, p_project_id, current_user_id;
end;
$$;

revoke all on function public.remove_note_from_project_for_user(text, text, text) from public;
grant execute on function public.remove_note_from_project_for_user(text, text, text) to service_role;

notify pgrst, 'reload schema';
