revoke execute on function public.add_search_candidate(
  uuid, text, integer, text, text, text, text, text, integer[], text[]
) from anon;

create index candidates_added_by_idx on public.candidates (added_by);
