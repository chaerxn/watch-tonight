alter table public.room_members
  add column if not exists hidden_at timestamptz;

drop policy if exists "members can hide own completed rooms" on public.room_members;
create policy "members can hide own completed rooms"
on public.room_members
for update
to authenticated
using (
  user_id = (select auth.uid())
  and status = 'active'
  and exists (
    select 1
    from public.rooms r
    where r.id = room_members.room_id
      and r.stage = 'completed'
  )
)
with check (
  user_id = (select auth.uid())
  and status = 'active'
  and exists (
    select 1
    from public.rooms r
    where r.id = room_members.room_id
      and r.stage = 'completed'
  )
);

grant update (hidden_at) on public.room_members to authenticated;
