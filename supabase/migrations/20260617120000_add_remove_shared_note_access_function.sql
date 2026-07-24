create or replace function public.remove_current_user_from_note_shared_users(p_note_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id text := auth.jwt() ->> 'sub';
begin
  if current_user_id is null or current_user_id = '' then
    raise exception 'Not authenticated';
  end if;

  update public.note n
  set shared_users = coalesce(
    array(
      select distinct shared_user_id
      from unnest(coalesce(n.shared_users, array[]::text[])) as shared_user_id
      where shared_user_id <> current_user_id
    ),
    array[]::text[]
  )
  where n.id = p_note_id
    and n.user_id <> current_user_id
    and coalesce(n.shared_users, array[]::text[]) @> array[current_user_id];
end;
$$;

grant execute on function public.remove_current_user_from_note_shared_users(text) to authenticated;
