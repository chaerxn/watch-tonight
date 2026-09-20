import { ensureAnonymousSession } from "../lib/auth";
import { supabase } from "../lib/supabase";

export type RevoteMemberStatus = "in_progress" | "completed";
export type RevoteOutcome = "winner" | "tie" | "all_abstained";

export type RevoteStatus = {
  userId: string;
  status: RevoteMemberStatus;
};

export type RevoteCandidateResult = {
  candidateId: string;
  voteCount: number;
  voterNicknames: string[];
};

export type RevoteRound = {
  round: 1 | 2;
  selectionCount: number;
  candidateIds: string[];
  outcome: RevoteOutcome | null;
  advancingCandidateIds: string[];
  candidates: RevoteCandidateResult[];
};

type RevoteRoundRow = {
  round: 1 | 2;
  selection_count: number;
  candidate_ids: string[];
  outcome: RevoteOutcome | null;
  advancing_candidate_ids: string[];
  result_data: {
    candidates?: Array<{
      candidate_id: string;
      vote_count: number;
      voter_nicknames: string[];
    }>;
  } | null;
};

function mapRound(row: RevoteRoundRow): RevoteRound {
  return {
    round: row.round,
    selectionCount: row.selection_count,
    candidateIds: row.candidate_ids,
    outcome: row.outcome,
    advancingCandidateIds: row.advancing_candidate_ids,
    candidates: (row.result_data?.candidates ?? []).map((candidate) => ({
      candidateId: candidate.candidate_id,
      voteCount: candidate.vote_count,
      voterNicknames: candidate.voter_nicknames,
    })),
  };
}

export async function startRoomRevote(roomId: string, round: 1 | 2, selectionCount: number) {
  await ensureAnonymousSession();
  const { data, error } = round === 1
    ? await supabase.rpc("start_evaluation_revote", {
        p_room_id: roomId,
        p_selection_count: selectionCount,
      })
    : await supabase.rpc("start_room_revote", {
        p_room_id: roomId,
        p_round: round,
        p_selection_count: selectionCount,
      });
  if (error) throw error;
  return mapRound(data as RevoteRoundRow);
}

export async function loadRevoteRound(roomId: string, round: 1 | 2): Promise<RevoteRound | null> {
  await ensureAnonymousSession();
  const { data, error } = await supabase
    .from("revote_rounds")
    .select("round, selection_count, candidate_ids, outcome, advancing_candidate_ids, result_data")
    .eq("room_id", roomId)
    .eq("round", round)
    .maybeSingle();
  if (error) throw error;
  return data ? mapRound(data as RevoteRoundRow) : null;
}

export async function loadLatestRevoteRound(roomId: string): Promise<RevoteRound | null> {
  await ensureAnonymousSession();
  const { data, error } = await supabase
    .from("revote_rounds")
    .select("round, selection_count, candidate_ids, outcome, advancing_candidate_ids, result_data")
    .eq("room_id", roomId)
    .order("round", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? mapRound(data as RevoteRoundRow) : null;
}

export async function loadRevoteState(roomId: string, round: 1 | 2) {
  await ensureAnonymousSession();
  const [roundResponse, ballotResponse, statusesResponse] = await Promise.all([
    loadRevoteRound(roomId, round),
    supabase
      .from("revote_ballots")
      .select("selected_candidate_ids, abstained")
      .eq("room_id", roomId)
      .eq("round", round)
      .maybeSingle(),
    supabase
      .from("revote_statuses")
      .select("user_id, status")
      .eq("room_id", roomId)
      .eq("round", round),
  ]);
  if (ballotResponse.error) throw ballotResponse.error;
  if (statusesResponse.error) throw statusesResponse.error;
  const ballot = ballotResponse.data as { selected_candidate_ids: string[]; abstained: boolean } | null;
  return {
    round: roundResponse,
    selectedCandidateIds: ballot?.selected_candidate_ids ?? [],
    abstained: ballot?.abstained ?? false,
    statuses: (statusesResponse.data as Array<{ user_id: string; status: RevoteMemberStatus }>).map((status) => ({
      userId: status.user_id,
      status: status.status,
    })),
  };
}

export async function loadRevoteStatuses(roomId: string, round: 1 | 2): Promise<RevoteStatus[]> {
  await ensureAnonymousSession();
  const { data, error } = await supabase
    .from("revote_statuses")
    .select("user_id, status")
    .eq("room_id", roomId)
    .eq("round", round);
  if (error) throw error;
  return (data as Array<{ user_id: string; status: RevoteMemberStatus }>).map((status) => ({
    userId: status.user_id,
    status: status.status,
  }));
}

export async function saveRoomRevote(
  roomId: string,
  round: 1 | 2,
  selectedCandidateIds: string[],
  abstained: boolean,
) {
  await ensureAnonymousSession();
  const { error } = await supabase.rpc("save_room_revote", {
    p_room_id: roomId,
    p_round: round,
    p_selected_candidate_ids: selectedCandidateIds,
    p_abstained: abstained,
  });
  if (error) throw error;
}

export async function reopenRoomRevote(roomId: string, round: 1 | 2) {
  await ensureAnonymousSession();
  const { error } = await supabase.rpc("reopen_room_revote", {
    p_room_id: roomId,
    p_round: round,
  });
  if (error) throw error;
}

export async function decideRoomRevote(roomId: string, round: 1 | 2): Promise<RevoteRound> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("decide_room_revote", {
    p_room_id: roomId,
    p_round: round,
  });
  if (error) throw error;
  return mapRound(data as RevoteRoundRow);
}
