import { ensureAnonymousSession } from "../lib/auth";
import { supabase } from "../lib/supabase";
import type { CreatedRoom } from "./rooms";

export type LadderRung = { level: number; leftLane: number };

export type LadderRun = {
  run: 1 | 2;
  winningLane: number;
  candidateOrder: string[];
  rungs: LadderRung[];
  winnerCandidateId: string;
};

export type LadderSession = {
  candidateIds: string[];
  sourceCandidateCount: number;
  firstRun: LadderRun | null;
  secondRun: LadderRun | null;
  finalRun: 1 | 2 | null;
  winnerCandidateId: string | null;
};

type LadderRunRow = {
  run: 1 | 2;
  winning_lane: number;
  candidate_order: string[];
  rungs: Array<{ level: number; left_lane: number }>;
  winner_candidate_id: string;
};

type LadderSessionRow = {
  candidate_ids: string[];
  source_candidate_count: number;
  first_run: LadderRunRow | null;
  second_run: LadderRunRow | null;
  final_run: 1 | 2 | null;
  winner_candidate_id: string | null;
};

function mapRun(run: LadderRunRow | null): LadderRun | null {
  if (!run) return null;
  return {
    run: run.run,
    winningLane: run.winning_lane,
    candidateOrder: run.candidate_order,
    rungs: run.rungs.map((rung) => ({ level: rung.level, leftLane: rung.left_lane })),
    winnerCandidateId: run.winner_candidate_id,
  };
}

function mapSession(row: LadderSessionRow): LadderSession {
  return {
    candidateIds: row.candidate_ids,
    sourceCandidateCount: row.source_candidate_count,
    firstRun: mapRun(row.first_run),
    secondRun: mapRun(row.second_run),
    finalRun: row.final_run,
    winnerCandidateId: row.winner_candidate_id,
  };
}

export async function loadLadderSession(roomId: string): Promise<LadderSession | null> {
  await ensureAnonymousSession();
  const { data, error } = await supabase
    .from("ladder_sessions")
    .select("candidate_ids, source_candidate_count, first_run, second_run, final_run, winner_candidate_id")
    .eq("room_id", roomId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapSession(data as LadderSessionRow) : null;
}

export async function prepareRoomLadder(roomId: string): Promise<LadderSession> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("prepare_room_ladder", { p_room_id: roomId });
  if (error) throw error;
  return mapSession(data as LadderSessionRow);
}

export async function startLadderRun(roomId: string, run: 1 | 2): Promise<LadderSession> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("start_ladder_run", { p_room_id: roomId, p_run: run });
  if (error) throw error;
  return mapSession(data as LadderSessionRow);
}

export async function finalizeLadder(roomId: string, run: 1 | 2): Promise<CreatedRoom> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("finalize_ladder", { p_room_id: roomId, p_run: run });
  if (error) throw error;
  return data as CreatedRoom;
}
