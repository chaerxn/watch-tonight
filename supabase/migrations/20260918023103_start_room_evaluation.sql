create or replace function public.start_room_evaluation(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  active_member_count integer;
  room_candidate_count integer;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  select *
    into target_room
  from public.rooms
  where id = p_room_id
  for update;

  if target_room.id is null then
    raise exception using errcode = 'P0001', message = 'room_access_denied';
  end if;

  if target_room.owner_id <> current_user_id
     or not exists (
       select 1
       from public.room_members m
       where m.room_id = p_room_id
         and m.user_id = current_user_id
         and m.role = 'host'
         and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;

  if target_room.stage = 'rating' then
    return target_room;
  end if;

  if target_room.stage <> 'collecting' then
    raise exception using errcode = 'P0001', message = 'room_already_started';
  end if;

  select count(*)
    into active_member_count
  from public.room_members m
  where m.room_id = p_room_id
    and m.status = 'active';

  if active_member_count < 2 then
    raise exception using errcode = 'P0001', message = 'member_count_too_low';
  end if;

  select count(*)
    into room_candidate_count
  from public.candidates c
  where c.room_id = p_room_id;

  if room_candidate_count < 2 then
    raise exception using errcode = 'P0001', message = 'candidate_count_too_low';
  end if;

  update public.rooms
  set stage = 'rating',
      member_count = active_member_count,
      name = case
        when is_auto_name then regexp_replace(name, ' - [0-9]+명$', ' - ' || active_member_count || '명')
        else name
      end,
      updated_at = now()
  where id = p_room_id
  returning * into target_room;

  return target_room;
end;
$$;

revoke all on function public.start_room_evaluation(uuid) from public;
revoke all on function public.start_room_evaluation(uuid) from anon;
grant execute on function public.start_room_evaluation(uuid) to authenticated;
