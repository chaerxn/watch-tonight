alter table public.rooms
  add column final_candidate_id uuid references public.candidates(id) on delete restrict;

create index rooms_final_candidate_id_idx
  on public.rooms(final_candidate_id)
  where final_candidate_id is not null;

create or replace function public.advance_first_evaluation(p_room_id uuid)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  target_room public.rooms;
  first_result public.evaluation_results;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  select *
    into target_room
  from public.rooms r
  where r.id = p_room_id
  for update;

  if target_room.id is null
     or target_room.owner_id <> current_user_id
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
    into first_result
  from public.evaluation_results er
  where er.room_id = p_room_id
    and er.round = 1;

  if first_result.room_id is null then
    raise exception using errcode = 'P0001', message = 'result_not_ready';
  end if;

  if first_result.outcome = 'winner' then
    if cardinality(first_result.advancing_candidate_ids) <> 1 then
      raise exception using errcode = 'P0001', message = 'invalid_result';
    end if;

    if target_room.stage = 'completed'
       and target_room.final_candidate_id = first_result.advancing_candidate_ids[1] then
      return target_room;
    end if;

    if target_room.stage <> 'rating' then
      raise exception using errcode = 'P0001', message = 'room_stage_changed';
    end if;

    update public.rooms
    set stage = 'completed',
        final_candidate_id = first_result.advancing_candidate_ids[1],
        updated_at = now()
    where id = p_room_id
    returning * into target_room;

    return target_room;
  end if;

  if first_result.outcome = 'needs_more_candidates' then
    if target_room.stage = 'adding_candidates' then
      return target_room;
    end if;

    if target_room.stage <> 'rating' then
      raise exception using errcode = 'P0001', message = 'room_stage_changed';
    end if;

    if exists (
      select 1
      from public.candidates c
      where c.room_id = p_room_id
        and c.collection_round = 2
    ) then
      raise exception using errcode = 'P0001', message = 'additional_collection_already_used';
    end if;

    update public.rooms
    set stage = 'adding_candidates',
        updated_at = now()
    where id = p_room_id
    returning * into target_room;

    return target_room;
  end if;

  raise exception using errcode = 'P0001', message = 'revote_setup_required';
end;
$$;

create or replace function public.add_search_candidate(
  p_room_id uuid,
  p_media_type text,
  p_tmdb_id integer,
  p_title text,
  p_original_title text,
  p_release_date text,
  p_overview text,
  p_poster_path text,
  p_genre_ids integer[],
  p_watch_providers text[]
)
returns public.candidates
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  current_stage text;
  current_round smallint;
  new_candidate public.candidates;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  if p_media_type not in ('movie', 'tv') or p_tmdb_id is null then
    raise exception using errcode = 'P0001', message = 'invalid_candidate';
  end if;

  if p_title is null or char_length(btrim(p_title)) not between 1 and 200 then
    raise exception using errcode = 'P0001', message = 'invalid_candidate';
  end if;

  select r.stage
    into current_stage
  from public.rooms r
  join public.room_members m
    on m.room_id = r.id
   and m.user_id = current_user_id
   and m.status = 'active'
  where r.id = p_room_id;

  if current_stage is null then
    raise exception using errcode = 'P0001', message = 'room_access_denied';
  end if;

  current_round := case current_stage
    when 'collecting' then 1
    when 'adding_candidates' then 2
    else null
  end;

  if current_round is null then
    raise exception using errcode = 'P0001', message = 'candidate_collection_closed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_room_id::text || ':' || current_user_id::text || ':' || current_round::text,
      0
    )
  );

  if exists (
    select 1
    from public.candidates c
    where c.room_id = p_room_id
      and c.source = 'tmdb'
      and c.media_type = p_media_type
      and c.tmdb_id = p_tmdb_id
  ) then
    raise exception using errcode = 'P0001', message = 'candidate_duplicate';
  end if;

  if (
    select count(*)
    from public.candidates c
    where c.room_id = p_room_id
      and c.added_by = current_user_id
      and c.collection_round = current_round
  ) >= 5 then
    raise exception using errcode = 'P0001', message = 'candidate_limit_reached';
  end if;

  if (select count(*) from public.candidates c where c.room_id = p_room_id) >= 80 then
    raise exception using errcode = 'P0001', message = 'room_candidate_limit_reached';
  end if;

  insert into public.candidates (
    room_id, added_by, source, media_type, tmdb_id, title, original_title,
    release_date, overview, poster_path, genre_ids, watch_providers, collection_round
  ) values (
    p_room_id, current_user_id, 'tmdb', p_media_type, p_tmdb_id, btrim(p_title),
    nullif(btrim(coalesce(p_original_title, '')), ''),
    nullif(btrim(coalesce(p_release_date, '')), ''),
    coalesce(p_overview, ''),
    nullif(btrim(coalesce(p_poster_path, '')), ''),
    coalesce(p_genre_ids, '{}'),
    coalesce(p_watch_providers, '{}'),
    current_round
  )
  returning * into new_candidate;

  return new_candidate;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'candidate_duplicate';
end;
$$;

revoke all on function public.advance_first_evaluation(uuid) from public, anon;
revoke all on function public.add_search_candidate(
  uuid, text, integer, text, text, text, text, text, integer[], text[]
) from public, anon;
grant execute on function public.advance_first_evaluation(uuid) to authenticated;
grant execute on function public.add_search_candidate(
  uuid, text, integer, text, text, text, text, text, integer[], text[]
) to authenticated;
