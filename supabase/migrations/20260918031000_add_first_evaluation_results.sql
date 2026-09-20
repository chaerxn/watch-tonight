create table public.evaluation_results (
  room_id uuid not null references public.rooms(id) on delete cascade,
  round smallint not null check (round in (1, 2)),
  outcome text not null check (outcome in ('winner', 'revote', 'needs_more_candidates')),
  advancing_candidate_ids uuid[] not null default '{}',
  result_data jsonb not null,
  decided_by uuid not null references auth.users(id) on delete restrict,
  decided_at timestamptz not null default now(),
  primary key (room_id, round),
  foreign key (room_id, decided_by)
    references public.room_members(room_id, user_id)
    on delete restrict
);

create index evaluation_results_decided_by_idx
  on public.evaluation_results(decided_by);

alter table public.evaluation_results enable row level security;

revoke all on table public.evaluation_results from public, anon;
grant select on table public.evaluation_results to authenticated;

create policy "members can read decided evaluation results"
on public.evaluation_results
for select
to authenticated
using ((select private.is_room_member(room_id)));

alter publication supabase_realtime add table public.evaluation_results;

create or replace function public.decide_first_evaluation(p_room_id uuid)
returns public.evaluation_results
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_stage text;
  active_member_count integer;
  completed_member_count integer;
  candidate_count integer;
  saved_rating_count integer;
  eligible_count integer;
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
         and m.role = 'host'
         and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;

  select *
    into saved_result
  from public.evaluation_results er
  where er.room_id = p_room_id
    and er.round = 1;

  if saved_result.room_id is not null then
    return saved_result;
  end if;

  if target_stage <> 'rating' then
    raise exception using errcode = 'P0001', message = 'evaluation_closed';
  end if;

  select count(*)
    into active_member_count
  from public.room_members m
  where m.room_id = p_room_id
    and m.status = 'active';

  select count(*)
    into completed_member_count
  from public.evaluation_statuses es
  join public.room_members m
    on m.room_id = es.room_id
   and m.user_id = es.user_id
   and m.status = 'active'
  where es.room_id = p_room_id
    and es.round = 1
    and es.status = 'completed';

  select count(*)
    into candidate_count
  from public.candidates c
  where c.room_id = p_room_id;

  select count(*)
    into saved_rating_count
  from public.evaluation_ratings er
  join public.room_members m
    on m.room_id = er.room_id
   and m.user_id = er.user_id
   and m.status = 'active'
  join public.candidates c
    on c.id = er.candidate_id
   and c.room_id = er.room_id
  where er.room_id = p_room_id
    and er.round = 1;

  if active_member_count < 2
     or candidate_count < 2
     or completed_member_count <> active_member_count
     or saved_rating_count <> active_member_count * candidate_count then
    raise exception using errcode = 'P0001', message = 'evaluation_incomplete';
  end if;

  with totals as (
    select
      c.id as candidate_id,
      c.created_at,
      count(*) filter (where er.rating = 'want')::integer as want_count,
      count(*) filter (where er.rating = 'okay')::integer as okay_count,
      count(*) filter (where er.rating = 'dislike')::integer as dislike_count,
      coalesce(jsonb_agg(m.nickname order by m.joined_at) filter (where er.rating = 'want'), '[]'::jsonb) as want_nicknames,
      coalesce(jsonb_agg(m.nickname order by m.joined_at) filter (where er.rating = 'okay'), '[]'::jsonb) as okay_nicknames,
      coalesce(jsonb_agg(m.nickname order by m.joined_at) filter (where er.rating = 'dislike'), '[]'::jsonb) as dislike_nicknames
    from public.candidates c
    join public.evaluation_ratings er
      on er.candidate_id = c.id
     and er.room_id = c.room_id
     and er.round = 1
    join public.room_members m
      on m.room_id = er.room_id
     and m.user_id = er.user_id
     and m.status = 'active'
    where c.room_id = p_room_id
    group by c.id, c.created_at
  )
  select
    count(*) filter (where dislike_count = 0),
    max(want_count) filter (where dislike_count = 0)
  into eligible_count, highest_want_count
  from totals;

  if eligible_count = 0 then
    result_outcome := 'needs_more_candidates';
    advancing_ids := '{}';
  else
    with totals as (
      select
        c.id as candidate_id,
        c.created_at,
        count(*) filter (where er.rating = 'want')::integer as want_count,
        count(*) filter (where er.rating = 'dislike')::integer as dislike_count
      from public.candidates c
      join public.evaluation_ratings er
        on er.candidate_id = c.id
       and er.room_id = c.room_id
       and er.round = 1
      join public.room_members m
        on m.room_id = er.room_id
       and m.user_id = er.user_id
       and m.status = 'active'
      where c.room_id = p_room_id
      group by c.id, c.created_at
    )
    select array_agg(candidate_id order by created_at), count(*)
      into advancing_ids, advancing_count
    from totals
    where dislike_count = 0
      and want_count = highest_want_count;

    result_outcome := case when advancing_count = 1 then 'winner' else 'revote' end;
  end if;

  with totals as (
    select
      c.id as candidate_id,
      c.created_at,
      count(*) filter (where er.rating = 'want')::integer as want_count,
      count(*) filter (where er.rating = 'okay')::integer as okay_count,
      count(*) filter (where er.rating = 'dislike')::integer as dislike_count,
      coalesce(jsonb_agg(m.nickname order by m.joined_at) filter (where er.rating = 'want'), '[]'::jsonb) as want_nicknames,
      coalesce(jsonb_agg(m.nickname order by m.joined_at) filter (where er.rating = 'okay'), '[]'::jsonb) as okay_nicknames,
      coalesce(jsonb_agg(m.nickname order by m.joined_at) filter (where er.rating = 'dislike'), '[]'::jsonb) as dislike_nicknames
    from public.candidates c
    join public.evaluation_ratings er
      on er.candidate_id = c.id
     and er.room_id = c.room_id
     and er.round = 1
    join public.room_members m
      on m.room_id = er.room_id
     and m.user_id = er.user_id
     and m.status = 'active'
    where c.room_id = p_room_id
    group by c.id, c.created_at
  )
  select jsonb_agg(
    jsonb_build_object(
      'candidate_id', candidate_id,
      'want_count', want_count,
      'okay_count', okay_count,
      'dislike_count', dislike_count,
      'want_nicknames', want_nicknames,
      'okay_nicknames', okay_nicknames,
      'dislike_nicknames', dislike_nicknames
    ) order by created_at
  )
  into candidate_results
  from totals;

  insert into public.evaluation_results (
    room_id, round, outcome, advancing_candidate_ids, result_data, decided_by
  ) values (
    p_room_id,
    1,
    result_outcome,
    coalesce(advancing_ids, '{}'),
    jsonb_build_object('candidates', candidate_results),
    current_user_id
  )
  returning * into saved_result;

  update public.rooms
  set updated_at = now()
  where id = p_room_id;

  return saved_result;
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

  if exists (
    select 1
    from public.evaluation_results er
    where er.room_id = p_room_id
      and er.round = p_round
  ) then
    raise exception using errcode = 'P0001', message = 'evaluation_locked';
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

  if exists (
    select 1
    from public.evaluation_results er
    where er.room_id = p_room_id
      and er.round = p_round
  ) then
    raise exception using errcode = 'P0001', message = 'evaluation_locked';
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

revoke all on function public.decide_first_evaluation(uuid) from public, anon;
revoke all on function public.reopen_room_evaluation(uuid, smallint) from public, anon;
revoke all on function public.save_room_evaluation(uuid, smallint, jsonb) from public, anon;
grant execute on function public.decide_first_evaluation(uuid) to authenticated;
grant execute on function public.reopen_room_evaluation(uuid, smallint) to authenticated;
grant execute on function public.save_room_evaluation(uuid, smallint, jsonb) to authenticated;
