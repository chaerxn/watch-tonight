create table public.ladder_sessions (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  candidate_ids uuid[] not null,
  source_candidate_count smallint not null check (source_candidate_count >= 2),
  first_run jsonb,
  second_run jsonb,
  final_run smallint check (final_run in (1, 2)),
  winner_candidate_id uuid references public.candidates(id) on delete restrict,
  prepared_by uuid not null references auth.users(id) on delete restrict,
  prepared_at timestamptz not null default now(),
  finalized_at timestamptz,
  foreign key (room_id, prepared_by)
    references public.room_members(room_id, user_id)
    on delete restrict,
  check (cardinality(candidate_ids) between 2 and 6),
  check ((final_run is null and winner_candidate_id is null) or (final_run is not null and winner_candidate_id is not null))
);

create index ladder_sessions_prepared_by_idx on public.ladder_sessions(prepared_by);
create index ladder_sessions_room_prepared_by_idx on public.ladder_sessions(room_id, prepared_by);
create index ladder_sessions_winner_idx on public.ladder_sessions(winner_candidate_id) where winner_candidate_id is not null;

alter table public.ladder_sessions enable row level security;
revoke all on table public.ladder_sessions from public, anon;
grant select on table public.ladder_sessions to authenticated;

create policy "members can read ladder sessions"
on public.ladder_sessions for select to authenticated
using ((select private.is_room_member(room_id)));

alter publication supabase_realtime add table public.ladder_sessions;

create or replace function public.prepare_room_ladder(p_room_id uuid)
returns public.ladder_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  source_ids uuid[];
  selected_ids uuid[];
  saved_session public.ladder_sessions;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  select * into target_room
  from public.rooms r where r.id = p_room_id for update;

  if target_room.id is null
     or target_room.owner_id <> current_user_id
     or not exists (
       select 1 from public.room_members m
       where m.room_id = p_room_id and m.user_id = current_user_id and m.role = 'host' and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;

  select * into saved_session from public.ladder_sessions ls where ls.room_id = p_room_id;
  if saved_session.room_id is not null then return saved_session; end if;
  if target_room.stage <> 'ladder' then
    raise exception using errcode = 'P0001', message = 'room_stage_changed';
  end if;

  select rr.advancing_candidate_ids into source_ids
  from public.revote_rounds rr
  where rr.room_id = p_room_id
    and (rr.outcome = 'all_abstained' or (rr.round = 2 and rr.outcome = 'tie'))
  order by rr.round desc limit 1;

  if source_ids is null or cardinality(source_ids) < 2 then
    raise exception using errcode = 'P0001', message = 'ladder_candidates_missing';
  end if;

  select array_agg(candidate_id order by random()) into selected_ids
  from (select candidate_id from unnest(source_ids) candidate_id order by random() limit 6) picked;

  if exists (
    select 1 from unnest(selected_ids) candidate_id
    left join public.candidates c on c.id = candidate_id and c.room_id = p_room_id
    where c.id is null
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_ladder_candidates';
  end if;

  insert into public.ladder_sessions (room_id, candidate_ids, source_candidate_count, prepared_by)
  values (p_room_id, selected_ids, cardinality(source_ids), current_user_id)
  returning * into saved_session;
  return saved_session;
end;
$$;

create or replace function public.start_ladder_run(p_room_id uuid, p_run smallint)
returns public.ladder_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  target_session public.ladder_sessions;
  lane_count integer;
  candidate_order uuid[];
  winning_lane integer;
  current_lane integer;
  rung_lane integer;
  level_index integer;
  scan_lane integer;
  rungs jsonb := '[]'::jsonb;
  rung_item jsonb;
  run_data jsonb;
  winner_id uuid;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;
  if p_run not in (1, 2) then
    raise exception using errcode = 'P0001', message = 'invalid_ladder_run';
  end if;

  select * into target_room from public.rooms r where r.id = p_room_id for update;
  if target_room.id is null
     or target_room.owner_id <> current_user_id
     or target_room.stage <> 'ladder'
     or not exists (
       select 1 from public.room_members m
       where m.room_id = p_room_id and m.user_id = current_user_id and m.role = 'host' and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;

  select * into target_session from public.ladder_sessions ls where ls.room_id = p_room_id for update;
  if target_session.room_id is null then
    raise exception using errcode = 'P0001', message = 'ladder_not_prepared';
  end if;
  if target_session.final_run is not null then return target_session; end if;
  if p_run = 1 and target_session.first_run is not null then return target_session; end if;
  if p_run = 2 then
    if target_session.first_run is null then
      raise exception using errcode = 'P0001', message = 'first_ladder_required';
    end if;
    if target_session.second_run is not null then return target_session; end if;
  end if;

  lane_count := cardinality(target_session.candidate_ids);
  select array_agg(candidate_id order by random()) into candidate_order
  from unnest(target_session.candidate_ids) candidate_id;
  winning_lane := floor(random() * lane_count)::integer;

  for level_index in 0..7 loop
    scan_lane := 0;
    while scan_lane < lane_count - 1 loop
      if random() < 0.48 then
        rungs := rungs || jsonb_build_array(jsonb_build_object('level', level_index, 'left_lane', scan_lane));
        scan_lane := scan_lane + 2;
      else
        scan_lane := scan_lane + 1;
      end if;
    end loop;
  end loop;

  current_lane := winning_lane;
  for rung_item in select value from jsonb_array_elements(rungs) loop
    rung_lane := (rung_item ->> 'left_lane')::integer;
    if rung_lane = current_lane then current_lane := current_lane + 1;
    elsif rung_lane + 1 = current_lane then current_lane := current_lane - 1;
    end if;
  end loop;
  winner_id := candidate_order[current_lane + 1];

  run_data := jsonb_build_object(
    'run', p_run,
    'winning_lane', winning_lane,
    'candidate_order', to_jsonb(candidate_order),
    'rungs', rungs,
    'winner_candidate_id', winner_id,
    'created_at', now()
  );

  update public.ladder_sessions
  set first_run = case when p_run = 1 then run_data else first_run end,
      second_run = case when p_run = 2 then run_data else second_run end
  where room_id = p_room_id
  returning * into target_session;
  return target_session;
end;
$$;

create or replace function public.finalize_ladder(p_room_id uuid, p_run smallint)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  target_session public.ladder_sessions;
  winner_id uuid;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;
  if p_run not in (1, 2) then
    raise exception using errcode = 'P0001', message = 'invalid_ladder_run';
  end if;

  select * into target_room from public.rooms r where r.id = p_room_id for update;
  if target_room.id is null
     or target_room.owner_id <> current_user_id
     or not exists (
       select 1 from public.room_members m
       where m.room_id = p_room_id and m.user_id = current_user_id and m.role = 'host' and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;

  select * into target_session from public.ladder_sessions ls where ls.room_id = p_room_id for update;
  if target_session.final_run is not null then return target_room; end if;
  if target_room.stage <> 'ladder'
     or (p_run = 1 and target_session.first_run is null)
     or (p_run = 2 and target_session.second_run is null)
     or (p_run = 1 and target_session.second_run is not null) then
    raise exception using errcode = 'P0001', message = 'ladder_not_ready';
  end if;

  winner_id := ((case when p_run = 1 then target_session.first_run else target_session.second_run end) ->> 'winner_candidate_id')::uuid;
  if not (winner_id = any(target_session.candidate_ids)) then
    raise exception using errcode = 'P0001', message = 'invalid_ladder_result';
  end if;

  update public.ladder_sessions
  set final_run = p_run, winner_candidate_id = winner_id, finalized_at = now()
  where room_id = p_room_id;

  update public.rooms
  set stage = 'completed', final_candidate_id = winner_id, updated_at = now()
  where id = p_room_id
  returning * into target_room;
  return target_room;
end;
$$;

revoke all on function public.prepare_room_ladder(uuid) from public, anon;
revoke all on function public.start_ladder_run(uuid, smallint) from public, anon;
revoke all on function public.finalize_ladder(uuid, smallint) from public, anon;
grant execute on function public.prepare_room_ladder(uuid) to authenticated;
grant execute on function public.start_ladder_run(uuid, smallint) to authenticated;
grant execute on function public.finalize_ladder(uuid, smallint) to authenticated;
