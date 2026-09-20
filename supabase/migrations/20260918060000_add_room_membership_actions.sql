create or replace function public.kick_room_member(p_room_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  target_member public.room_members;
  active_count integer;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  select * into target_room
  from public.rooms
  where id = p_room_id
  for update;

  if target_room.id is null or target_room.owner_id <> current_user_id then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;
  if target_room.stage <> 'collecting' then
    raise exception using errcode = 'P0001', message = 'room_already_started';
  end if;
  if not exists (
    select 1
    from public.room_members
    where room_id = p_room_id
      and user_id = current_user_id
      and role = 'host'
      and status = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;

  select * into target_member
  from public.room_members
  where room_id = p_room_id and user_id = p_user_id
  for update;

  if target_member.user_id is null or target_member.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'member_not_found';
  end if;
  if target_member.role = 'host' then
    raise exception using errcode = 'P0001', message = 'host_cannot_be_kicked';
  end if;

  update public.room_members
  set status = 'kicked'
  where room_id = p_room_id and user_id = p_user_id;

  select count(*) into active_count
  from public.room_members
  where room_id = p_room_id and status = 'active';

  update public.rooms
  set member_count = active_count,
      name = case when is_auto_name
        then regexp_replace(name, ' - [0-9]+명$', ' - ' || active_count || '명')
        else name end,
      updated_at = now()
  where id = p_room_id
  returning * into target_room;

  return jsonb_build_object(
    'room', to_jsonb(target_room),
    'nickname', target_member.nickname,
    'member_count', active_count
  );
end;
$$;

create or replace function public.leave_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  current_membership public.room_members;
  active_count integer;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  select * into target_room
  from public.rooms
  where id = p_room_id
  for update;

  if target_room.id is null then
    raise exception using errcode = 'P0001', message = 'room_not_found';
  end if;
  if target_room.stage <> 'collecting' then
    raise exception using errcode = 'P0001', message = 'room_already_started';
  end if;

  select * into current_membership
  from public.room_members
  where room_id = p_room_id and user_id = current_user_id
  for update;

  if current_membership.user_id is null or current_membership.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'room_access_denied';
  end if;
  if current_membership.role = 'host' or target_room.owner_id = current_user_id then
    raise exception using errcode = 'P0001', message = 'host_cannot_leave';
  end if;

  update public.room_members
  set status = 'left'
  where room_id = p_room_id and user_id = current_user_id;

  select count(*) into active_count
  from public.room_members
  where room_id = p_room_id and status = 'active';

  update public.rooms
  set member_count = active_count,
      name = case when is_auto_name
        then regexp_replace(name, ' - [0-9]+명$', ' - ' || active_count || '명')
        else name end,
      updated_at = now()
  where id = p_room_id
  returning * into target_room;

  return jsonb_build_object(
    'room', to_jsonb(target_room),
    'nickname', current_membership.nickname,
    'member_count', active_count
  );
end;
$$;

revoke all on function public.kick_room_member(uuid, uuid) from public, anon;
revoke all on function public.leave_room(uuid) from public, anon;
grant execute on function public.kick_room_member(uuid, uuid) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;
