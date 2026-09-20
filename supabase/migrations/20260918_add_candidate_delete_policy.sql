create policy "owners can delete their candidates before evaluation"
  on public.candidates
  for delete
  to authenticated
  using (
    added_by = (select auth.uid())
    and exists (
      select 1
      from public.rooms
      where rooms.id = candidates.room_id
        and (
          (rooms.stage = 'collecting' and candidates.collection_round = 1)
          or (rooms.stage = 'adding_candidates' and candidates.collection_round = 2)
        )
    )
  );

grant delete on table public.candidates to authenticated;
