alter table public.rooms
  add column evaluation_round smallint not null default 1
  check (evaluation_round in (1, 2));

create or replace function public.start_second_evaluation(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  active_member_count integer;
  additional_candidate_count integer;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  select * into target_room
  from public.rooms r
  where r.id = p_room_id
  for update;

  if target_room.id is null
     or target_room.owner_id <> current_user_id
     or not exists (
       select 1 from public.room_members m
       where m.room_id = p_room_id
         and m.user_id = current_user_id
         and m.role = 'host'
         and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;

  if target_room.stage = 'rating' and target_room.evaluation_round = 2 then
    return target_room;
  end if;

  if target_room.stage <> 'adding_candidates'
     or not exists (
       select 1 from public.evaluation_results er
       where er.room_id = p_room_id
         and er.round = 1
         and er.outcome = 'needs_more_candidates'
     ) then
    raise exception using errcode = 'P0001', message = 'room_stage_changed';
  end if;

  select count(*) into active_member_count
  from public.room_members m
  where m.room_id = p_room_id and m.status = 'active';

  select count(*) into additional_candidate_count
  from public.candidates c
  where c.room_id = p_room_id and c.collection_round = 2;

  if active_member_count < 2 then
    raise exception using errcode = 'P0001', message = 'member_count_too_low';
  end if;
  if additional_candidate_count < 1 then
    raise exception using errcode = 'P0001', message = 'candidate_count_too_low';
  end if;

  insert into public.evaluation_ratings (
    room_id, candidate_id, user_id, round, rating, created_at, updated_at
  )
  select er.room_id, er.candidate_id, er.user_id, 2, er.rating, now(), now()
  from public.evaluation_ratings er
  join public.candidates c
    on c.id = er.candidate_id
   and c.room_id = er.room_id
   and c.collection_round = 1
  join public.room_members m
    on m.room_id = er.room_id
   and m.user_id = er.user_id
   and m.status = 'active'
  where er.room_id = p_room_id and er.round = 1
  on conflict (candidate_id, user_id, round) do update
  set rating = excluded.rating, updated_at = excluded.updated_at;

  insert into public.evaluation_statuses (room_id, user_id, round, status, completed_at, updated_at)
  select p_room_id, m.user_id, 2, 'in_progress', null, now()
  from public.room_members m
  where m.room_id = p_room_id and m.status = 'active'
  on conflict (room_id, user_id, round) do update
  set status = 'in_progress', completed_at = null, updated_at = excluded.updated_at;

  update public.rooms
  set stage = 'rating', evaluation_round = 2, updated_at = now()
  where id = p_room_id
  returning * into target_room;

  return target_room;
end;
$$;

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
  target_round smallint;
  candidate_count integer;
  payload_count integer;
  payload_distinct_count integer;
  completed_time timestamptz := now();
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;
  if p_round not in (1, 2) or jsonb_typeof(p_ratings) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_evaluation';
  end if;

  select r.stage, r.evaluation_round into target_stage, target_round
  from public.rooms r where r.id = p_room_id for update;

  if target_stage is null
     or not exists (
       select 1 from public.room_members m
       where m.room_id = p_room_id and m.user_id = current_user_id and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'room_access_denied';
  end if;
  if target_stage <> 'rating' or target_round <> p_round then
    raise exception using errcode = 'P0001', message = 'evaluation_closed';
  end if;
  if exists (
    select 1 from public.evaluation_results er
    where er.room_id = p_room_id and er.round = p_round
  ) then
    raise exception using errcode = 'P0001', message = 'evaluation_locked';
  end if;

  select count(*) into candidate_count
  from public.candidates c where c.room_id = p_room_id;

  begin
    select count(*), count(distinct (item ->> 'candidate_id')::uuid)
      into payload_count, payload_distinct_count
    from jsonb_array_elements(p_ratings) item
    where item ? 'candidate_id'
      and item ? 'rating'
      and item ->> 'rating' in ('want', 'okay', 'dislike');
  exception when invalid_text_representation then
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
         on c.id = (item ->> 'candidate_id')::uuid and c.room_id = p_room_id
       where c.id is null
          or not (item ? 'rating')
          or item ->> 'rating' not in ('want', 'okay', 'dislike')
     ) then
    raise exception using errcode = 'P0001', message = 'evaluation_incomplete';
  end if;

  delete from public.evaluation_ratings er
  where er.room_id = p_room_id and er.user_id = current_user_id and er.round = p_round;

  insert into public.evaluation_ratings (room_id, candidate_id, user_id, round, rating)
  select p_room_id, (item ->> 'candidate_id')::uuid, current_user_id, p_round, item ->> 'rating'
  from jsonb_array_elements(p_ratings) item;

  insert into public.evaluation_statuses (room_id, user_id, round, status, completed_at, updated_at)
  values (p_room_id, current_user_id, p_round, 'completed', completed_time, completed_time)
  on conflict (room_id, user_id, round) do update
  set status = 'completed', completed_at = excluded.completed_at, updated_at = excluded.updated_at;

  return jsonb_build_object('status', 'completed', 'completed_at', completed_time);
exception when invalid_text_representation then
  raise exception using errcode = 'P0001', message = 'invalid_evaluation';
end;
$$;

create or replace function public.reopen_room_evaluation(p_room_id uuid, p_round smallint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_stage text;
  target_round smallint;
  changed_time timestamptz := now();
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;
  if p_round not in (1, 2) then
    raise exception using errcode = 'P0001', message = 'invalid_evaluation';
  end if;

  select r.stage, r.evaluation_round into target_stage, target_round
  from public.rooms r where r.id = p_room_id for update;

  if target_stage is null
     or not exists (
       select 1 from public.room_members m
       where m.room_id = p_room_id and m.user_id = current_user_id and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'room_access_denied';
  end if;
  if target_stage <> 'rating' or target_round <> p_round
     or exists (
       select 1 from public.evaluation_results er
       where er.room_id = p_room_id and er.round = p_round
     ) then
    raise exception using errcode = 'P0001', message = 'evaluation_closed';
  end if;

  insert into public.evaluation_statuses (room_id, user_id, round, status, completed_at, updated_at)
  values (p_room_id, current_user_id, p_round, 'in_progress', null, changed_time)
  on conflict (room_id, user_id, round) do update
  set status = 'in_progress', completed_at = null, updated_at = excluded.updated_at;

  return jsonb_build_object('status', 'in_progress');
end;
$$;

create or replace function public.decide_second_evaluation(p_room_id uuid)
returns public.evaluation_results
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  active_member_count integer;
  completed_member_count integer;
  candidate_count integer;
  saved_rating_count integer;
  eligible_count integer;
  best_dislike_count integer;
  highest_want_count integer;
  advancing_count integer;
  result_outcome text;
  advancing_ids uuid[];
  candidate_results jsonb;
  saved_result public.evaluation_results;
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
       where m.room_id = p_room_id and m.user_id = current_user_id
         and m.role = 'host' and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;

  select * into saved_result
  from public.evaluation_results er
  where er.room_id = p_room_id and er.round = 2;
  if saved_result.room_id is not null then return saved_result; end if;

  if target_room.stage <> 'rating' or target_room.evaluation_round <> 2 then
    raise exception using errcode = 'P0001', message = 'evaluation_closed';
  end if;

  select count(*) into active_member_count
  from public.room_members m where m.room_id = p_room_id and m.status = 'active';
  select count(*) into completed_member_count
  from public.evaluation_statuses es
  join public.room_members m
    on m.room_id = es.room_id and m.user_id = es.user_id and m.status = 'active'
  where es.room_id = p_room_id and es.round = 2 and es.status = 'completed';
  select count(*) into candidate_count
  from public.candidates c where c.room_id = p_room_id;
  select count(*) into saved_rating_count
  from public.evaluation_ratings er
  join public.room_members m
    on m.room_id = er.room_id and m.user_id = er.user_id and m.status = 'active'
  join public.candidates c on c.id = er.candidate_id and c.room_id = er.room_id
  where er.room_id = p_room_id and er.round = 2;

  if active_member_count < 2 or candidate_count < 2
     or completed_member_count <> active_member_count
     or saved_rating_count <> active_member_count * candidate_count then
    raise exception using errcode = 'P0001', message = 'evaluation_incomplete';
  end if;

  with totals as (
    select c.id as candidate_id,
      count(*) filter (where er.rating = 'want')::integer as want_count,
      count(*) filter (where er.rating = 'dislike')::integer as dislike_count
    from public.candidates c
    join public.evaluation_ratings er
      on er.candidate_id = c.id and er.room_id = c.room_id and er.round = 2
    join public.room_members m
      on m.room_id = er.room_id and m.user_id = er.user_id and m.status = 'active'
    where c.room_id = p_room_id group by c.id
  )
  select count(*) filter (where dislike_count = 0), min(dislike_count)
  into eligible_count, best_dislike_count from totals;

  with totals as (
    select c.id as candidate_id,
      count(*) filter (where er.rating = 'want')::integer as want_count,
      count(*) filter (where er.rating = 'dislike')::integer as dislike_count
    from public.candidates c
    join public.evaluation_ratings er
      on er.candidate_id = c.id and er.room_id = c.room_id and er.round = 2
    join public.room_members m
      on m.room_id = er.room_id and m.user_id = er.user_id and m.status = 'active'
    where c.room_id = p_room_id group by c.id
  )
  select max(want_count) into highest_want_count
  from totals
  where dislike_count = case when eligible_count > 0 then 0 else best_dislike_count end;

  with totals as (
    select c.id as candidate_id, c.created_at,
      count(*) filter (where er.rating = 'want')::integer as want_count,
      count(*) filter (where er.rating = 'dislike')::integer as dislike_count
    from public.candidates c
    join public.evaluation_ratings er
      on er.candidate_id = c.id and er.room_id = c.room_id and er.round = 2
    join public.room_members m
      on m.room_id = er.room_id and m.user_id = er.user_id and m.status = 'active'
    where c.room_id = p_room_id group by c.id, c.created_at
  )
  select array_agg(candidate_id order by created_at), count(*)
  into advancing_ids, advancing_count
  from totals
  where dislike_count = case when eligible_count > 0 then 0 else best_dislike_count end
    and want_count = highest_want_count;

  result_outcome := case when advancing_count = 1 then 'winner' else 'revote' end;

  with totals as (
    select c.id as candidate_id, c.created_at,
      count(*) filter (where er.rating = 'want')::integer as want_count,
      count(*) filter (where er.rating = 'okay')::integer as okay_count,
      count(*) filter (where er.rating = 'dislike')::integer as dislike_count,
      coalesce(jsonb_agg(m.nickname order by m.joined_at) filter (where er.rating = 'want'), '[]'::jsonb) as want_nicknames,
      coalesce(jsonb_agg(m.nickname order by m.joined_at) filter (where er.rating = 'okay'), '[]'::jsonb) as okay_nicknames,
      coalesce(jsonb_agg(m.nickname order by m.joined_at) filter (where er.rating = 'dislike'), '[]'::jsonb) as dislike_nicknames
    from public.candidates c
    join public.evaluation_ratings er
      on er.candidate_id = c.id and er.room_id = c.room_id and er.round = 2
    join public.room_members m
      on m.room_id = er.room_id and m.user_id = er.user_id and m.status = 'active'
    where c.room_id = p_room_id group by c.id, c.created_at
  )
  select jsonb_agg(jsonb_build_object(
    'candidate_id', candidate_id,
    'want_count', want_count,
    'okay_count', okay_count,
    'dislike_count', dislike_count,
    'want_nicknames', want_nicknames,
    'okay_nicknames', okay_nicknames,
    'dislike_nicknames', dislike_nicknames
  ) order by created_at)
  into candidate_results from totals;

  insert into public.evaluation_results (
    room_id, round, outcome, advancing_candidate_ids, result_data, decided_by
  ) values (
    p_room_id, 2, result_outcome, coalesce(advancing_ids, '{}'),
    jsonb_build_object('candidates', candidate_results), current_user_id
  ) returning * into saved_result;

  update public.rooms set updated_at = now() where id = p_room_id;
  return saved_result;
end;
$$;

create or replace function public.advance_second_evaluation(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  second_result public.evaluation_results;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;
  select * into target_room from public.rooms r where r.id = p_room_id for update;
  if target_room.id is null or target_room.owner_id <> current_user_id
     or not exists (
       select 1 from public.room_members m
       where m.room_id = p_room_id and m.user_id = current_user_id
         and m.role = 'host' and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;
  select * into second_result from public.evaluation_results er
  where er.room_id = p_room_id and er.round = 2;
  if second_result.room_id is null then
    raise exception using errcode = 'P0001', message = 'result_not_ready';
  end if;
  if second_result.outcome <> 'winner' or cardinality(second_result.advancing_candidate_ids) <> 1 then
    raise exception using errcode = 'P0001', message = 'revote_setup_required';
  end if;
  if target_room.stage = 'completed'
     and target_room.final_candidate_id = second_result.advancing_candidate_ids[1] then
    return target_room;
  end if;
  if target_room.stage <> 'rating' or target_room.evaluation_round <> 2 then
    raise exception using errcode = 'P0001', message = 'room_stage_changed';
  end if;
  update public.rooms
  set stage = 'completed', final_candidate_id = second_result.advancing_candidate_ids[1], updated_at = now()
  where id = p_room_id returning * into target_room;
  return target_room;
end;
$$;

create or replace function public.start_evaluation_revote(
  p_room_id uuid,
  p_selection_count smallint
)
returns public.revote_rounds
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  source_candidate_ids uuid[];
  saved_round public.revote_rounds;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;
  select * into target_room from public.rooms r where r.id = p_room_id for update;
  if target_room.id is null or target_room.owner_id <> current_user_id
     or not exists (
       select 1 from public.room_members m
       where m.room_id = p_room_id and m.user_id = current_user_id
         and m.role = 'host' and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;
  select * into saved_round from public.revote_rounds rr
  where rr.room_id = p_room_id and rr.round = 1;
  if saved_round.room_id is not null then
    if saved_round.selection_count <> p_selection_count then
      raise exception using errcode = 'P0001', message = 'revote_already_started';
    end if;
    return saved_round;
  end if;
  if target_room.stage <> 'rating' then
    raise exception using errcode = 'P0001', message = 'room_stage_changed';
  end if;
  select er.advancing_candidate_ids into source_candidate_ids
  from public.evaluation_results er
  where er.room_id = p_room_id
    and er.round = target_room.evaluation_round
    and er.outcome = 'revote';
  if source_candidate_ids is null
     or cardinality(source_candidate_ids) < 2
     or p_selection_count < 1
     or p_selection_count >= cardinality(source_candidate_ids)
     or exists (
       select 1 from unnest(source_candidate_ids) candidate_id
       left join public.candidates c on c.id = candidate_id and c.room_id = p_room_id
       where c.id is null
     ) then
    raise exception using errcode = 'P0001', message = 'invalid_revote';
  end if;
  insert into public.revote_rounds (
    room_id, round, selection_count, candidate_ids, started_by
  ) values (
    p_room_id, 1, p_selection_count, source_candidate_ids, current_user_id
  ) returning * into saved_round;
  insert into public.revote_statuses (room_id, round, user_id, status)
  select p_room_id, 1, m.user_id, 'in_progress'
  from public.room_members m
  where m.room_id = p_room_id and m.status = 'active';
  update public.rooms set stage = 'revote_1', updated_at = now() where id = p_room_id;
  return saved_round;
end;
$$;

revoke all on function public.start_second_evaluation(uuid) from public, anon;
revoke all on function public.decide_second_evaluation(uuid) from public, anon;
revoke all on function public.advance_second_evaluation(uuid) from public, anon;
revoke all on function public.start_evaluation_revote(uuid, smallint) from public, anon;
revoke all on function public.save_room_evaluation(uuid, smallint, jsonb) from public, anon;
revoke all on function public.reopen_room_evaluation(uuid, smallint) from public, anon;
grant execute on function public.start_second_evaluation(uuid) to authenticated;
grant execute on function public.decide_second_evaluation(uuid) to authenticated;
grant execute on function public.advance_second_evaluation(uuid) to authenticated;
grant execute on function public.start_evaluation_revote(uuid, smallint) to authenticated;
grant execute on function public.save_room_evaluation(uuid, smallint, jsonb) to authenticated;
grant execute on function public.reopen_room_evaluation(uuid, smallint) to authenticated;
