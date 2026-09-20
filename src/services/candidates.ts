import { ensureAnonymousSession } from "../lib/auth";
import { supabase } from "../lib/supabase";
import type { SearchTitle } from "./tmdb";

export type Candidate = {
  id: string;
  roomId: string;
  addedBy: string;
  addedByNickname: string;
  source: "tmdb" | "manual";
  mediaType: "movie" | "tv" | null;
  tmdbId: number | null;
  title: string;
  originalTitle: string | null;
  releaseDate: string | null;
  overview: string;
  posterPath: string | null;
  genreIds: number[];
  watchProviders: string[];
  collectionRound: 1 | 2;
  createdAt: string;
};

type CandidateRow = {
  id: string;
  room_id: string;
  added_by: string;
  source: "tmdb" | "manual";
  media_type: "movie" | "tv" | null;
  tmdb_id: number | null;
  title: string;
  original_title: string | null;
  release_date: string | null;
  overview: string;
  poster_path: string | null;
  genre_ids: number[];
  watch_providers: string[];
  collection_round: 1 | 2;
  created_at: string;
};

function toCandidate(row: CandidateRow, nickname: string): Candidate {
  return {
    id: row.id,
    roomId: row.room_id,
    addedBy: row.added_by,
    addedByNickname: nickname,
    source: row.source,
    mediaType: row.media_type,
    tmdbId: row.tmdb_id,
    title: row.title,
    originalTitle: row.original_title,
    releaseDate: row.release_date,
    overview: row.overview,
    posterPath: row.poster_path,
    genreIds: row.genre_ids ?? [],
    watchProviders: row.watch_providers ?? [],
    collectionRound: row.collection_round,
    createdAt: row.created_at,
  };
}

export async function loadCandidates(roomId: string) {
  await ensureAnonymousSession();

  const [candidateResponse, memberResponse] = await Promise.all([
    supabase
      .from("candidates")
      .select(
        "id, room_id, added_by, source, media_type, tmdb_id, title, original_title, release_date, overview, poster_path, genre_ids, watch_providers, collection_round, created_at",
      )
      .eq("room_id", roomId)
      .order("created_at", { ascending: true }),
    supabase.from("room_members").select("user_id, nickname").eq("room_id", roomId),
  ]);

  if (candidateResponse.error) throw candidateResponse.error;
  if (memberResponse.error) throw memberResponse.error;

  const nicknames = new Map(
    (memberResponse.data ?? []).map((member) => [member.user_id, member.nickname]),
  );

  return (candidateResponse.data as CandidateRow[]).map((row) =>
    toCandidate(row, nicknames.get(row.added_by) ?? "참여자"),
  );
}

export async function addSearchCandidate(roomId: string, title: SearchTitle, nickname: string) {
  await ensureAnonymousSession();

  const { data, error } = await supabase.rpc("add_search_candidate", {
    p_room_id: roomId,
    p_media_type: title.mediaType,
    p_tmdb_id: title.id,
    p_title: title.title,
    p_original_title: title.originalTitle,
    p_release_date: title.releaseDate,
    p_overview: title.overview,
    p_poster_path: title.posterPath,
    p_genre_ids: title.genreIds,
    p_watch_providers: title.watchProviders ?? [],
  });

  if (error) throw error;
  return toCandidate(data as CandidateRow, nickname);
}

export async function addManualCandidate(
  roomId: string,
  title: string,
  overview: string,
  nickname: string,
) {
  await ensureAnonymousSession();

  const { data, error } = await supabase.rpc("add_manual_candidate", {
    p_room_id: roomId,
    p_title: title,
    p_overview: overview,
  });

  if (error) throw error;
  return toCandidate(data as CandidateRow, nickname);
}

export async function deleteCandidate(candidateId: string) {
  await ensureAnonymousSession();

  const { data, error } = await supabase
    .from("candidates")
    .delete()
    .eq("id", candidateId)
    .select("id")
    .single();

  if (error) throw error;
  return data.id as string;
}

export function isDuplicateCandidateError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const message = "message" in error ? String(error.message) : "";
  const details = "details" in error ? String(error.details) : "";
  return message.includes("candidate_duplicate") || details.includes("candidate_duplicate");
}
