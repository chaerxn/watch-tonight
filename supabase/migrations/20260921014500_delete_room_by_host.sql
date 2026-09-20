create or replace function public.delete_room_by_host(p_room_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  select * into target_room
  from public.rooms
  where id = p_room_id
  for update;

  if target_room.id is null then
    return p_room_id;
  end if;

  if target_room.owner_id <> current_user_id or not exists (
    select 1
    from public.room_members
    where room_id = p_room_id
      and user_id = current_user_id
      and role = 'host'
      and status = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;

  delete from public.rooms where id = p_room_id;
  return p_room_id;
end;
$$;

revoke all on function public.delete_room_by_host(uuid) from public, anon;
grant execute on function public.delete_room_by_host(uuid) to authenticated;
