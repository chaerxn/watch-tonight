create table public.evaluation_ratings (
  room_id uuid not null references public.rooms(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  round smallint not null default 1 check (round in (1, 2)),
  rating text not null check (rating in ('want', 'okay', 'dislike')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (candidate_id, user_id, round),
  foreign key (room_id, user_id)
    references public.room_members(room_id, user_id)
    on delete cascade
);

create index evaluation_ratings_room_user_round_idx
  on public.evaluation_ratings(room_id, user_id, round);

create index evaluation_ratings_user_id_idx
  on public.evaluation_ratings(user_id);

create table public.evaluation_statuses (
  room_id uuid not null,
  user_id uuid not null,
  round smallint not null default 1 check (round in (1, 2)),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id, round),
  foreign key (room_id, user_id)
    references public.room_members(room_id, user_id)
    on delete cascade
);

alter table public.evaluation_ratings enable row level security;
alter table public.evaluation_statuses enable row level security;

revoke all on table public.evaluation_ratings from public, anon;
revoke all on table public.evaluation_statuses from public, anon;
grant select on table public.evaluation_ratings to authenticated;
grant select on table public.evaluation_statuses to authenticated;

create policy "members can read only their ratings"
on public.evaluation_ratings
for select
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_room_member(room_id))
);

create policy "members can read evaluation statuses"
on public.evaluation_statuses
for select
to authenticated
using ((select private.is_room_member(room_id)));

alter publication supabase_realtime add table public.evaluation_statuses;

create or replace function public.save_room_evaluation(
  p_room_id uuid,
  p_round smallint,
  p_ratings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_stage text;
  candidate_count integer;
  payload_count integer;
  payload_distinct_count integer;
  completed_time timestamptz := now();
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  if p_round <> 1 or jsonb_typeof(p_ratings) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_evaluation';
  end if;

  select r.stage
    into target_stage
  from public.rooms r
  where r.id = p_room_id
  for update;

  if target_stage is null
     or not exists (
       select 1
       from public.room_members m
       where m.room_id = p_room_id
         and m.user_id = current_user_id
         and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'room_access_denied';
  end if;

  if target_stage <> 'rating' then
    raise exception using errcode = 'P0001', message = 'evaluation_closed';
  end if;

  select count(*)
    into candidate_count
  from public.candidates c
  where c.room_id = p_room_id;

  begin
    select count(*), count(distinct (item ->> 'candidate_id')::uuid)
      into payload_count, payload_distinct_count
    from jsonb_array_elements(p_ratings) item
    where item ? 'candidate_id'
      and item ? 'rating'
      and item ->> 'rating' in ('want', 'okay', 'dislike');
  exception
    when invalid_text_representation then
      raise exception using errcode = 'P0001', message = 'invalid_evaluation';
  end;

  if candidate_count < 2
     or payload_count <> candidate_count
     or payload_distinct_count <> candidate_count
     or jsonb_array_length(p_ratings) <> candidate_count
     or exists (
       select 1
       from jsonb_array_elements(p_ratings) item
       left join public.candidates c
         on c.id = (item ->> 'candidate_id')::uuid
        and c.room_id = p_room_id
       where c.id is null
          or not (item ? 'rating')
          or item ->> 'rating' not in ('want', 'okay', 'dislike')
     ) then
    raise exception using errcode = 'P0001', message = 'evaluation_incomplete';
  end if;

  delete from public.evaluation_ratings er
  where er.room_id = p_room_id
    and er.user_id = current_user_id
    and er.round = p_round;

  insert into public.evaluation_ratings (
    room_id, candidate_id, user_id, round, rating
  )
  select
    p_room_id,
    (item ->> 'candidate_id')::uuid,
    current_user_id,
    p_round,
    item ->> 'rating'
  from jsonb_array_elements(p_ratings) item;

  insert into public.evaluation_statuses (
    room_id, user_id, round, status, completed_at, updated_at
  ) values (
    p_room_id, current_user_id, p_round, 'completed', completed_time, completed_time
  )
  on conflict (room_id, user_id, round) do update
  set status = 'completed',
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at;

  return jsonb_build_object(
    'status', 'completed',
    'completed_at', completed_time
  );
exception
  when invalid_text_representation then
    raise exception using errcode = 'P0001', message = 'invalid_evaluation';
end;
$$;

create or replace function public.reopen_room_evaluation(
  p_room_id uuid,
  p_round smallint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_stage text;
  changed_time timestamptz := now();
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  if p_round <> 1 then
    raise exception using errcode = 'P0001', message = 'invalid_evaluation';
  end if;

  select r.stage
    into target_stage
  from public.rooms r
  where r.id = p_room_id
  for update;

  if target_stage is null
     or not exists (
       select 1
       from public.room_members m
       where m.room_id = p_room_id
         and m.user_id = current_user_id
         and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'room_access_denied';
  end if;

  if target_stage <> 'rating' then
    raise exception using errcode = 'P0001', message = 'evaluation_closed';
  end if;

  insert into public.evaluation_statuses (
    room_id, user_id, round, status, completed_at, updated_at
  ) values (
    p_room_id, current_user_id, p_round, 'in_progress', null, changed_time
  )
  on conflict (room_id, user_id, round) do update
  set status = 'in_progress',
      completed_at = null,
      updated_at = excluded.updated_at;

  return jsonb_build_object('status', 'in_progress');
end;
$$;

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
    insert into public.evaluation_statuses (room_id, user_id, round, status)
    select p_room_id, m.user_id, 1, 'in_progress'
    from public.room_members m
    where m.room_id = p_room_id
      and m.status = 'active'
    on conflict (room_id, user_id, round) do nothing;
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

  insert into public.evaluation_statuses (room_id, user_id, round, status)
  select p_room_id, m.user_id, 1, 'in_progress'
  from public.room_members m
  where m.room_id = p_room_id
    and m.status = 'active'
  on conflict (room_id, user_id, round) do update
  set status = 'in_progress',
      completed_at = null,
      updated_at = now();

  return target_room;
end;
$$;

revoke all on function public.save_room_evaluation(uuid, smallint, jsonb) from public, anon;
revoke all on function public.reopen_room_evaluation(uuid, smallint) from public, anon;
revoke all on function public.start_room_evaluation(uuid) from public, anon;
grant execute on function public.save_room_evaluation(uuid, smallint, jsonb) to authenticated;
grant execute on function public.reopen_room_evaluation(uuid, smallint) to authenticated;
grant execute on function public.start_room_evaluation(uuid) to authenticated;
