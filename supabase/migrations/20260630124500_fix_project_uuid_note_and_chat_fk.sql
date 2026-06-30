create or replace function public.add_accessible_note_to_project(p_note_id text, p_project_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id text := auth.jwt() ->> 'sub';
  project_owner_id text;
  note_projects_type text;
  note_projects_element_type text;
  project_notes_type text;
  project_notes_element_type text;
begin
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select user_id
  into project_owner_id
  from public.project
  where id::text = p_project_id;

  if project_owner_id is null then
    raise exception 'Project not found';
  end if;

  if project_owner_id <> current_user_id then
    raise exception 'Only the project owner can add notes to this project';
  end if;

  if not exists (
    select 1
    from public.note
    where id::text = p_note_id
      and (
        user_id = current_user_id
        or coalesce(shared_users, array[]::text[]) @> array[current_user_id]
      )
  ) then
    raise exception 'Note not found or not accessible';
  end if;

  select format_type(a.atttypid, a.atttypmod), format_type(t.typelem, null)
  into note_projects_type, note_projects_element_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  where n.nspname = 'public'
    and c.relname = 'note'
    and a.attname = 'projects'
    and not a.attisdropped;

  if note_projects_type is null or note_projects_element_type = '-' then
    raise exception 'note.projects must be an array column';
  end if;

  execute format(
    'update public.note n
     set projects = coalesce(
       (
         select array_agg(distinct value)
         from unnest(coalesce(n.projects, array[]::%1$s) || array[$1::%2$s]) as value
       ),
       array[]::%1$s
     )
     where n.id::text = $2',
    note_projects_type,
    note_projects_element_type
  )
  using p_project_id, p_note_id;

  select format_type(a.atttypid, a.atttypmod), format_type(t.typelem, null)
  into project_notes_type, project_notes_element_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  where n.nspname = 'public'
    and c.relname = 'project'
    and a.attname = 'notes'
    and not a.attisdropped;

  if project_notes_type is not null and project_notes_element_type <> '-' then
    begin
      execute format(
        'update public.project p
         set notes = coalesce(
           (
             select array_agg(distinct value)
             from unnest(coalesce(p.notes, array[]::%1$s) || array[$1::%2$s]) as value
           ),
           array[]::%1$s
         )
         where p.id::text = $2
           and p.user_id = $3',
        project_notes_type,
        project_notes_element_type
      )
      using p_note_id, p_project_id, current_user_id;
    exception
      when invalid_text_representation then
        -- Some databases still have project.notes as bigint[] while note.id is uuid.
        -- note.projects is the authoritative relationship used by the app.
        null;
    end;
  end if;
end;
$$;

grant execute on function public.add_accessible_note_to_project(text, text) to authenticated;

create or replace function public.delete_owned_project(p_project_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id text := auth.jwt() ->> 'sub';
  note_projects_type text;
begin
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1
    from public.project
    where id::text = p_project_id
      and user_id = current_user_id
  ) then
    raise exception 'Project not found or not owned by current user';
  end if;

  select format_type(a.atttypid, a.atttypmod)
  into note_projects_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'note'
    and a.attname = 'projects'
    and not a.attisdropped;

  execute format(
    'update public.note n
     set projects = coalesce(
       (
         select array_agg(value)
         from unnest(coalesce(n.projects, array[]::%1$s)) as value
         where value::text <> $1
       ),
       array[]::%1$s
     )
     where exists (
       select 1
       from unnest(coalesce(n.projects, array[]::%1$s)) as value
       where value::text = $1
     )
       and (
         n.user_id = $2
         or coalesce(n.shared_users, array[]::text[]) @> array[$2]
       )',
    note_projects_type
  )
  using p_project_id, current_user_id;

  if to_regclass('public.chat') is not null then
    execute
      'delete from public.chat where project_id::text = $1'
    using p_project_id;
  end if;

  if to_regclass('public.chat') is not null and to_regclass('public.session') is not null then
    execute
      'delete from public.chat c using public.session s where c.session_id = s.id and s.project_id::text = $1'
    using p_project_id;
  end if;

  if to_regclass('public.session') is not null then
    execute
      'delete from public.session where project_id::text = $1'
    using p_project_id;
  end if;

  delete from public.project
  where id::text = p_project_id
    and user_id = current_user_id;
end;
$$;

grant execute on function public.delete_owned_project(text) to authenticated;
