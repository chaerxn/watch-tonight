create or replace function public.inspect_invite_room(p_invite_code text)
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
  invite_status text;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  select * into target_room from public.rooms
  where invite_code = btrim(coalesce(p_invite_code, ''));
  if target_room.id is null then
    raise exception using errcode = 'P0001', message = 'invalid_invite';
  end if;

  select * into current_membership from public.room_members
  where room_id = target_room.id and user_id = current_user_id;
  select count(*) into active_count from public.room_members
  where room_id = target_room.id and status = 'active';

  invite_status := case
    when current_membership.status = 'active' then 'already_member'
    when current_membership.status = 'kicked' then 'kicked'
    when target_room.stage <> 'collecting' then 'started'
    when active_count >= 8 then 'full'
    else 'open'
  end;

  return jsonb_build_object(
    'room', to_jsonb(target_room),
    'member_count', active_count,
    'status', invite_status,
    'nickname', case when current_membership.status = 'active' then current_membership.nickname else null end
  );
end;
$$;

create or replace function public.join_room_by_invite(p_invite_code text, p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  current_membership public.room_members;
  clean_nickname text := btrim(coalesce(p_nickname, ''));
  active_count integer;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  select * into target_room from public.rooms
  where invite_code = btrim(coalesce(p_invite_code, '')) for update;
  if target_room.id is null then
    raise exception using errcode = 'P0001', message = 'invalid_invite';
  end if;

  select * into current_membership from public.room_members
  where room_id = target_room.id and user_id = current_user_id;
  if current_membership.status = 'active' then
    return jsonb_build_object('room', to_jsonb(target_room), 'nickname', current_membership.nickname);
  end if;
  if current_membership.status = 'kicked' then
    raise exception using errcode = 'P0001', message = 'member_kicked';
  end if;
  if target_room.stage <> 'collecting' then
    raise exception using errcode = 'P0001', message = 'room_already_started';
  end if;
  if char_length(clean_nickname) not between 1 and 6 or clean_nickname ~ '[[:space:]]' then
    raise exception using errcode = 'P0001', message = 'invalid_nickname';
  end if;

  select count(*) into active_count from public.room_members
  where room_id = target_room.id and status = 'active';
  if active_count >= 8 then
    raise exception using errcode = 'P0001', message = 'room_full';
  end if;
  if exists (
    select 1 from public.room_members
    where room_id = target_room.id and status = 'active' and lower(nickname) = lower(clean_nickname)
  ) then
    raise exception using errcode = 'P0001', message = 'nickname_duplicate';
  end if;

  insert into public.room_members (room_id, user_id, nickname, role, status)
  values (target_room.id, current_user_id, clean_nickname, 'member', 'active')
  on conflict (room_id, user_id) do update
    set nickname = excluded.nickname, role = 'member', status = 'active', joined_at = now()
    where public.room_members.status = 'left';

  active_count := active_count + 1;
  update public.rooms
  set member_count = active_count,
      name = case when is_auto_name
        then regexp_replace(name, ' - [0-9]+명$', ' - ' || active_count || '명')
        else name end,
      updated_at = now()
  where id = target_room.id
  returning * into target_room;

  return jsonb_build_object('room', to_jsonb(target_room), 'nickname', clean_nickname);
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'nickname_duplicate';
end;
$$;

revoke all on function public.inspect_invite_room(text) from public, anon;
revoke all on function public.join_room_by_invite(text, text) from public, anon;
grant execute on function public.inspect_invite_room(text) to authenticated;
grant execute on function public.join_room_by_invite(text, text) to authenticated;
