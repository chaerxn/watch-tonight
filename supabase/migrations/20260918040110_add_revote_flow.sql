create table public.revote_rounds (
  room_id uuid not null references public.rooms(id) on delete cascade,
  round smallint not null check (round in (1, 2)),
  selection_count smallint not null check (selection_count >= 1),
  candidate_ids uuid[] not null,
  outcome text check (outcome in ('winner', 'tie', 'all_abstained')),
  advancing_candidate_ids uuid[] not null default '{}',
  result_data jsonb,
  started_by uuid not null references auth.users(id) on delete restrict,
  decided_by uuid references auth.users(id) on delete restrict,
  started_at timestamptz not null default now(),
  decided_at timestamptz,
  primary key (room_id, round),
  foreign key (room_id, started_by)
    references public.room_members(room_id, user_id)
    on delete restrict,
  foreign key (room_id, decided_by)
    references public.room_members(room_id, user_id)
    on delete restrict,
  check (cardinality(candidate_ids) >= 2),
  check (selection_count < cardinality(candidate_ids))
);

create index revote_rounds_started_by_idx on public.revote_rounds(started_by);
create index revote_rounds_decided_by_idx on public.revote_rounds(decided_by) where decided_by is not null;

create table public.revote_ballots (
  room_id uuid not null,
  round smallint not null check (round in (1, 2)),
  user_id uuid not null references auth.users(id) on delete cascade,
  selected_candidate_ids uuid[] not null default '{}',
  abstained boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (room_id, round, user_id),
  foreign key (room_id, round)
    references public.revote_rounds(room_id, round)
    on delete cascade,
  foreign key (room_id, user_id)
    references public.room_members(room_id, user_id)
    on delete cascade,
  check ((abstained and cardinality(selected_candidate_ids) = 0) or not abstained)
);

create table public.revote_statuses (
  room_id uuid not null,
  round smallint not null check (round in (1, 2)),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (room_id, round, user_id),
  foreign key (room_id, round)
    references public.revote_rounds(room_id, round)
    on delete cascade,
  foreign key (room_id, user_id)
    references public.room_members(room_id, user_id)
    on delete cascade
);

create index revote_ballots_user_id_idx on public.revote_ballots(user_id);
create index revote_statuses_user_id_idx on public.revote_statuses(user_id);

alter table public.revote_rounds enable row level security;
alter table public.revote_ballots enable row level security;
alter table public.revote_statuses enable row level security;

revoke all on table public.revote_rounds from public, anon;
revoke all on table public.revote_ballots from public, anon;
revoke all on table public.revote_statuses from public, anon;
grant select on table public.revote_rounds to authenticated;
grant select on table public.revote_ballots to authenticated;
grant select on table public.revote_statuses to authenticated;

create policy "members can read revote rounds"
on public.revote_rounds for select to authenticated
using ((select private.is_room_member(room_id)));

create policy "members can read only their revote ballot"
on public.revote_ballots for select to authenticated
using (user_id = (select auth.uid()) and (select private.is_room_member(room_id)));

create policy "members can read revote statuses"
on public.revote_statuses for select to authenticated
using ((select private.is_room_member(room_id)));

alter publication supabase_realtime add table public.revote_rounds;
alter publication supabase_realtime add table public.revote_statuses;

create or replace function public.start_room_revote(
  p_room_id uuid,
  p_round smallint,
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

  if p_round not in (1, 2) then
    raise exception using errcode = 'P0001', message = 'invalid_revote';
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

  select * into saved_round
  from public.revote_rounds rr
  where rr.room_id = p_room_id and rr.round = p_round;

  if saved_round.room_id is not null then
    if saved_round.selection_count <> p_selection_count then
      raise exception using errcode = 'P0001', message = 'revote_already_started';
    end if;
    return saved_round;
  end if;

  if p_round = 1 then
    if target_room.stage <> 'rating' then
      raise exception using errcode = 'P0001', message = 'room_stage_changed';
    end if;
    select er.advancing_candidate_ids into source_candidate_ids
    from public.evaluation_results er
    where er.room_id = p_room_id and er.round = 1 and er.outcome = 'revote';
  else
    if target_room.stage <> 'revote_1' then
      raise exception using errcode = 'P0001', message = 'room_stage_changed';
    end if;
    select rr.advancing_candidate_ids into source_candidate_ids
    from public.revote_rounds rr
    where rr.room_id = p_room_id and rr.round = 1 and rr.outcome = 'tie';
  end if;

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
    p_room_id, p_round, p_selection_count, source_candidate_ids, current_user_id
  ) returning * into saved_round;

  insert into public.revote_statuses (room_id, round, user_id, status)
  select p_room_id, p_round, m.user_id, 'in_progress'
  from public.room_members m
  where m.room_id = p_room_id and m.status = 'active';

  update public.rooms
  set stage = case when p_round = 1 then 'revote_1' else 'revote_2' end,
      updated_at = now()
  where id = p_room_id;

  return saved_round;
end;
$$;

create or replace function public.save_room_revote(
  p_room_id uuid,
  p_round smallint,
  p_selected_candidate_ids uuid[],
  p_abstained boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_stage text;
  target_round public.revote_rounds;
  selected_ids uuid[] := coalesce(p_selected_candidate_ids, '{}');
  distinct_count integer;
  completed_time timestamptz := now();
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  select r.stage into target_stage
  from public.rooms r
  where r.id = p_room_id
  for update;

  if target_stage is null
     or not exists (
       select 1 from public.room_members m
       where m.room_id = p_room_id and m.user_id = current_user_id and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'room_access_denied';
  end if;

  select * into target_round
  from public.revote_rounds rr
  where rr.room_id = p_room_id and rr.round = p_round;

  if target_round.room_id is null
     or target_round.outcome is not null
     or target_stage <> (case when p_round = 1 then 'revote_1' else 'revote_2' end) then
    raise exception using errcode = 'P0001', message = 'revote_closed';
  end if;

  select count(distinct candidate_id) into distinct_count from unnest(selected_ids) candidate_id;

  if (p_abstained and cardinality(selected_ids) <> 0)
     or (not p_abstained and cardinality(selected_ids) <> target_round.selection_count)
     or distinct_count <> cardinality(selected_ids)
     or exists (
       select 1 from unnest(selected_ids) candidate_id
       where not (candidate_id = any(target_round.candidate_ids))
     ) then
    raise exception using errcode = 'P0001', message = 'revote_incomplete';
  end if;

  insert into public.revote_ballots (
    room_id, round, user_id, selected_candidate_ids, abstained, updated_at
  ) values (
    p_room_id, p_round, current_user_id, selected_ids, p_abstained, completed_time
  ) on conflict (room_id, round, user_id) do update
  set selected_candidate_ids = excluded.selected_candidate_ids,
      abstained = excluded.abstained,
      updated_at = excluded.updated_at;

  insert into public.revote_statuses (
    room_id, round, user_id, status, completed_at, updated_at
  ) values (
    p_room_id, p_round, current_user_id, 'completed', completed_time, completed_time
  ) on conflict (room_id, round, user_id) do update
  set status = 'completed', completed_at = excluded.completed_at, updated_at = excluded.updated_at;

  return jsonb_build_object('status', 'completed', 'completed_at', completed_time);
end;
$$;

create or replace function public.reopen_room_revote(p_room_id uuid, p_round smallint)
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

  select r.stage into target_stage
  from public.rooms r
  where r.id = p_room_id
  for update;

  if target_stage is null
     or target_stage <> (case when p_round = 1 then 'revote_1' else 'revote_2' end)
     or not exists (
       select 1 from public.room_members m
       where m.room_id = p_room_id and m.user_id = current_user_id and m.status = 'active'
     )
     or exists (
       select 1 from public.revote_rounds rr
       where rr.room_id = p_room_id and rr.round = p_round and rr.outcome is not null
     ) then
    raise exception using errcode = 'P0001', message = 'revote_closed';
  end if;

  update public.revote_statuses
  set status = 'in_progress', completed_at = null, updated_at = changed_time
  where room_id = p_room_id and round = p_round and user_id = current_user_id;

  return jsonb_build_object('status', 'in_progress');
end;
$$;

create or replace function public.decide_room_revote(p_room_id uuid, p_round smallint)
returns public.revote_rounds
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  target_round public.revote_rounds;
  active_member_count integer;
  completed_member_count integer;
  total_vote_count integer;
  highest_vote_count integer;
  advancing_ids uuid[];
  advancing_count integer;
  result_outcome text;
  candidate_results jsonb;
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
       where m.room_id = p_room_id and m.user_id = current_user_id and m.role = 'host' and m.status = 'active'
     ) then
    raise exception using errcode = 'P0001', message = 'host_required';
  end if;

  select * into target_round
  from public.revote_rounds rr
  where rr.room_id = p_room_id and rr.round = p_round;

  if target_round.room_id is null then
    raise exception using errcode = 'P0001', message = 'revote_not_ready';
  end if;
  if target_round.outcome is not null then
    return target_round;
  end if;
  if target_room.stage <> (case when p_round = 1 then 'revote_1' else 'revote_2' end) then
    raise exception using errcode = 'P0001', message = 'room_stage_changed';
  end if;

  select count(*) into active_member_count
  from public.room_members m where m.room_id = p_room_id and m.status = 'active';
  select count(*) into completed_member_count
  from public.revote_statuses rs
  join public.room_members m on m.room_id = rs.room_id and m.user_id = rs.user_id and m.status = 'active'
  where rs.room_id = p_room_id and rs.round = p_round and rs.status = 'completed';

  if active_member_count < 2 or completed_member_count <> active_member_count then
    raise exception using errcode = 'P0001', message = 'revote_incomplete';
  end if;

  with votes as (
    select selected_id as candidate_id, rb.user_id
    from public.revote_ballots rb
    cross join lateral unnest(rb.selected_candidate_ids) selected_id
    where rb.room_id = p_room_id and rb.round = p_round and not rb.abstained
  ), totals as (
    select candidate_id, count(*)::integer as vote_count
    from votes group by candidate_id
  )
  select coalesce(sum(vote_count), 0), coalesce(max(vote_count), 0)
  into total_vote_count, highest_vote_count
  from totals;

  if total_vote_count = 0 then
    result_outcome := 'all_abstained';
    advancing_ids := target_round.candidate_ids;
  else
    with votes as (
      select selected_id as candidate_id
      from public.revote_ballots rb
      cross join lateral unnest(rb.selected_candidate_ids) selected_id
      where rb.room_id = p_room_id and rb.round = p_round and not rb.abstained
    ), totals as (
      select candidate_id, count(*)::integer as vote_count from votes group by candidate_id
    )
    select array_agg(c.id order by c.created_at), count(*)
    into advancing_ids, advancing_count
    from totals t
    join public.candidates c on c.id = t.candidate_id and c.room_id = p_room_id
    where t.vote_count = highest_vote_count;
    result_outcome := case when advancing_count = 1 then 'winner' else 'tie' end;
  end if;

  with candidate_totals as (
    select
      c.id as candidate_id,
      c.created_at,
      count(v.user_id)::integer as vote_count,
      coalesce(jsonb_agg(m.nickname order by m.joined_at) filter (where v.user_id is not null), '[]'::jsonb) as voter_nicknames
    from unnest(target_round.candidate_ids) candidate_id
    join public.candidates c on c.id = candidate_id and c.room_id = p_room_id
    left join (
      select selected_id as candidate_id, rb.user_id
      from public.revote_ballots rb
      cross join lateral unnest(rb.selected_candidate_ids) selected_id
      where rb.room_id = p_room_id and rb.round = p_round and not rb.abstained
    ) v on v.candidate_id = c.id
    left join public.room_members m on m.room_id = p_room_id and m.user_id = v.user_id
    group by c.id, c.created_at
  )
  select jsonb_agg(jsonb_build_object(
    'candidate_id', candidate_id,
    'vote_count', vote_count,
    'voter_nicknames', voter_nicknames
  ) order by created_at)
  into candidate_results
  from candidate_totals;

  update public.revote_rounds
  set outcome = result_outcome,
      advancing_candidate_ids = coalesce(advancing_ids, '{}'),
      result_data = jsonb_build_object('candidates', candidate_results),
      decided_by = current_user_id,
      decided_at = now()
  where room_id = p_room_id and round = p_round
  returning * into target_round;

  if result_outcome = 'winner' then
    update public.rooms
    set stage = 'completed', final_candidate_id = target_round.advancing_candidate_ids[1], updated_at = now()
    where id = p_room_id;
  elsif result_outcome = 'all_abstained' or p_round = 2 then
    update public.rooms set stage = 'ladder', updated_at = now() where id = p_room_id;
  else
    update public.rooms set updated_at = now() where id = p_room_id;
  end if;

  return target_round;
end;
$$;

revoke all on function public.start_room_revote(uuid, smallint, smallint) from public, anon;
revoke all on function public.save_room_revote(uuid, smallint, uuid[], boolean) from public, anon;
revoke all on function public.reopen_room_revote(uuid, smallint) from public, anon;
revoke all on function public.decide_room_revote(uuid, smallint) from public, anon;
grant execute on function public.start_room_revote(uuid, smallint, smallint) to authenticated;
grant execute on function public.save_room_revote(uuid, smallint, uuid[], boolean) to authenticated;
grant execute on function public.reopen_room_revote(uuid, smallint) to authenticated;
grant execute on function public.decide_room_revote(uuid, smallint) to authenticated;
