create unique index candidates_room_manual_unique
  on public.candidates (room_id, btrim(title), btrim(overview))
  where source = 'manual';

create or replace function public.add_manual_candidate(
  p_room_id uuid,
  p_title text,
  p_overview text
)
returns public.candidates
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_user_id uuid := (select auth.uid());
  current_stage text;
  current_round smallint;
  clean_title text := btrim(coalesce(p_title, ''));
  clean_overview text := btrim(coalesce(p_overview, ''));
  new_candidate public.candidates;
begin
  if current_user_id is null then
    raise exception using errcode = 'P0001', message = 'authentication_required';
  end if;

  if char_length(clean_title) not between 1 and 200 then
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
      and c.source = 'manual'
      and btrim(c.title) = clean_title
      and btrim(c.overview) = clean_overview
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
    room_id,
    added_by,
    source,
    media_type,
    tmdb_id,
    title,
    original_title,
    release_date,
    overview,
    poster_path,
    genre_ids,
    watch_providers,
    collection_round
  ) values (
    p_room_id,
    current_user_id,
    'manual',
    null,
    null,
    clean_title,
    null,
    null,
    clean_overview,
    null,
    '{}',
    '{}',
    current_round
  )
  returning * into new_candidate;

  return new_candidate;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'candidate_duplicate';
end;
$function$;

revoke all on function public.add_manual_candidate(uuid, text, text) from public;
revoke execute on function public.add_manual_candidate(uuid, text, text) from anon;
grant execute on function public.add_manual_candidate(uuid, text, text) to authenticated;
