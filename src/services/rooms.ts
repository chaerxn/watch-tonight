import { Clipboard, Share } from "@apps-in-toss/web-framework";
import { ensureAnonymousSession } from "../lib/auth";
import { supabase } from "../lib/supabase";

export type RoomStage = "collecting" | "rating" | "adding_candidates" | "revote_1" | "revote_2" | "ladder" | "completed";

export type CreatedRoom = {
  id: string;
  name: string;
  owner_id: string;
  is_auto_name: boolean;
  member_count: number;
  stage: RoomStage;
  evaluation_round: 1 | 2;
  final_candidate_id: string | null;
  invite_code: string;
  created_at: string;
};

export type RoomMember = { userId: string; nickname: string; role: "host" | "member" };

export type RoomSummary = {
  room: CreatedRoom;
  nickname: string;
  userId: string;
  members: RoomMember[];
  candidateCount: number;
  finalCandidate: { title: string; posterPath: string | null } | null;
  progress: RoomProgress;
};

export type RoomProgress = {
  percent: number;
  label: string;
  detail: string;
};

export type RoomMembershipActionResult = {
  room: CreatedRoom;
  nickname: string;
  memberCount: number;
};

export type InviteRoom = {
  room: CreatedRoom;
  memberCount: number;
  status: "open" | "already_member" | "started" | "full" | "kicked";
  nickname: string | null;
};

type RoomMemberRow = {
  room_id: string;
  user_id: string;
  nickname: string;
  role: "host" | "member";
  status: "active" | "left" | "kicked";
};

type ProgressStatusRow = {
  room_id: string;
  round: 1 | 2;
  status: "in_progress" | "completed";
};

type CandidateCountRow = {
  id: string;
  room_id: string;
  title: string;
  poster_path: string | null;
  collection_round: 1 | 2;
};

function toMember(row: RoomMemberRow): RoomMember {
  return { userId: row.user_id, nickname: row.nickname, role: row.role };
}

function completionRatio(rows: ProgressStatusRow[], roomId: string, round: 1 | 2, memberCount: number) {
  if (memberCount === 0) return 0;
  const completedCount = rows.filter((row) => row.room_id === roomId && row.round === round && row.status === "completed").length;
  return Math.min(completedCount / memberCount, 1);
}

function makeRoomProgress(
  room: CreatedRoom,
  memberCount: number,
  candidateCount: number,
  additionalCandidateCount: number,
  evaluationStatuses: ProgressStatusRow[],
  revoteStatuses: ProgressStatusRow[],
): RoomProgress {
  if (room.stage === "collecting") {
    const readiness = (Math.min(memberCount / 2, 1) + Math.min(candidateCount / 2, 1)) / 2;
    return { percent: Math.round(8 + readiness * 12), label: "후보 모으는 중", detail: "후보를 모으는 단계" };
  }
  if (room.stage === "adding_candidates") {
    const percent = additionalCandidateCount > 0 ? 50 : 46;
    return { percent, label: "추가 후보 모으는 중", detail: "추가 후보를 모으는 단계" };
  }
  if (room.stage === "rating") {
    const round = room.evaluation_round ?? 1;
    const ratio = completionRatio(evaluationStatuses, room.id, round, memberCount);
    const completedCount = Math.round(ratio * memberCount);
    const start = round === 1 ? 25 : 55;
    const span = round === 1 ? 20 : 10;
    return {
      percent: Math.round(start + ratio * span),
      label: round === 1 ? "1차 평가 중" : "전체 후보 재평가 중",
      detail: `${memberCount}명 중 ${completedCount}명 완료`,
    };
  }
  if (room.stage === "revote_1" || room.stage === "revote_2") {
    const round = room.stage === "revote_1" ? 1 : 2;
    const ratio = completionRatio(revoteStatuses, room.id, round, memberCount);
    const completedCount = Math.round(ratio * memberCount);
    const start = round === 1 ? 70 : 82;
    return {
      percent: Math.round(start + ratio * 8),
      label: round === 1 ? "1차 재투표 중" : "2차 재투표 중",
      detail: `${memberCount}명 중 ${completedCount}명 완료`,
    };
  }
  if (room.stage === "ladder") {
    return { percent: 94, label: "사다리타기", detail: "최종 작품을 정하는 단계" };
  }
  return { percent: 100, label: "결정 완료", detail: "최종 작품 결정 완료" };
}

export async function createRoom({ name, nickname, isAutoName }: { name: string; nickname: string; isAutoName: boolean }) {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("create_room", {
    p_name: name,
    p_nickname: nickname,
    p_is_auto_name: isAutoName,
  });
  if (error) throw error;
  return data as CreatedRoom;
}

export async function loadMyRooms(): Promise<RoomSummary[]> {
  const session = await ensureAnonymousSession();
  const userId = session.user.id;
  const membershipResponse = await supabase
    .from("room_members")
    .select("room_id, user_id, nickname, role, status")
    .eq("user_id", userId)
    .eq("status", "active")
    .is("hidden_at", null);

  if (membershipResponse.error) throw membershipResponse.error;
  const ownMemberships = membershipResponse.data as RoomMemberRow[];
  const roomIds = ownMemberships.map((membership) => membership.room_id);
  if (roomIds.length === 0) return [];

  const [roomsResponse, membersResponse, candidatesResponse, evaluationStatusesResponse, revoteStatusesResponse] = await Promise.all([
    supabase.from("rooms").select("*").in("id", roomIds).order("updated_at", { ascending: false }),
    supabase.from("room_members").select("room_id, user_id, nickname, role, status").in("room_id", roomIds).eq("status", "active").order("joined_at", { ascending: true }),
    supabase.from("candidates").select("id, room_id, title, poster_path, collection_round").in("room_id", roomIds),
    supabase.from("evaluation_statuses").select("room_id, round, status").in("room_id", roomIds),
    supabase.from("revote_statuses").select("room_id, round, status").in("room_id", roomIds),
  ]);

  if (roomsResponse.error) throw roomsResponse.error;
  if (membersResponse.error) throw membersResponse.error;
  if (candidatesResponse.error) throw candidatesResponse.error;
  if (evaluationStatusesResponse.error) throw evaluationStatusesResponse.error;
  if (revoteStatusesResponse.error) throw revoteStatusesResponse.error;

  const membersByRoom = new Map<string, RoomMember[]>();
  for (const row of membersResponse.data as RoomMemberRow[]) {
    const members = membersByRoom.get(row.room_id) ?? [];
    members.push(toMember(row));
    membersByRoom.set(row.room_id, members);
  }

  const candidateCounts = new Map<string, number>();
  const additionalCandidateCounts = new Map<string, number>();
  const candidatesById = new Map<string, CandidateCountRow>();
  for (const candidate of candidatesResponse.data as CandidateCountRow[]) {
    candidatesById.set(candidate.id, candidate);
    candidateCounts.set(candidate.room_id, (candidateCounts.get(candidate.room_id) ?? 0) + 1);
    if (candidate.collection_round === 2) {
      additionalCandidateCounts.set(candidate.room_id, (additionalCandidateCounts.get(candidate.room_id) ?? 0) + 1);
    }
  }

  const nicknames = new Map(ownMemberships.map((membership) => [membership.room_id, membership.nickname]));
  const evaluationStatuses = evaluationStatusesResponse.data as ProgressStatusRow[];
  const revoteStatuses = revoteStatusesResponse.data as ProgressStatusRow[];
  return (roomsResponse.data as CreatedRoom[]).map((room) => {
    const members = membersByRoom.get(room.id) ?? [];
    const candidateCount = candidateCounts.get(room.id) ?? 0;
    return {
      room,
      nickname: nicknames.get(room.id) ?? "참여자",
      userId,
      members,
      candidateCount,
      finalCandidate: room.final_candidate_id
        ? (() => {
            const candidate = candidatesById.get(room.final_candidate_id);
            return candidate ? { title: candidate.title, posterPath: candidate.poster_path } : null;
          })()
        : null,
      progress: makeRoomProgress(
        room,
        members.length,
        candidateCount,
        additionalCandidateCounts.get(room.id) ?? 0,
        evaluationStatuses,
        revoteStatuses,
      ),
    };
  });
}

export async function loadRoomSummary(roomId: string): Promise<RoomSummary> {
  const rooms = await loadMyRooms();
  const room = rooms.find((item) => item.room.id === roomId);
  if (!room) throw new Error("room_access_denied");
  return room;
}

export async function inspectInviteRoom(inviteCode: string): Promise<InviteRoom> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("inspect_invite_room", { p_invite_code: inviteCode });
  if (error) throw error;
  const result = data as { room: CreatedRoom; member_count: number; status: InviteRoom["status"]; nickname: string | null };
  return { room: result.room, memberCount: result.member_count, status: result.status, nickname: result.nickname };
}

export async function joinRoomByInvite(inviteCode: string, nickname: string): Promise<RoomSummary> {
  const session = await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("join_room_by_invite", { p_invite_code: inviteCode, p_nickname: nickname });
  if (error) throw error;
  const result = data as { room: CreatedRoom; nickname: string };
  return {
    room: result.room,
    nickname: result.nickname,
    userId: session.user.id,
    members: [],
    candidateCount: 0,
    finalCandidate: null,
    progress: { percent: 8, label: "후보 모으는 중", detail: "후보를 모으는 단계" },
  };
}

export async function startRoomEvaluation(roomId: string): Promise<CreatedRoom> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("start_room_evaluation", { p_room_id: roomId });
  if (error) throw error;
  return data as CreatedRoom;
}

export async function startSecondEvaluation(roomId: string): Promise<CreatedRoom> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("start_second_evaluation", { p_room_id: roomId });
  if (error) throw error;
  return data as CreatedRoom;
}

export async function kickRoomMember(roomId: string, userId: string): Promise<RoomMembershipActionResult> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("kick_room_member", {
    p_room_id: roomId,
    p_user_id: userId,
  });
  if (error) throw error;
  const result = data as { room: CreatedRoom; nickname: string; member_count: number };
  return { room: result.room, nickname: result.nickname, memberCount: result.member_count };
}

export async function leaveRoom(roomId: string): Promise<RoomMembershipActionResult> {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("leave_room", { p_room_id: roomId });
  if (error) throw error;
  const result = data as { room: CreatedRoom; nickname: string; member_count: number };
  return { room: result.room, nickname: result.nickname, memberCount: result.member_count };
}

export async function deleteRoomByHost(roomId: string) {
  await ensureAnonymousSession();
  const { data, error } = await supabase.rpc("delete_room_by_host", { p_room_id: roomId });
  if (error) throw error;
  return data as string;
}

export async function hideCompletedRoomFromHome(roomId: string) {
  const session = await ensureAnonymousSession();
  const { data, error } = await supabase
    .from("room_members")
    .update({ hidden_at: new Date().toISOString() })
    .eq("room_id", roomId)
    .eq("user_id", session.user.id)
    .eq("status", "active")
    .select("room_id")
    .single();
  if (error) throw error;
  return data.room_id as string;
}

export function isRoomServiceError(error: unknown, code: string) {
  if (!error || typeof error !== "object") return false;
  const message = "message" in error ? String(error.message) : "";
  const details = "details" in error ? String(error.details) : "";
  return message.includes(code) || details.includes(code);
}

export async function copyRoomInviteLink(inviteCode: string) {
  let link: string;
  try {
    link = await Share.createLink({
      path: `intoss://movie-tago/invite?code=${encodeURIComponent(inviteCode)}`,
      ogImageUrl: "https://raw.githubusercontent.com/chaerxn/watch-tonight/main/public/og-watch-tonight-kakao.png",
    });
  } catch {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("invite", inviteCode);
    link = url.toString();
  }

  try {
    await Clipboard.setText(link);
    return "copied" as const;
  } catch {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(link);
        return "copied" as const;
      } catch {
        // Fall back to the native share sheet below.
      }
    }
    await Share.sendMessage({ message: `오늘 뭐 볼래? 선택방에 참여해 주세요.\n${link}` });
    return "shared" as const;
  }
}
