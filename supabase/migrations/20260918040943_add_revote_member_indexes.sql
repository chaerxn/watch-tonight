create index revote_rounds_room_started_by_idx
  on public.revote_rounds(room_id, started_by);

create index revote_rounds_room_decided_by_idx
  on public.revote_rounds(room_id, decided_by)
  where decided_by is not null;

create index revote_ballots_room_user_idx
  on public.revote_ballots(room_id, user_id);

create index revote_statuses_room_user_idx
  on public.revote_statuses(room_id, user_id);
