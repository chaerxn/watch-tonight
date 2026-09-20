create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  added_by uuid not null references auth.users(id),
  source text not null default 'tmdb' check (source in ('tmdb', 'manual')),
  media_type text check (media_type in ('movie', 'tv')),
  tmdb_id integer,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  original_title text,
  release_date text,
  overview text not null default '',
  poster_path text,
  genre_ids integer[] not null default '{}',
  watch_providers text[] not null default '{}',
  collection_round smallint not null default 1 check (collection_round in (1, 2)),
  created_at timestamptz not null default now(),
  check (
    (source = 'tmdb' and media_type is not null and tmdb_id is not null)
    or (source = 'manual' and media_type is null and tmdb_id is null)
  )
);

create unique index candidates_room_tmdb_unique
  on public.candidates (room_id, media_type, tmdb_id)
  where source = 'tmdb';

create index candidates_room_created_at_idx
  on public.candidates (room_id, created_at);

alter table public.candidates enable row level security;

create policy "members can read room candidates"
  on public.candidates
  for select
  to authenticated
  using ((select private.is_room_member(room_id)));

grant select on table public.candidates to authenticated;

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
as $function$
declare
  current_user_id uuid := (select auth.uid());
  current_stage text;
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

  if current_stage <> 'collecting' then
    raise exception using errcode = 'P0001', message = 'candidate_collection_closed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_room_id::text || ':' || current_user_id::text || ':1', 0)
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
      and c.collection_round = 1
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
    'tmdb',
    p_media_type,
    p_tmdb_id,
    btrim(p_title),
    nullif(btrim(coalesce(p_original_title, '')), ''),
    nullif(btrim(coalesce(p_release_date, '')), ''),
    coalesce(p_overview, ''),
    nullif(btrim(coalesce(p_poster_path, '')), ''),
    coalesce(p_genre_ids, '{}'),
    coalesce(p_watch_providers, '{}'),
    1
  )
  returning * into new_candidate;

  return new_candidate;
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'candidate_duplicate';
end;
$function$;

revoke all on function public.add_search_candidate(
  uuid, text, integer, text, text, text, text, text, integer[], text[]
) from public;

grant execute on function public.add_search_candidate(
  uuid, text, integer, text, text, text, text, text, integer[], text[]
) to authenticated;
