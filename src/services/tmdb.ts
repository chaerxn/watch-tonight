import { ensureAnonymousSession } from "../lib/auth";
import { supabase } from "../lib/supabase";

export type SearchTitle = {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle: string;
  releaseDate: string | null;
  overview: string;
  posterPath: string | null;
  genreIds: number[];
  watchProviders?: string[];
};

type SearchResponse = {
  page: number;
  totalPages: number;
  totalResults: number;
  results: SearchTitle[];
};

export async function searchTitles(query: string, page = 1) {
  const cleanQuery = query.trim();
  if (cleanQuery.length < 2) {
    throw new Error("검색어를 두 글자 이상 입력해 주세요.");
  }

  await ensureAnonymousSession();

  const { data, error } = await supabase.functions.invoke<SearchResponse>("tmdb-search", {
    body: { query: cleanQuery, page },
  });

  if (error) throw error;
  return data;
}
