create index evaluation_results_room_decided_by_idx
  on public.evaluation_results(room_id, decided_by);
