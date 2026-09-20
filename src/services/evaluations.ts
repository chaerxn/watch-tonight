import { ensureAnonymousSession } from "../lib/auth";
import { supabase } from "../lib/supabase";
import type { CreatedRoom } from "./rooms";

export type EvaluationChoice = "want" | "okay" | "dislike";
export type EvaluationMemberStatus = "in_progress" | "completed";

export type EvaluationStatus = {
  userId: string;
  status: EvaluationMemberStatus;
};

export type EvaluationResultOutcome = "winner" | "revote" | "needs_more_candidates";

export type EvaluationCandidateResult = {
  candidateId: string;
  wantCount: number;
  okayCount: number;
  dislikeCount: number;
  wantNicknames: string[];
  okayNicknames: string[];
  dislikeNicknames: string[];
};

export type EvaluationResult = {
  outcome: EvaluationResultOutcome;
  advancingCandidateIds: string[];
  candidates: EvaluationCandidateResult[];
};

export type EvaluationRoundResult = EvaluationResult & { round: 1 | 2 };

type RatingRow = {
  candidate_id: string;
  rating: EvaluationChoice;
};

type StatusRow = {
  user_id: string;
  status: EvaluationMemberStatus;
};

type ResultRow = {
  round?: 1 | 2;
  outcome: EvaluationResultOutcome;
  advancing_candidate_ids: string[];
  result_data: {
    candidates?: Array<{
      candidate_id: string;
      want_count: number;
      okay_count: number;
      dislike_count: number;
      want_nicknames: string[];
      okay_nicknames: string[];
      dislike_nicknames: string[];
    }>;
  };
};

function mapResult(row: ResultRow): EvaluationResult {
  return {
    outcome: row.outcome,
    advancingCandidateIds: row.advancing_candidate_ids,
    candidates: (row.result_data.candidates ?? []).map((candidate) => ({
      candidateId: candidate.candidate_id,
      wantCount: candidate.want_count,
      okayCount: candidate.okay_count,
      dislikeCount: candidate.dislike_count,
      wantNicknames: candidate.want_nicknames,
      okayNicknames: candidate.okay_nicknames,
      dislikeNicknames: candidate.dislike_nicknames,
    })),
  };
}

export async function loadEvaluationResults(roomId: string): Promise<EvaluationRoundResult[]> {
  await ensureAnonymousSession();
  const { data, error } = await supabase
    .from("evaluation_results")
    .select("round, outcome, advancing_candidate_ids, result_data")
    .eq("room_id", roomId)
    .order("round", { ascending: true });

  if (error) throw error;
  return (data as ResultRow[]).map((row) => ({ ...mapResult(row), round: row.round ?? 1 }));
}

export async function loadEvaluationResult(roomId: string, round: 1 | 2 = 1): Promise<EvaluationResult | null> {
  await ensureAnonymousSession();
  const { data, error } = await supabase
    .from("evaluation_results")
    .select("outcome, advancing_candidate_ids, result_data")
    .eq("room_id", roomId)
    .eq("round", round)
    .maybeSingle();

  if (error) throw error;
  return data ? mapResult(data as ResultRow) : null;
}

export async function loadLatestEvaluationResult(roomId: string): Promise<EvaluationResult | null> {
  await ensureAnonymousSession();
  const { data, error } = await supabase
    .from("evaluation_results")
    .select("outcome, advancing_candidate_ids, result_data")
    .eq("room_id", roomId)
    .order("round", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ? mapResult(data as ResultRow) : null;
}

export async function loadEvaluationStatuses(roomId: string, round: 1 | 2 = 1): Promise<EvaluationStatus[]> {
  await ensureAnonymousSession();
  const { data, error } = await supabase
    .from("evaluation_statuses")
    .select("user_id, status")
    .eq("room_id", roomId)
    .eq("round", round);

  if (error) throw error;
  return (data as StatusRow[]).map((row) => ({ userId: row.user_id, status: row.status }));
}

export async function loadEvaluationState(roomId: string, round: 1 | 2 = 1) {
  await ensureAnonymousSession();
  const [ratingsResponse, statuses, result] = await Promise.all([
    supabase
      .from("evaluation_ratings")
      .select("candidate_id, rating")
      .eq("room_id", roomId)
      .eq("round", round),
    loadEvaluationStatuses(roomId, round),
    loadEvaluationResult(roomId, round),
  ]);

  if (ratingsResponse.error) throw ratingsResponse.error;
  const choices = Object.fromEntries(
    (ratingsResponse.data as RatingRow[]).map((row) => [row.candidate_id, row.rating]),
  ) as Record<string, EvaluationChoice>;

  return { choices, statuses, result };
}

export async function saveRoomEvaluation(
  roomId: string,
  round: 1 | 2,
  choices: Record<string, EvaluationChoice>,
) {
  await ensureAnonymousSession();
  const ratings = Object.entries(choices).map(([candidateId, rating]) => ({
    candidate_id: candidateId,
    rating,
  }));
  const { error } = await supabase.rpc("save_room_evaluation", {
    p_room_id: roomId,
    p_round: round,
    p_ratings: ratings,
  });
  if (error) throw error;
}

export async function reopenRoomEvaluation(roomId: string, round: 1 | 2) {
  await ensureAnonymousSession();
  const { error } = await supabase.rpc("reopen_room_evaluation", {
    p_room_id: roomId,
    p_round: round,
  });
  if (error) throw error;
}

export async function decideFirstEvaluation(roomId: string): Promise<EvaluationResult> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("decide_first_evaluation", {
    p_room_id: roomId,
  });
  if (error) throw error;
  return mapResult(data as ResultRow);
}

export async function decideSecondEvaluation(roomId: string): Promise<EvaluationResult> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("decide_second_evaluation", {
    p_room_id: roomId,
  });
  if (error) throw error;
  return mapResult(data as ResultRow);
}

export async function advanceFirstEvaluation(roomId: string): Promise<CreatedRoom> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("advance_first_evaluation", {
    p_room_id: roomId,
  });
  if (error) throw error;
  return data as CreatedRoom;
}

export async function advanceSecondEvaluation(roomId: string): Promise<CreatedRoom> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("advance_second_evaluation", {
    p_room_id: roomId,
  });
  if (error) throw error;
  return data as CreatedRoom;
}
