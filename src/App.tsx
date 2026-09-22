import {
  AnimationEvent,
  CSSProperties,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Environment } from "@apps-in-toss/web-framework";
import "./App.css";
import ladderLosingDotIcon from "./assets/ladder-losing-dot.svg";
import ladderWinningPopcornIcon from "./assets/ladder-winning-popcorn.svg";
import {
  addManualCandidate,
  addSearchCandidate,
  deleteCandidate,
  isDuplicateCandidateError,
  loadCandidates,
  type Candidate,
} from "./services/candidates";
import {
  advanceFirstEvaluation,
  advanceSecondEvaluation,
  decideFirstEvaluation,
  decideSecondEvaluation,
  loadEvaluationResults,
  loadEvaluationState,
  loadEvaluationResult,
  loadEvaluationStatuses,
  reopenRoomEvaluation,
  saveRoomEvaluation,
  type EvaluationChoice,
  type EvaluationResult,
  type EvaluationRoundResult,
  type EvaluationStatus,
} from "./services/evaluations";
import {
  copyRoomInviteLink,
  createRoom,
  deleteRoomByHost,
  hideCompletedRoomFromHome,
  inspectInviteRoom,
  isRoomServiceError,
  joinRoomByInvite,
  kickRoomMember,
  leaveRoom,
  loadMyRooms,
  loadRoomSummary,
  startRoomEvaluation,
  startSecondEvaluation,
  type InviteRoom,
  type RoomMembershipActionResult,
  type RoomStage,
  type RoomSummary,
} from "./services/rooms";
import {
  decideRoomRevote,
  loadLatestRevoteRound,
  loadRevoteRound,
  loadRevoteState,
  loadRevoteStatuses,
  reopenRoomRevote,
  saveRoomRevote,
  startRoomRevote,
  type RevoteRound,
  type RevoteStatus,
} from "./services/revotes";
import {
  finalizeLadder,
  loadLadderSession,
  prepareRoomLadder,
  startLadderRun,
  type LadderRun,
  type LadderSession,
} from "./services/ladders";
import { searchTitles, type SearchTitle } from "./services/tmdb";
import { supabase } from "./lib/supabase";
import { getInitialInviteCode } from "./lib/invite-url";

type Screen = "home" | "information-source" | "create-room" | "candidate-room" | "room-info" | "participation-ended" | "room-ended" | "title-search" | "manual-entry" | "invite" | "evaluation" | "revote-setup" | "revote" | "ladder" | "final-result" | "decision-history";

type RoomSession = RoomSummary;

type MembershipAction =
  | { kind: "kick"; target: RoomSession["members"][number]; state: "confirm" | "submitting" | "error" }
  | { kind: "leave" | "delete-room"; state: "confirm" | "submitting" | "error" };

type InviteViewState =
  | { kind: "loading"; inviteCode: string }
  | { kind: "ready"; inviteCode: string; invite: InviteRoom }
  | { kind: "network-error"; inviteCode: string }
  | { kind: "invalid" | "started" | "full" | "kicked"; inviteCode: string };

function makeDefaultRoomName() {
  const now = new Date();
  const year = String(now.getFullYear()).slice(-2);
  return `${year}년 ${now.getMonth() + 1}월 ${now.getDate()}일 - 1명`;
}

type TransitionProps = {
  isLeaving: boolean;
  onTransitionEnd: (event: AnimationEvent<HTMLElement>) => void;
};

function HomeScreen({
  onCreateRoom,
  onOpenInformationSource,
  onOpenRoom,
  onOpenDecisionHistory,
  onHideCompletedRoom,
  rooms,
  loadState,
  onRetry,
  isLeaving,
  onTransitionEnd,
  previewAction,
}: {
  onCreateRoom: () => void;
  onOpenInformationSource: () => void;
  onOpenRoom: (room: RoomSummary) => void;
  onOpenDecisionHistory: (room: RoomSummary) => void;
  onHideCompletedRoom: (roomId: string) => void;
  rooms: RoomSummary[];
  loadState: "loading" | "ready" | "error";
  onRetry: () => void;
  previewAction?: "menu" | "delete-confirm" | "delete-deleting" | "delete-error" | "deleted";
} & TransitionProps) {
  const ongoingRooms = rooms.filter((item) => item.room.stage !== "completed");
  const completedRooms = rooms.filter((item) => item.room.stage === "completed");
  const firstCompletedRoom = completedRooms[0] ?? null;
  const [completedMenuRoomId, setCompletedMenuRoomId] = useState<string | null>(previewAction === "menu" ? firstCompletedRoom?.room.id ?? null : null);
  const [hideTarget, setHideTarget] = useState<RoomSummary | null>(previewAction?.startsWith("delete-") && previewAction !== "deleted" ? firstCompletedRoom : null);
  const [hideState, setHideState] = useState<"confirm" | "deleting" | "error">(
    previewAction === "delete-deleting" ? "deleting" : previewAction === "delete-error" ? "error" : "confirm",
  );
  const [isHideSheetDragging, setIsHideSheetDragging] = useState(false);
  const [isHideSheetClosing, setIsHideSheetClosing] = useState(false);
  const [hideSheetOffset, setHideSheetOffset] = useState(0);
  const [showHideSuccess, setShowHideSuccess] = useState(previewAction === "deleted");
  const hideDragStartY = useRef(0);
  const hideDragOffset = useRef(0);

  const closeHideSheet = useCallback(() => {
    if (hideState === "deleting") return;
    setIsHideSheetClosing(true);
    setHideSheetOffset(320);
  }, [hideState]);

  useEffect(() => {
    if (!hideTarget) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeHideSheet();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeHideSheet, hideTarget]);

  useEffect(() => {
    if (!showHideSuccess || previewAction === "deleted") return;
    const timeoutId = window.setTimeout(() => setShowHideSuccess(false), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [previewAction, showHideSuccess]);

  const openHideConfirm = (room: RoomSummary) => {
    setCompletedMenuRoomId(null);
    setHideTarget(room);
    setHideState("confirm");
    setIsHideSheetClosing(false);
    setHideSheetOffset(0);
  };

  const hideCompletedRoom = async () => {
    if (!hideTarget || hideState === "deleting") return;
    setHideState("deleting");
    try {
      const hiddenRoomId = await hideCompletedRoomFromHome(hideTarget.room.id);
      onHideCompletedRoom(hiddenRoomId);
      setShowHideSuccess(true);
      setIsHideSheetClosing(true);
      setHideSheetOffset(320);
    } catch (error) {
      console.error("Failed to hide completed room", error);
      setHideState("error");
    }
  };

  const handleHidePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button") || hideState === "deleting") return;
    hideDragStartY.current = event.clientY;
    hideDragOffset.current = 0;
    setIsHideSheetDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleHidePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isHideSheetDragging) return;
    const nextOffset = Math.max(0, event.clientY - hideDragStartY.current);
    hideDragOffset.current = nextOffset;
    setHideSheetOffset(nextOffset);
  };

  const finishHideDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isHideSheetDragging) return;
    setIsHideSheetDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (hideDragOffset.current >= 72) closeHideSheet();
    else {
      hideDragOffset.current = 0;
      setHideSheetOffset(0);
    }
  };

  return (
    <main
      className={`home-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}${hideTarget ? " home-screen--modal-open" : ""}`}
      aria-label="오늘 뭐 볼래 홈"
      onAnimationEnd={onTransitionEnd}
    >
      <header className="home-header">
        <div className="hero enter enter--hero">
          <h1>오늘 뭐 볼래?</h1>
          <p>우리끼리 후보를 모아 오늘 볼 한 편을 정해요.</p>
        </div>
        <button className="source-button" type="button" onClick={onOpenInformationSource}>
          <span className="source-button__surface">정보·출처</span>
        </button>
      </header>

      <div className="home-scroll-area">

        <section className="room-section enter enter--ongoing" aria-labelledby="ongoing-title">
          <div className="section-heading">
            <h2 id="ongoing-title">진행 중인 방</h2>
            <span aria-label={`진행 중인 방 ${ongoingRooms.length}개`}>{ongoingRooms.length}</span>
          </div>

          {loadState === "loading" && <div className="home-room-state">방 목록을 확인하고 있어요.</div>}
          {loadState === "error" && (
            <div className="home-room-state home-room-state--error">
              <p>방 목록을 불러오지 못했어요.</p>
              <button type="button" onClick={onRetry}>다시 시도</button>
            </div>
          )}
          {loadState === "ready" && ongoingRooms.length === 0 && (
            <div className="home-room-state">
              <strong>진행 중인 방이 없어요</strong>
              <p>선택방을 만들거나 초대 링크로 참여해 보세요.</p>
            </div>
          )}
          {ongoingRooms.map((item) => {
            const date = new Intl.DateTimeFormat("ko-KR", { year: "2-digit", month: "numeric", day: "numeric" })
              .format(new Date(item.room.created_at)).replace(/\. /g, ". ").replace(/\.$/, "");
            return (
              <button key={item.room.id} className="room-card ongoing-card" type="button" onClick={() => onOpenRoom(item)} aria-label={`${item.room.name} 방 열기`}>
                <span className="room-meta">
                  <span className="status-label">{item.progress.label}</span>
                  <span className="room-date">{date}</span>
                </span>
                <strong className="room-name">{item.room.name}</strong>
                <span className="room-summary">총 {item.members.length}명 · 후보 {item.candidateCount}편</span>
                <span
                  className="progress-track"
                  role="progressbar"
                  aria-label={`${item.progress.label}, ${item.progress.detail}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={item.progress.percent}
                >
                  <span className="progress-fill" style={{ "--room-progress": `${item.progress.percent}%` } as CSSProperties} />
                </span>
              </button>
            );
          })}
        </section>

        {loadState === "ready" && completedRooms.length > 0 && <section className={`room-section completed-section enter enter--completed${completedMenuRoomId ? " completed-section--menu-open" : ""}`} aria-labelledby="completed-title">
          <h2 id="completed-title">지난 결정</h2>

          <div className="completed-list">
            {completedRooms.map((item) => {
              const date = new Intl.DateTimeFormat("ko-KR", { year: "2-digit", month: "numeric", day: "numeric" })
                .format(new Date(item.room.created_at)).replace(/\. /g, ". ").replace(/\.$/, "");
              const posterUrl = item.finalCandidate?.posterPath
                ? `https://image.tmdb.org/t/p/w92${item.finalCandidate.posterPath}`
                : null;
              const title = item.finalCandidate?.title ?? "최종 작품";
              const isMenuOpen = completedMenuRoomId === item.room.id;
              return (
                <article key={item.room.id} className={`room-card completed-card${isMenuOpen ? " completed-card--menu-open" : ""}`}>
                  <span className={`completed-poster${posterUrl ? "" : " completed-poster--missing"}`} aria-hidden="true">
                    {posterUrl ? <img src={posterUrl} alt="" loading="lazy" /> : <span>포스터<br />없음</span>}
                  </span>
                  <button className="completed-info" type="button" onClick={() => onOpenRoom(item)} aria-label={`${item.room.name}, ${title} 결정 결과 열기`}>
                    <span className="final-label">최종 선택</span>
                    <strong>{title}</strong>
                    <span>{item.room.name} · {date}</span>
                  </button>
                  <button className="more-button" type="button" aria-label={`${item.room.name} 지난 결정 메뉴 열기`} aria-expanded={isMenuOpen} onClick={() => setCompletedMenuRoomId(isMenuOpen ? null : item.room.id)}>
                    <img src={`${import.meta.env.BASE_URL}icons/more.svg`} alt="" aria-hidden="true" />
                  </button>
                  {isMenuOpen && (
                    <div className="completed-room-menu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { setCompletedMenuRoomId(null); onOpenDecisionHistory(item); }}><span>전체 결정 과정 보기</span></button>
                      <button className="completed-room-menu__delete" type="button" role="menuitem" onClick={() => openHideConfirm(item)}><span>내 목록에서 삭제</span></button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>}
      </div>

      {completedMenuRoomId && <button className="completed-menu-dismiss" type="button" aria-label="지난 결정 메뉴 닫기" onClick={() => setCompletedMenuRoomId(null)} />}

      <nav className="bottom-actions" aria-label="홈 주요 메뉴">
        <button className="primary-button" type="button" onClick={onCreateRoom}>
          <span className="primary-button__surface">선택방 만들기</span>
        </button>
      </nav>

      {showHideSuccess && <div className="home-hide-success" role="status">지난 결정이 내 목록에서 삭제됐어요.</div>}

      {hideTarget && (
        <div className={`home-hide-layer${isHideSheetClosing ? " home-hide-layer--closing" : ""}`}>
          <button className="home-hide-scrim" type="button" aria-label="목록 삭제 닫기" onClick={closeHideSheet} disabled={hideState === "deleting"} />
          <section
            className={`home-hide-sheet home-hide-sheet--${hideState}${isHideSheetDragging ? " home-hide-sheet--dragging" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-busy={hideState === "deleting"}
            aria-labelledby="home-hide-title"
            style={{ "--home-hide-sheet-drag-y": `${hideSheetOffset}px` } as CSSProperties}
            onPointerDown={handleHidePointerDown}
            onPointerMove={handleHidePointerMove}
            onPointerUp={finishHideDrag}
            onPointerCancel={finishHideDrag}
            onTransitionEnd={(event) => {
              if (isHideSheetClosing && event.propertyName === "transform") {
                setHideTarget(null);
                setIsHideSheetClosing(false);
                setHideSheetOffset(0);
              }
            }}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <h2 id="home-hide-title">{hideState === "deleting" ? "목록에서 삭제하고 있어요" : hideState === "error" ? "목록에서 삭제하지 못했어요" : "이 결정을 목록에서 삭제할까요?"}</h2>
            <p>{hideState === "deleting" ? "잠시만 기다려 주세요." : hideState === "error" ? "인터넷 연결을 확인한 뒤 다시 시도해 주세요." : "내 홈에서만 사라지고 다른 참여자의 기록은 그대로 남아요."}</p>
            <button className="home-hide-confirm" type="button" onClick={hideCompletedRoom} disabled={hideState === "deleting"}><span>{hideState === "deleting" ? "삭제 중…" : hideState === "error" ? "다시 시도" : "내 목록에서 삭제"}</span></button>
            <button className="home-hide-cancel" type="button" onClick={closeHideSheet} disabled={hideState === "deleting"}><span>취소</span></button>
          </section>
        </div>
      )}
    </main>
  );
}

const TMDB_APPROVED_LOGO_URL = "https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_1-5bdc75aaebeb75dc7ae79426ddd9be3b2be1e342510f8202baf6bffa71d7f5c4.svg";

function InformationSourceScreen({ isLeaving, onTransitionEnd }: TransitionProps) {
  return (
    <main
      className={`information-source-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`}
      aria-label="정보와 출처"
      onAnimationEnd={onTransitionEnd}
    >
      <header className="content-header">
        <h1 className="header-title">정보·출처</h1>
      </header>

      <div className="information-source-scroll-area">
        <section className="source-standard-card" aria-labelledby="source-standard-title">
          <strong id="source-standard-title">정보 제공 기준</strong>
          <p>작품 정보는 TMDB, 시청 가능 서비스 정보는 JustWatch를 바탕으로 제공해요.</p>
        </section>

        <section className="source-provider-section" aria-labelledby="source-provider-title">
          <h2 id="source-provider-title">제공 정보</h2>

          <article className="source-provider-card source-provider-card--tmdb">
            <div className="source-provider-heading">
              <img src={TMDB_APPROVED_LOGO_URL} alt="TMDB" />
              <strong>TMDB</strong>
            </div>
            <p>작품 제목, 포스터, 공개 연도와 기본 정보를 제공해요.</p>
            <span>정보 확인일&nbsp;&nbsp;2026. 9. 18</span>
          </article>

          <article className="source-provider-card">
            <strong>JustWatch</strong>
            <p>한국에서 확인 가능한 구독·대여·구매 OTT 정보를 제공해요.</p>
            <span>정보 확인일&nbsp;&nbsp;2026. 9. 18</span>
          </article>
        </section>

        <section className="source-notice-card" aria-label="정보 정확도 안내">
          <p>제공 정보는 실제와 다르거나 늦게 반영될 수 있어요.</p>
        </section>

        <section className="source-usage-section" aria-labelledby="source-usage-title">
          <h2 id="source-usage-title">서비스 이용 안내</h2>
          <div className="source-usage-card">
            <p>로그인 없이 기기별 익명 식별값으로 참여 기록을 연결해요. 기기가 바뀌면 이전 기록을 이어 보지 못할 수 있어요.</p>
            <p>이 서비스는 광고·결제 없이 비상업적으로 운영해요.</p>
          </div>
        </section>

        <footer className="source-attribution">
          <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
          <p>OTT availability data provided by JustWatch.</p>
        </footer>
      </div>
    </main>
  );
}

function CreateRoomScreen({
  isLeaving,
  onTransitionEnd,
  onRoomCreated,
}: TransitionProps & { onRoomCreated: (session: RoomSession) => void }) {
  const initialRoomName = useMemo(makeDefaultRoomName, []);
  const [roomName, setRoomName] = useState(initialRoomName);
  const [nickname, setNickname] = useState("");
  const [editedRoomName, setEditedRoomName] = useState(false);
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const canSubmit = roomName.trim().length > 0 && nickname.length > 0 && submitState !== "submitting";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;

    const cleanRoomName = roomName.trim();
    setRoomName(cleanRoomName);
    setSubmitState("submitting");

    try {
      const room = await createRoom({
        name: cleanRoomName,
        nickname,
        isAutoName: !editedRoomName,
      });
      setSubmitState("success");
      onRoomCreated({
        room,
        nickname,
        userId: room.owner_id,
        members: [{ userId: room.owner_id, nickname, role: "host" }],
        candidateCount: 0,
        finalCandidate: null,
        progress: { percent: 11, label: "후보 모으는 중", detail: "후보를 모으는 단계" },
      });
    } catch (error) {
      console.error("Failed to create room", error);
      setSubmitState("error");
    }
  };

  return (
    <main
      className={`create-room-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`}
      aria-label="선택방 만들기"
      onAnimationEnd={onTransitionEnd}
    >
      <header className="content-header">
        <p className="header-title">선택방 만들기</p>
      </header>

      <form className="create-room-form" onSubmit={handleSubmit}>
        <div className="create-room-scroll-area">
          <section className="create-room-intro">
            <h1>함께 볼 작품을 정할<br />선택방을 만들어요</h1>
            <p>방 이름과 이 방에서 사용할 닉네임을 확인해 주세요.</p>
          </section>

          <div className="field-group">
            <label htmlFor="room-name">방 이름</label>
            <input
              id="room-name"
              className="text-field"
              value={roomName}
              maxLength={30}
              autoComplete="off"
              onChange={(event) => {
                setRoomName(event.target.value);
                setEditedRoomName(event.target.value !== initialRoomName);
                setSubmitState("idle");
              }}
              onBlur={() => setRoomName((value) => value.trim())}
            />
            <p>
              {editedRoomName
                ? "앞뒤 공백은 제거하고 최대 30자예요. 직접 수정하면 자동으로 바뀌지 않아요."
                : "참여자가 들어오면 인원 수가 자동으로 바뀌어요."}
            </p>
          </div>

          <div className="field-group nickname-group">
            <label htmlFor="nickname">닉네임</label>
            <input
              id="nickname"
              className="text-field"
              value={nickname}
              maxLength={6}
              autoComplete="off"
              enterKeyHint="done"
              onChange={(event) => {
                setNickname(event.target.value.replace(/\s/g, "").slice(0, 6));
                setSubmitState("idle");
              }}
            />
            <p>공백 없이 최대 6자예요. 이 방 안에서만 사용해요.</p>
          </div>
        </div>

        <div className="create-room-submit-area">
          <p className="submit-status" role="status" aria-live="polite">
            {submitState === "submitting" && "선택방을 만들고 있어요…"}
            {submitState === "success" && "선택방을 만들었어요."}
            {submitState === "error" && "방을 만들지 못했어요. 잠시 후 다시 시도해 주세요."}
          </p>
          <button className="create-room-button" type="submit" disabled={!canSubmit || submitState === "success"}>
            <span>{submitState === "submitting" ? "만드는 중…" : "선택방 만들기"}</span>
          </button>
        </div>
      </form>
    </main>
  );
}

function CandidateRoomScreen({
  session,
  candidates,
  isLeaving,
  onTransitionEnd,
  onOpenSearch,
  onOpenManual,
  onOpenRoomInfo,
  onCloseRoomInfo,
  onMemberKicked,
  onRoomLeft,
  onRoomDeleted,
  onCandidateDeleted,
  onEvaluationStarted,
  isRoomInfoOpen = false,
  initialMembershipAction = null,
}: TransitionProps & {
  session: RoomSession;
  candidates: Candidate[];
  onOpenSearch: () => void;
  onOpenManual: () => void;
  onOpenRoomInfo: () => void;
  onCloseRoomInfo: () => void;
  onMemberKicked: (result: RoomMembershipActionResult, userId: string) => void;
  onRoomLeft: () => void;
  onRoomDeleted: () => void;
  onCandidateDeleted: (candidateId: string) => void;
  onEvaluationStarted: (room: RoomSession["room"]) => void;
  isRoomInfoOpen?: boolean;
  initialMembershipAction?: MembershipAction | null;
}) {
  const [isAddMethodOpen, setIsAddMethodOpen] = useState(false);
  const [menuCandidateId, setMenuCandidateId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Candidate | null>(null);
  const [deleteState, setDeleteState] = useState<"confirm" | "deleting" | "error">("confirm");
  const [isDeleteSheetDragging, setIsDeleteSheetDragging] = useState(false);
  const [isDeleteSheetClosing, setIsDeleteSheetClosing] = useState(false);
  const [deleteSheetOffset, setDeleteSheetOffset] = useState(0);
  const [showDeleteSuccess, setShowDeleteSuccess] = useState(false);
  const [isRoomMenuOpen, setIsRoomMenuOpen] = useState(false);
  const [shareNotice, setShareNotice] = useState<"copied" | "shared" | "error" | null>(null);
  const [membershipAction, setMembershipAction] = useState<MembershipAction | null>(initialMembershipAction);
  const [isMembershipSheetDragging, setIsMembershipSheetDragging] = useState(false);
  const [isMembershipSheetClosing, setIsMembershipSheetClosing] = useState(false);
  const [membershipSheetOffset, setMembershipSheetOffset] = useState(0);
  const [isRoomInfoSheetDragging, setIsRoomInfoSheetDragging] = useState(false);
  const [isRoomInfoSheetClosing, setIsRoomInfoSheetClosing] = useState(false);
  const [roomInfoSheetOffset, setRoomInfoSheetOffset] = useState(0);
  const [kickSuccessNickname, setKickSuccessNickname] = useState<string | null>(null);
  const [startState, setStartState] = useState<"idle" | "starting" | "error">("idle");
  const [isSheetDragging, setIsSheetDragging] = useState(false);
  const [isSheetClosing, setIsSheetClosing] = useState(false);
  const [sheetDragOffset, setSheetDragOffset] = useState(0);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const dragStartY = useRef(0);
  const dragOffset = useRef(0);
  const deleteDragStartY = useRef(0);
  const deleteDragOffset = useRef(0);
  const membershipDragStartY = useRef(0);
  const membershipDragOffset = useRef(0);
  const roomInfoDragStartY = useRef(0);
  const roomInfoDragOffset = useRef(0);
  const isAdditionalCollection = session.room.stage === "adding_candidates";
  const activeCollectionRound = isAdditionalCollection ? 2 : 1;
  const myCandidateCount = candidates.filter(
    (candidate) => candidate.addedBy === session.userId && candidate.collectionRound === activeCollectionRound,
  ).length;
  const additionalCandidateCount = candidates.filter((candidate) => candidate.collectionRound === 2).length;
  const memberAdditionalCounts = session.members.map((member) => {
    const count = candidates.filter((candidate) => candidate.collectionRound === 2 && candidate.addedBy === member.userId).length;
    return `${member.nickname} ${count}/5`;
  }).join(" · ");
  const isHost = session.room.owner_id === session.userId;
  const canStart = isHost
    && session.members.length >= 2
    && (isAdditionalCollection ? additionalCandidateCount >= 1 : candidates.length >= 2);
  const startButtonLabel = !isHost
    ? "방장이 평가를 시작해요"
    : session.members.length < 2
      ? "2명부터 시작할 수 있어요"
      : candidates.length < 2
        ? "후보 2편부터 시작할 수 있어요"
        : startState === "starting"
          ? "평가 시작 중…"
          : startState === "error"
            ? "다시 시도"
            : "평가 시작하기";
  const additionalButtonLabel = !isHost
    ? "방장이 다음 평가를 준비해요"
    : additionalCandidateCount === 0
      ? "새 후보를 추가해 주세요"
      : startState === "starting"
        ? "평가 시작 중…"
          : startState === "error"
            ? "다시 시도"
            : "다음 평가 시작하기";
  const createdDate = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date(session.room.created_at)).replace(/\. /g, ". ").replace(/\.$/, "");

  const handleStartEvaluation = async () => {
    if (!canStart || startState === "starting") return;
    setStartState("starting");
    try {
      const room = isAdditionalCollection
        ? await startSecondEvaluation(session.room.id)
        : await startRoomEvaluation(session.room.id);
      onEvaluationStarted(room);
    } catch (error) {
      console.error("Failed to start evaluation", error);
      setStartState("error");
    }
  };

  const shareInvite = async () => {
    setIsRoomMenuOpen(false);
    try {
      const result = await copyRoomInviteLink(session.room.invite_code);
      setShareNotice(result);
    } catch (error) {
      console.error("Failed to share invite", error);
      setShareNotice("error");
    }
  };

  const confirmMembershipAction = async () => {
    if (!membershipAction || membershipAction.state === "submitting") return;
    setMembershipAction({ ...membershipAction, state: "submitting" });
    try {
      if (membershipAction.kind === "kick") {
        const result = await kickRoomMember(session.room.id, membershipAction.target.userId);
        setMembershipAction(null);
        setKickSuccessNickname(result.nickname);
        onMemberKicked(result, membershipAction.target.userId);
      } else if (membershipAction.kind === "leave") {
        await leaveRoom(session.room.id);
        setMembershipAction(null);
        onRoomLeft();
      } else {
        await deleteRoomByHost(session.room.id);
        setMembershipAction(null);
        onRoomDeleted();
      }
    } catch (error) {
      console.error(`Failed to ${membershipAction.kind}`, error);
      setMembershipAction({ ...membershipAction, state: "error" });
    }
  };

  const closeMembershipAction = useCallback(() => {
    if (membershipAction?.state === "submitting") return;
    setIsMembershipSheetClosing(true);
    setMembershipSheetOffset(360);
  }, [membershipAction?.state]);

  const openMembershipAction = (action: MembershipAction) => {
    membershipDragOffset.current = 0;
    setMembershipSheetOffset(0);
    setIsMembershipSheetClosing(false);
    setMembershipAction(action);
  };

  const closeRoomInfoSheet = useCallback(() => {
    setIsRoomInfoSheetClosing(true);
    setRoomInfoSheetOffset(600);
  }, []);


  const closeAddMethod = useCallback(() => {
    setIsSheetClosing(true);
    setSheetDragOffset(268);
  }, []);

  const closeDeleteSheet = useCallback(() => {
    if (deleteState === "deleting") return;
    setIsDeleteSheetClosing(true);
    setDeleteSheetOffset(300);
  }, [deleteState]);

  useEffect(() => {
    if (!isAddMethodOpen) return;
    searchButtonRef.current?.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAddMethod();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeAddMethod, isAddMethodOpen]);

  useEffect(() => {
    if (!deleteTarget) return;
    deleteButtonRef.current?.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDeleteSheet();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeDeleteSheet, deleteTarget]);

  useEffect(() => {
    if (!showDeleteSuccess) return;
    const timeoutId = window.setTimeout(() => setShowDeleteSuccess(false), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [showDeleteSuccess]);

  useEffect(() => {
    if (!shareNotice) return;
    const timeoutId = window.setTimeout(() => setShareNotice(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [shareNotice]);

  useEffect(() => {
    if (!kickSuccessNickname) return;
    const timeoutId = window.setTimeout(() => setKickSuccessNickname(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [kickSuccessNickname]);

  useEffect(() => {
    if (!membershipAction) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMembershipAction();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeMembershipAction, membershipAction]);

  useEffect(() => {
    if (!isRoomInfoOpen || membershipAction) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRoomInfoSheet();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeRoomInfoSheet, isRoomInfoOpen, membershipAction]);

  useEffect(() => {
    if (isRoomInfoOpen) return;
    setIsRoomInfoSheetClosing(false);
    setIsRoomInfoSheetDragging(false);
    setRoomInfoSheetOffset(0);
  }, [isRoomInfoOpen]);

  const handleSheetPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    dragStartY.current = event.clientY;
    dragOffset.current = 0;
    setIsSheetDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleSheetPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isSheetDragging) return;
    const nextOffset = Math.max(0, event.clientY - dragStartY.current);
    dragOffset.current = nextOffset;
    setSheetDragOffset(nextOffset);
  };

  const finishSheetDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isSheetDragging) return;
    setIsSheetDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (dragOffset.current >= 72) {
      closeAddMethod();
    } else {
      dragOffset.current = 0;
      setSheetDragOffset(0);
    }
  };

  const openAddMethod = () => {
    dragOffset.current = 0;
    setSheetDragOffset(0);
    setIsSheetClosing(false);
    setIsAddMethodOpen(true);
  };

  const openDeleteConfirm = (candidate: Candidate) => {
    setMenuCandidateId(null);
    setDeleteTarget(candidate);
    setDeleteState("confirm");
    setDeleteSheetOffset(0);
    setIsDeleteSheetClosing(false);
  };

  const handleDeletePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button") || deleteState === "deleting") return;
    deleteDragStartY.current = event.clientY;
    deleteDragOffset.current = 0;
    setIsDeleteSheetDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDeletePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isDeleteSheetDragging) return;
    const nextOffset = Math.max(0, event.clientY - deleteDragStartY.current);
    deleteDragOffset.current = nextOffset;
    setDeleteSheetOffset(nextOffset);
  };

  const finishDeleteDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isDeleteSheetDragging) return;
    setIsDeleteSheetDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (deleteDragOffset.current >= 72) {
      closeDeleteSheet();
    } else {
      deleteDragOffset.current = 0;
      setDeleteSheetOffset(0);
    }
  };

  const handleRoomInfoPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    roomInfoDragStartY.current = event.clientY;
    roomInfoDragOffset.current = 0;
    setIsRoomInfoSheetDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleRoomInfoPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isRoomInfoSheetDragging) return;
    const nextOffset = Math.max(0, event.clientY - roomInfoDragStartY.current);
    roomInfoDragOffset.current = nextOffset;
    setRoomInfoSheetOffset(nextOffset);
  };

  const finishRoomInfoDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isRoomInfoSheetDragging) return;
    setIsRoomInfoSheetDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (roomInfoDragOffset.current >= 72) {
      closeRoomInfoSheet();
    } else {
      roomInfoDragOffset.current = 0;
      setRoomInfoSheetOffset(0);
    }
  };

  const handleMembershipPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button") || membershipAction?.state === "submitting") return;
    membershipDragStartY.current = event.clientY;
    membershipDragOffset.current = 0;
    setIsMembershipSheetDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleMembershipPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isMembershipSheetDragging) return;
    const nextOffset = Math.max(0, event.clientY - membershipDragStartY.current);
    membershipDragOffset.current = nextOffset;
    setMembershipSheetOffset(nextOffset);
  };

  const finishMembershipDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isMembershipSheetDragging) return;
    setIsMembershipSheetDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (membershipDragOffset.current >= 72) {
      closeMembershipAction();
    } else {
      membershipDragOffset.current = 0;
      setMembershipSheetOffset(0);
    }
  };

  const confirmCandidateDelete = async () => {
    if (!deleteTarget || deleteState === "deleting") return;
    setDeleteState("deleting");

    try {
      const deletedId = await deleteCandidate(deleteTarget.id);
      onCandidateDeleted(deletedId);
      setShowDeleteSuccess(true);
      setIsDeleteSheetClosing(true);
      setDeleteSheetOffset(300);
    } catch (error) {
      console.error("Failed to delete candidate", error);
      setDeleteState("error");
    }
  };

  return (
    <main
      className={`candidate-room-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}${isAddMethodOpen || deleteTarget || isRoomInfoOpen || membershipAction ? " candidate-room-screen--modal-open" : ""}`}
      aria-label={`${session.room.name} 작품 후보 모으기`}
      onAnimationEnd={onTransitionEnd}
    >
      <header className="content-header candidate-room-header">
        <p className="header-title" title={session.room.name}>{session.room.name}</p>
        <button type="button" className="manage-room-button" aria-expanded={isRoomMenuOpen} onClick={() => setIsRoomMenuOpen((open) => !open)}>
          <span className="manage-room-button__surface">관리</span>
        </button>
        {isRoomMenuOpen && (
          <div className="room-overflow-menu">
            <button type="button" onClick={shareInvite}>초대 링크 공유</button>
            <button type="button" onClick={() => { setIsRoomMenuOpen(false); onOpenRoomInfo(); }}>방 정보·참여자</button>
            {!isHost && session.room.stage === "collecting" && (
              <button
                type="button"
                className="room-overflow-menu__danger"
                onClick={() => { setIsRoomMenuOpen(false); openMembershipAction({ kind: "leave", state: "confirm" }); }}
              >
                방 나가기
              </button>
            )}
            {isHost && (
              <button
                type="button"
                className="room-overflow-menu__danger"
                onClick={() => { setIsRoomMenuOpen(false); openMembershipAction({ kind: "delete-room", state: "confirm" }); }}
              >
                방 종료하기
              </button>
            )}
          </div>
        )}
      </header>

      <div className="candidate-room-scroll-area">
        <section className={`room-status-card${isAdditionalCollection ? " room-status-card--additional" : ""}`} aria-label="선택방 상태">
          <div>
            <strong>{isAdditionalCollection ? "새 후보가 필요해요" : "후보 모으는 중"}</strong>
            <span>{session.members.length} / 8명</span>
          </div>
          <p>{isAdditionalCollection ? "기존 후보와 평가는 그대로 유지돼요." : session.members.map((member) => `${member.nickname}${member.role === "host" ? "(방장)" : member.userId === session.userId ? "(나)" : ""}`).join(" · ")}</p>
          {isAdditionalCollection && <small>{memberAdditionalCounts}</small>}
        </section>

        <section className="candidate-section" aria-labelledby="candidate-title">
          <div className="candidate-heading">
            <h1 id="candidate-title">{isAdditionalCollection ? `전체 후보 · ${candidates.length}편` : "작품 후보"}</h1>
            <span>내 {isAdditionalCollection ? "추가 후보" : "작품"} {myCandidateCount} / 5</span>
          </div>

          {candidates.length === 0 ? (
            <div className="empty-candidate-card">
              <strong>아직 등록된 작품이 없어요</strong>
              <p>보고 싶은 작품을 먼저 추가해 주세요.</p>
            </div>
          ) : (
            <div className="candidate-list">
              {candidates.map((candidate) => {
                const posterUrl = candidate.posterPath
                  ? `https://image.tmdb.org/t/p/w92${candidate.posterPath}`
                  : null;
                const year = candidate.releaseDate?.slice(0, 4);
                const kind = candidate.source === "manual"
                  ? "직접 입력"
                  : candidate.mediaType === "movie"
                    ? "영화"
                    : "TV 프로그램";

                return (
                  <article className={`candidate-card${menuCandidateId === candidate.id ? " candidate-card--menu-open" : ""}`} key={candidate.id}>
                    <div className={`candidate-poster${posterUrl ? "" : " candidate-poster--missing"}${candidate.source === "manual" ? " candidate-poster--manual" : ""}`}>
                      {posterUrl && <img src={posterUrl} alt="" loading="lazy" />}
                      {candidate.source === "manual" && <span>직접<br />입력</span>}
                    </div>
                    <div className="candidate-info">
                      <strong title={candidate.title}>{candidate.title}</strong>
                      <span>{[kind, year, candidate.addedByNickname].filter(Boolean).join(" · ")}</span>
                    </div>
                    {candidate.addedBy === session.userId && candidate.collectionRound === activeCollectionRound && (
                      <button
                        type="button"
                        className="candidate-more-button"
                        aria-label={`${candidate.title} 메뉴 열기`}
                        onClick={() => setMenuCandidateId((current) => current === candidate.id ? null : candidate.id)}
                      >
                        •••
                      </button>
                    )}
                    {menuCandidateId === candidate.id && (
                      <>
                        <button
                          type="button"
                          className="candidate-menu-dismiss"
                          aria-label="후보 메뉴 닫기"
                          onClick={() => setMenuCandidateId(null)}
                        />
                        <div className="candidate-menu" role="menu">
                          <button type="button" role="menuitem" onClick={() => openDeleteConfirm(candidate)}>
                            내 후보에서 삭제
                          </button>
                        </div>
                      </>
                    )}
                  </article>
                );
              })}
            </div>
          )}

          <button
            type="button"
            className="add-candidate-button"
            onClick={openAddMethod}
            disabled={myCandidateCount >= 5 || startState === "starting"}
          >
            <span aria-hidden="true">＋</span>
            {myCandidateCount >= 5 ? "후보를 5편 추가했어요" : isAdditionalCollection ? "새 작품 추가하기" : "작품 추가하기"}
          </button>

          {startState === "error" && (
            <div className="evaluation-start-error" role="alert">
              <strong>문제가 생겼어요</strong>
              <h2>평가를 시작하지 못했어요</h2>
              <p>참여자와 후보는 그대로예요. 다시 시도해 주세요.</p>
            </div>
          )}
        </section>
      </div>

      <div className="candidate-room-submit-area">
        <button
          type="button"
          className="candidate-start-button"
          disabled={!canStart || startState === "starting"}
          onClick={handleStartEvaluation}
          aria-busy={startState === "starting"}
        >
          <span>{isAdditionalCollection ? additionalButtonLabel : startButtonLabel}</span>
        </button>
      </div>

      {showDeleteSuccess && (
        <div className="candidate-delete-success" role="status" aria-live="polite">
          후보가 목록에서 삭제됐어요.
        </div>
      )}

      {kickSuccessNickname && (
        <div className="candidate-delete-success" role="status" aria-live="polite">
          {kickSuccessNickname}님을 내보냈어요.
        </div>
      )}

      {shareNotice && (
        <div className={`invite-share-notice${shareNotice === "error" ? " invite-share-notice--error" : ""}`} role="status" aria-live="polite">
          {shareNotice === "copied" && "초대 링크가 복사되었어요."}
          {shareNotice === "shared" && "공유 화면을 열었어요."}
          {shareNotice === "error" && "초대 링크를 공유하지 못했어요."}
        </div>
      )}

      {isAddMethodOpen && (
        <div className={`add-method-layer${isSheetClosing ? " add-method-layer--closing" : ""}`}>
          <button
            type="button"
            className="add-method-scrim"
            aria-label="작품 추가 방법 닫기"
            onClick={closeAddMethod}
          />
          <section
            className={`add-method-sheet${isSheetDragging ? " add-method-sheet--dragging" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-method-title"
            style={{ "--sheet-drag-y": `${sheetDragOffset}px` } as CSSProperties}
            onPointerDown={handleSheetPointerDown}
            onPointerMove={handleSheetPointerMove}
            onPointerUp={finishSheetDrag}
            onPointerCancel={finishSheetDrag}
            onTransitionEnd={(event) => {
              if (isSheetClosing && event.propertyName === "transform") {
                setIsAddMethodOpen(false);
                setIsSheetClosing(false);
                setSheetDragOffset(0);
              }
            }}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <h2 id="add-method-title">작품을 어떻게 추가할까요?</h2>
            <p>검색 결과에 없다면 직접 입력할 수 있어요.</p>
            <button ref={searchButtonRef} type="button" className="method-button" onClick={onOpenSearch}>
              작품 검색하기
            </button>
            <button type="button" className="method-button" onClick={onOpenManual}>직접 입력하기</button>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className={`candidate-delete-layer${isDeleteSheetClosing ? " candidate-delete-layer--closing" : ""}`}>
          <button
            type="button"
            className="candidate-delete-scrim"
            aria-label="후보 삭제 닫기"
            onClick={closeDeleteSheet}
            disabled={deleteState === "deleting"}
          />
          <section
            className={`candidate-delete-sheet${deleteState === "error" ? " candidate-delete-sheet--error" : ""}${isDeleteSheetDragging ? " candidate-delete-sheet--dragging" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="candidate-delete-title"
            aria-busy={deleteState === "deleting"}
            style={{ "--delete-sheet-drag-y": `${deleteSheetOffset}px` } as CSSProperties}
            onPointerDown={handleDeletePointerDown}
            onPointerMove={handleDeletePointerMove}
            onPointerUp={finishDeleteDrag}
            onPointerCancel={finishDeleteDrag}
            onTransitionEnd={(event) => {
              if (isDeleteSheetClosing && event.propertyName === "transform") {
                setDeleteTarget(null);
                setDeleteState("confirm");
                setIsDeleteSheetClosing(false);
                setDeleteSheetOffset(0);
              }
            }}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <h2 id="candidate-delete-title">
              {deleteState === "error" ? "후보를 삭제하지 못했어요" : "이 후보를 삭제할까요?"}
            </h2>
            <p>
              {deleteState === "error"
                ? "후보는 목록에 그대로 남아 있어요."
                : "내가 추가한 후보만 평가 시작 전에 삭제할 수 있어요."}
            </p>
            {deleteState === "error" && (
              <div className="candidate-delete-error" role="alert">잠시 후 다시 시도해주세요.</div>
            )}
            <button
              ref={deleteButtonRef}
              type="button"
              className="candidate-delete-button"
              disabled={deleteState === "deleting"}
              onClick={confirmCandidateDelete}
            >
              <span>삭제하기</span>
            </button>
          </section>
        </div>
      )}

      {isRoomInfoOpen && !membershipAction && (
        <div className={`room-info-layer${isRoomInfoSheetClosing ? " room-info-layer--closing" : ""}`}>
          <button
            type="button"
            className="room-info-scrim"
            aria-label="방 정보·참여자 닫기"
            onClick={closeRoomInfoSheet}
          />
          <section
            className={`room-info-sheet${isRoomInfoSheetDragging ? " room-info-sheet--dragging" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="room-info-title"
            style={{
              "--room-info-sheet-height": `${Math.min(488, 304 + session.members.length * 64)}px`,
              "--room-info-sheet-drag-y": `${roomInfoSheetOffset}px`,
            } as CSSProperties}
            onTransitionEnd={(event) => {
              if (event.currentTarget === event.target && isRoomInfoSheetClosing && event.propertyName === "transform") {
                onCloseRoomInfo();
              }
            }}
          >
            <div
              className="room-info-sheet__drag-zone"
              onPointerDown={handleRoomInfoPointerDown}
              onPointerMove={handleRoomInfoPointerMove}
              onPointerUp={finishRoomInfoDrag}
              onPointerCancel={finishRoomInfoDrag}
            >
              <div className="sheet-handle" aria-hidden="true" />
            </div>
            <div className="room-info-sheet__body">
              <h2 id="room-info-title">방 정보·참여자</h2>
              <section className="room-info-card" aria-label="방 정보">
                <strong title={session.room.name}>{session.room.name}</strong>
                <span>만든 날 {createdDate}</span>
              </section>
              <h3>참여자 {session.members.length} / 8명</h3>
              <div className="room-info-participant-list">
                {session.members.map((member) => {
                  const isMemberHost = member.role === "host";
                  const isMe = member.userId === session.userId;
                  return (
                    <div className="room-info-participant" key={member.userId}>
                      <span title={member.nickname}>{member.nickname}</span>
                      {isMemberHost ? (
                        <strong>방장</strong>
                      ) : isHost && session.room.stage === "collecting" ? (
                        <button
                          type="button"
                          className="room-info-kick-button"
                          onClick={() => openMembershipAction({ kind: "kick", target: member, state: "confirm" })}
                        >
                          내보내기
                        </button>
                      ) : isMe ? (
                        <strong className="room-info-me">나</strong>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="room-info-sheet__action">
              <button type="button" onClick={shareInvite}>
                <span>초대 링크 공유</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {membershipAction && (
        <div className={`membership-action-layer${isMembershipSheetClosing ? " membership-action-layer--closing" : ""}`}>
          <button
            type="button"
            className="membership-action-scrim"
            aria-label={membershipAction.kind === "kick" ? "참여자 내보내기 닫기" : membershipAction.kind === "leave" ? "방 나가기 닫기" : "방 종료하기 닫기"}
            onClick={closeMembershipAction}
            disabled={membershipAction.state === "submitting"}
          />
          <section
            className={`membership-action-sheet membership-action-sheet--${membershipAction.kind} membership-action-sheet--${membershipAction.state}${isMembershipSheetDragging ? " membership-action-sheet--dragging" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="membership-action-title"
            aria-busy={membershipAction.state === "submitting"}
            style={{ "--membership-sheet-drag-y": `${membershipSheetOffset}px` } as CSSProperties}
            onPointerDown={handleMembershipPointerDown}
            onPointerMove={handleMembershipPointerMove}
            onPointerUp={finishMembershipDrag}
            onPointerCancel={finishMembershipDrag}
            onTransitionEnd={(event) => {
              if (event.currentTarget === event.target && isMembershipSheetClosing && event.propertyName === "transform") {
                setMembershipAction(null);
                setIsMembershipSheetClosing(false);
                setMembershipSheetOffset(0);
              }
            }}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <h2 id="membership-action-title">
              {membershipAction.state === "submitting"
                ? membershipAction.kind === "kick" ? "참여자를 내보내는 중…" : membershipAction.kind === "leave" ? "방에서 나가는 중…" : "방을 종료하는 중…"
                : membershipAction.state === "error"
                  ? membershipAction.kind === "kick" ? "참여자를 내보내지 못했어요" : membershipAction.kind === "leave" ? "방에서 나가지 못했어요" : "방을 종료하지 못했어요"
                  : membershipAction.kind === "kick" ? `${membershipAction.target.nickname}님을 내보낼까요?` : membershipAction.kind === "leave" ? "이 방에서 나갈까요?" : "이 방을 종료할까요?"}
            </h2>
            {membershipAction.state === "error" ? (
              <div className="membership-action-error" role="alert">잠시 후 다시 시도해주세요.</div>
            ) : (
              <p>
                {membershipAction.state === "submitting"
                  ? "잠시만 기다려주세요."
                  : membershipAction.kind === "kick"
                    ? "내보내면 다시 참여할 수 없어요."
                    : membershipAction.kind === "leave"
                      ? <>나가면 홈에서 이 방을 볼 수 없어요.<br />평가 시작 전에는 초대 링크로 다시 들어올 수 있어요.</>
                      : <>모든 참여자의 후보·평가·결정 기록이 영구 삭제돼요.<br />삭제한 방은 복구할 수 없어요.</>}
              </p>
            )}
            {membershipAction.state !== "submitting" && (
              <button type="button" className="membership-action-cancel" onClick={closeMembershipAction}>
                <span>취소</span>
              </button>
            )}
            <button
              type="button"
              className="membership-action-confirm"
              disabled={membershipAction.state === "submitting"}
              onClick={() => void confirmMembershipAction()}
            >
              <span>
                {membershipAction.state === "submitting"
                  ? membershipAction.kind === "kick" ? "내보내는 중…" : membershipAction.kind === "leave" ? "나가는 중…" : "종료하는 중…"
                  : membershipAction.state === "error"
                    ? "다시 시도"
                    : membershipAction.kind === "kick" ? "내보내기" : membershipAction.kind === "leave" ? "방 나가기" : "방 종료하기"}
              </span>
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

function HostRoomTerminationControl({
  session,
  onRoomDeleted,
  includeRoomInfo = false,
  position = "standard",
}: {
  session: RoomSession;
  onRoomDeleted: () => void;
  includeRoomInfo?: boolean;
  position?: "standard" | "evaluation" | "header";
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showRoomInfo, setShowRoomInfo] = useState(false);
  const [state, setState] = useState<"confirm" | "submitting" | "error" | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [offset, setOffset] = useState(0);
  const dragStartY = useRef(0);
  const dragOffset = useRef(0);

  const close = useCallback(() => {
    if (state === "submitting") return;
    setIsClosing(true);
    setOffset(360);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close, state]);

  const isHost = session.room.owner_id === session.userId;
  if (!isHost && !includeRoomInfo) return null;

  const open = () => {
    setIsMenuOpen(false);
    setIsClosing(false);
    setOffset(0);
    setState("confirm");
  };

  const submit = async () => {
    if (state === "submitting") return;
    setState("submitting");
    try {
      await deleteRoomByHost(session.room.id);
      setState(null);
      onRoomDeleted();
    } catch (error) {
      console.error("Failed to delete room", error);
      setState("error");
    }
  };

  const pointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button") || state === "submitting") return;
    dragStartY.current = event.clientY;
    dragOffset.current = 0;
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isDragging) return;
    const nextOffset = Math.max(0, event.clientY - dragStartY.current);
    dragOffset.current = nextOffset;
    setOffset(nextOffset);
  };
  const pointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isDragging) return;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (dragOffset.current >= 72) close();
    else setOffset(0);
  };

  return (
    <>
      <div className={`host-room-termination-control host-room-termination-control--${position}`}>
        <button type="button" className="manage-room-button" aria-expanded={isMenuOpen} onClick={() => setIsMenuOpen((openMenu) => !openMenu)}>
          <span className="manage-room-button__surface">관리</span>
        </button>
        {isMenuOpen && (
          <div className="room-overflow-menu">
            {includeRoomInfo && <button type="button" onClick={() => { setIsMenuOpen(false); setShowRoomInfo((visible) => !visible); }}>방 정보·참여자</button>}
            {isHost && <button type="button" className="room-overflow-menu__danger" onClick={open}>방 종료하기</button>}
          </div>
        )}
        {showRoomInfo && (
          <section className="final-room-info" aria-label="방 정보">
            <strong>{session.room.name}</strong>
            <span>{session.members.map((member) => member.nickname).join(" · ")}</span>
          </section>
        )}
      </div>
      {state && (
        <div className={`membership-action-layer${isClosing ? " membership-action-layer--closing" : ""}`}>
          <button type="button" className="membership-action-scrim" aria-label="방 종료하기 닫기" onClick={close} disabled={state === "submitting"} />
          <section
            className={`membership-action-sheet membership-action-sheet--delete-room membership-action-sheet--${state}${isDragging ? " membership-action-sheet--dragging" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="host-room-delete-title"
            aria-busy={state === "submitting"}
            style={{ "--membership-sheet-drag-y": `${offset}px` } as CSSProperties}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerEnd}
            onPointerCancel={pointerEnd}
            onTransitionEnd={(event) => {
              if (event.currentTarget === event.target && isClosing && event.propertyName === "transform") {
                setState(null);
                setIsClosing(false);
                setOffset(0);
              }
            }}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <h2 id="host-room-delete-title">{state === "submitting" ? "방을 종료하는 중…" : state === "error" ? "방을 종료하지 못했어요" : "이 방을 종료할까요?"}</h2>
            {state === "error" ? <div className="membership-action-error" role="alert">잠시 후 다시 시도해주세요.</div> : <p>{state === "submitting" ? "잠시만 기다려주세요." : <>모든 참여자의 후보·평가·결정 기록이 영구 삭제돼요.<br />삭제한 방은 복구할 수 없어요.</>}</p>}
            {state !== "submitting" && <button type="button" className="membership-action-cancel" onClick={close}><span>취소</span></button>}
            <button type="button" className="membership-action-confirm" disabled={state === "submitting"} onClick={() => void submit()}><span>{state === "submitting" ? "종료하는 중…" : state === "error" ? "다시 시도" : "방 종료하기"}</span></button>
          </section>
        </div>
      )}
    </>
  );
}

function EvaluationScreen({
  session,
  candidates,
  isLeaving,
  onTransitionEnd,
  onRoomAdvanced,
  onOpenRevoteSetup,
}: TransitionProps & {
  session: RoomSession;
  candidates: Candidate[];
  onRoomAdvanced: (room: RoomSession["room"]) => void;
  onOpenRevoteSetup: (result: EvaluationResult) => void;
}) {
  const evaluationRound = session.room.evaluation_round ?? 1;
  const draftKey = `watch-tonight:evaluation-draft:${session.room.id}:${session.userId}:${evaluationRound}`;
  const scrollKey = `${draftKey}:scroll`;
  const [choices, setChoices] = useState<Record<string, EvaluationChoice>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem(draftKey) ?? "{}") as Record<string, EvaluationChoice>;
    } catch {
      return {};
    }
  });
  const [statuses, setStatuses] = useState<EvaluationStatus[]>([]);
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [mode, setMode] = useState<"editing" | "completed">("editing");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [requestState, setRequestState] = useState<"idle" | "saving" | "save-error" | "reopening" | "reopen-error" | "deciding" | "decide-error" | "advancing" | "advance-error">("idle");
  const [isRevision, setIsRevision] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const evaluationScrollRef = useRef<HTMLDivElement>(null);
  const completedCount = Object.keys(choices).length;
  const remainingCount = Math.max(0, candidates.length - completedCount);
  const allRated = candidates.length >= 2 && completedCount === candidates.length;
  const isHost = session.members.some((member) => member.userId === session.userId && member.role === "host");
  const allParticipantsCompleted = session.members.length >= 2
    && session.members.every((member) => statuses.some((status) => status.userId === member.userId && status.status === "completed"));

  useEffect(() => {
    let active = true;
    setLoadState("loading");
    void loadEvaluationState(session.room.id, evaluationRound)
      .then((result) => {
        if (!active) return;
        const validCandidateIds = new Set(candidates.map((candidate) => candidate.id));
        const savedChoices = Object.fromEntries(
          Object.entries(result.choices).filter(([candidateId]) => validCandidateIds.has(candidateId)),
        ) as Record<string, EvaluationChoice>;
        setChoices((current) => Object.keys(savedChoices).length > 0
          ? savedChoices
          : Object.fromEntries(Object.entries(current).filter(([candidateId]) => validCandidateIds.has(candidateId))));
        setStatuses(result.statuses);
        setResult(result.result);
        const myStatus = result.statuses.find((status) => status.userId === session.userId)?.status;
        setMode(result.result || myStatus === "completed" ? "completed" : "editing");
        setIsRevision(myStatus === "in_progress" && Object.keys(savedChoices).length > 0);
        setLoadState("ready");
        window.requestAnimationFrame(() => {
          if (evaluationScrollRef.current) {
            evaluationScrollRef.current.scrollTop = Number(window.localStorage.getItem(scrollKey) ?? 0);
          }
        });
      })
      .catch((error) => {
        console.error("Failed to load evaluation", error);
        if (active) setLoadState("error");
      });
    return () => { active = false; };
  }, [candidates, evaluationRound, reloadVersion, scrollKey, session.room.id, session.userId]);

  useEffect(() => {
    const channel = supabase
      .channel(`evaluation-statuses-${session.room.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "evaluation_statuses", filter: `room_id=eq.${session.room.id}` },
        () => {
          void loadEvaluationStatuses(session.room.id, evaluationRound)
            .then((nextStatuses) => {
              setStatuses(nextStatuses);
              const myStatus = nextStatuses.find((status) => status.userId === session.userId)?.status;
              if (myStatus === "completed") setMode("completed");
            })
            .catch((error) => console.error("Failed to refresh evaluation statuses", error));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [evaluationRound, session.room.id, session.userId]);

  useEffect(() => {
    const channel = supabase
      .channel(`evaluation-result-${session.room.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "evaluation_results", filter: `room_id=eq.${session.room.id}` },
        () => {
          void loadEvaluationResult(session.room.id, evaluationRound)
            .then((nextResult) => {
              if (nextResult) {
                setResult(nextResult);
                setMode("completed");
              }
            })
            .catch((error) => console.error("Failed to refresh evaluation result", error));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [evaluationRound, session.room.id]);

  const chooseRating = (candidateId: string, value: EvaluationChoice) => {
    if (requestState === "saving" || loadState === "loading") return;
    setChoices((current) => {
      const next = { ...current, [candidateId]: value };
      window.localStorage.setItem(draftKey, JSON.stringify(next));
      return next;
    });
    if (requestState === "save-error") setRequestState("idle");
  };

  const completeEvaluation = async () => {
    if (!allRated || requestState === "saving") return;
    setRequestState("saving");
    try {
      await saveRoomEvaluation(session.room.id, evaluationRound, choices);
      window.localStorage.removeItem(draftKey);
      window.localStorage.removeItem(scrollKey);
      setStatuses((current) => [
        ...current.filter((status) => status.userId !== session.userId),
        { userId: session.userId, status: "completed" },
      ]);
      setMode("completed");
      setShowSuccess(true);
      setRequestState("idle");
    } catch (error) {
      console.error("Failed to save evaluation", error);
      setRequestState("save-error");
    }
  };

  const reopenEvaluation = async () => {
    if (requestState === "reopening") return;
    setRequestState("reopening");
    try {
      await reopenRoomEvaluation(session.room.id, evaluationRound);
      window.localStorage.setItem(draftKey, JSON.stringify(choices));
      setStatuses((current) => [
        ...current.filter((status) => status.userId !== session.userId),
        { userId: session.userId, status: "in_progress" },
      ]);
      setMode("editing");
      setIsRevision(true);
      setShowSuccess(false);
      setRequestState("idle");
    } catch (error) {
      console.error("Failed to reopen evaluation", error);
      setRequestState("reopen-error");
    }
  };

  const decideEvaluation = async () => {
    if (!isHost || !allParticipantsCompleted || requestState === "deciding") return;
    setRequestState("deciding");
    try {
      setResult(evaluationRound === 2
        ? await decideSecondEvaluation(session.room.id)
        : await decideFirstEvaluation(session.room.id));
      setShowSuccess(false);
      setRequestState("idle");
    } catch (error) {
      console.error("Failed to decide evaluation", error);
      setRequestState("decide-error");
    }
  };

  const advanceResult = async () => {
    if (!result || !isHost || requestState === "advancing") return;
    if (result.outcome === "revote") {
      onOpenRevoteSetup(result);
      return;
    }
    setRequestState("advancing");
    try {
      onRoomAdvanced(evaluationRound === 2
        ? await advanceSecondEvaluation(session.room.id)
        : await advanceFirstEvaluation(session.room.id));
      setRequestState("idle");
    } catch (error) {
      console.error("Failed to advance evaluation result", error);
      setRequestState("advance-error");
    }
  };

  if (result) {
    const advancing = new Set(result.advancingCandidateIds);
    const sortedResults = [...result.candidates].sort((a, b) => Number(advancing.has(b.candidateId)) - Number(advancing.has(a.candidateId)));
    const resultCopy = result.outcome === "winner"
      ? {
          label: "선택 완료",
          title: "오늘 볼 작품이 정해졌어요",
          description: "싫어요가 없는 작품 중 보고 싶어요가 가장 많은 작품이에요.",
          notice: "단독 1위라 오늘의 작품으로 확정됐어요.",
        }
      : result.outcome === "revote"
        ? {
            label: "공동 1위",
            title: "한 번 더 골라볼까요?",
            description: `싫어요가 없는 작품 중 보고 싶어요가 가장 많은 ${result.advancingCandidateIds.length}개 작품이 남았어요.`,
            notice: isHost ? "다음 단계에서 재투표에 올릴 작품 수를 정해요." : "방장이 재투표를 준비하고 있어요.",
          }
        : {
            label: "추가 후보",
            title: "괜찮은 작품이 없어요",
            description: "모든 작품에 싫어요가 있어 새 작품을 한 번 더 받을게요.",
            notice: isHost ? "다음 단계에서 추가 후보 수집을 열 수 있어요." : "방장이 새 작품 추가를 준비하고 있어요.",
          };

    const names = (values: string[]) => values.length > 0 ? values.join(", ") : "없음";

    return (
      <main
        className={`evaluation-result-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`}
        aria-label="1차 평가 결과"
        onAnimationEnd={onTransitionEnd}
      >
        <header className="evaluation-complete-header"><h1>1차 평가 결과</h1></header>
        <div className={`evaluation-result-scroll-area${isHost ? " evaluation-result-scroll-area--with-action" : ""}`}>
          <section className="evaluation-result-banner">
            <span>{resultCopy.label}</span>
            <h2>{resultCopy.title}</h2>
            <p>{resultCopy.description}</p>
          </section>
          <section className="evaluation-result-list" aria-label="후보별 평가 결과">
            {sortedResults.map((candidateResult) => {
              const candidate = candidates.find((item) => item.id === candidateResult.candidateId);
              if (!candidate) return null;
              const posterUrl = candidate.posterPath ? `https://image.tmdb.org/t/p/w154${candidate.posterPath}` : null;
              const isAdvanced = advancing.has(candidate.id);
              const kind = candidate.source === "manual" ? "직접 입력" : candidate.mediaType === "movie" ? "영화" : "TV 프로그램";
              const year = candidate.releaseDate?.slice(0, 4);
              return (
                <article className={`evaluation-result-card${isAdvanced ? " evaluation-result-card--advanced" : ""}`} key={candidate.id}>
                  <div className="evaluation-result-work">
                    <div className={`evaluation-result-poster${posterUrl ? "" : " evaluation-result-poster--missing"}`}>
                      {posterUrl ? <img src={posterUrl} alt="" /> : <span>포스터 없음</span>}
                    </div>
                    <div>
                      <strong>{candidate.title}</strong>
                      <span>{[kind, year].filter(Boolean).join(" · ")}</span>
                    </div>
                  </div>
                  <div className="evaluation-result-names">
                    <span>보고 싶어요: {names(candidateResult.wantNicknames)}</span>
                    <span>괜찮아요: {names(candidateResult.okayNicknames)} · 싫어요: {names(candidateResult.dislikeNicknames)}</span>
                  </div>
                </article>
              );
            })}
          </section>
          <p className="evaluation-result-notice">{resultCopy.notice}</p>
          {requestState === "advance-error" && (
            <div className="evaluation-complete-error" role="alert">다음 단계로 이동하지 못했어요. 결과는 그대로 유지됐어요.</div>
          )}
        </div>
        {isHost && (
          <div className="evaluation-result-actions">
            <button type="button" onClick={advanceResult} disabled={requestState === "advancing"} aria-busy={requestState === "advancing"}>
              <span>{requestState === "advancing"
                ? "처리 중…"
                : result.outcome === "winner"
                  ? "오늘의 작품 보기"
                  : result.outcome === "revote"
                    ? "재투표 설정하기"
                    : "후보 추가 열기"}</span>
            </button>
          </div>
        )}
      </main>
    );
  }

  if (mode === "completed") {
    return (
      <main
        className={`evaluation-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`}
        aria-label="1차 평가 완료"
        onAnimationEnd={onTransitionEnd}
      >
        <header className="evaluation-complete-header"><h1>1차 평가</h1></header>
        <div className="evaluation-complete-content">
          {showSuccess && <div className="evaluation-success" role="status">내 평가를 완료했어요.</div>}
          <section className="evaluation-participants" aria-label="참여자 평가 상태">
            {session.members.map((member) => {
              const status = statuses.find((item) => item.userId === member.userId)?.status ?? "in_progress";
              return (
                <div className="evaluation-participant" key={member.userId}>
                  <span className="evaluation-avatar" aria-hidden="true">{member.nickname.slice(0, 1)}</span>
                  <strong>{member.userId === session.userId ? `나 · ${member.nickname}` : member.nickname}</strong>
                  <span className={`evaluation-status-pill evaluation-status-pill--${status}`}>
                    {status === "completed" ? "평가 완료" : "평가 중"}
                  </span>
                </div>
              );
            })}
          </section>
          {isHost && (
            <section className="evaluation-decision-card">
              <span>{allParticipantsCompleted ? "결정할 준비가 됐어요" : "방장만 결정할 수 있어요"}</span>
              <h2>{allParticipantsCompleted ? "모든 참여자가 평가를 마쳤어요" : "아직 평가 중인 참여자가 있어요"}</h2>
              <p>{allParticipantsCompleted ? "이제 평가 결과를 공개하고 최종 작품을 결정해요." : "전원이 완료하면 결정 버튼이 열려요."}</p>
            </section>
          )}
          {requestState === "reopen-error" && (
            <div className="evaluation-complete-error" role="alert">평가 수정을 시작하지 못했어요. 다시 시도해 주세요.</div>
          )}
          {requestState === "decide-error" && (
            <div className="evaluation-complete-error" role="alert">결과를 결정하지 못했어요. 참여자 상태를 확인한 뒤 다시 시도해 주세요.</div>
          )}
        </div>
        <div className="evaluation-complete-actions">
          {isHost ? (
            <button type="button" onClick={decideEvaluation} disabled={!allParticipantsCompleted || requestState === "deciding"} aria-busy={requestState === "deciding"}>
              <span>{requestState === "deciding" ? "결과 결정 중…" : allParticipantsCompleted ? "최종 작품 결정" : "모두의 평가를 기다리는 중"}</span>
            </button>
          ) : (
            <button type="button" onClick={reopenEvaluation} disabled={requestState === "reopening"}>
              <span>{requestState === "reopening" ? "수정 시작 중…" : "평가 수정"}</span>
            </button>
          )}
        </div>
      </main>
    );
  }

  const privacyMessage = requestState === "saving"
    ? "평가를 안전하게 저장하고 있어요"
    : requestState === "save-error"
      ? "선택 내용은 유지됐어요 · 다시 저장해 주세요"
      : isRevision
        ? "수정을 시작해 내 상태가 다시 평가 중이에요"
        : completedCount === 0
          ? "싫어요는 함께 볼 수 없다는 강한 거절이에요"
          : remainingCount === 0
            ? "모든 작품을 평가했어요 · 완료할 수 있어요"
            : `${remainingCount}개 남았어요 · 선택은 결정 전까지 비공개예요`;

  return (
    <main
      className={`evaluation-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`}
      aria-label="1차 평가"
      onAnimationEnd={onTransitionEnd}
    >
      <header className="evaluation-header">
        <div className="evaluation-title-row">
          <h1>1차 평가</h1>
          <span aria-label={`${candidates.length}편 중 ${completedCount}편 평가`}>{completedCount} / {candidates.length}</span>
        </div>
        <p>{privacyMessage}</p>
      </header>

      <div
        ref={evaluationScrollRef}
        className={`evaluation-scroll-area${requestState === "save-error" ? " evaluation-scroll-area--with-error" : ""}`}
        onScroll={(event) => window.localStorage.setItem(scrollKey, String(event.currentTarget.scrollTop))}
      >
        {loadState === "error" && (
          <div className="evaluation-load-error" role="alert">
            <strong>평가 정보를 불러오지 못했어요.</strong>
            <button type="button" onClick={() => setReloadVersion((current) => current + 1)}>다시 시도</button>
          </div>
        )}
        <div className="evaluation-list">
          {candidates.map((candidate) => {
            const posterUrl = candidate.posterPath
              ? `https://image.tmdb.org/t/p/w154${candidate.posterPath}`
              : null;
            const kind = candidate.source === "manual"
              ? "직접 입력"
              : candidate.mediaType === "movie"
                ? "영화"
                : "TV 프로그램";
            const year = candidate.releaseDate?.slice(0, 4);
            const selected = choices[candidate.id];

            return (
              <article className="evaluation-card" key={candidate.id}>
                <div className="evaluation-work-info">
                  <div className={`evaluation-poster${posterUrl ? "" : " evaluation-poster--missing"}`}>
                    {posterUrl && <img src={posterUrl} alt="" loading="lazy" />}
                    {!posterUrl && <span>{candidate.source === "manual" ? <>직접<br />입력</> : "포스터 없음"}</span>}
                  </div>
                  <div className="evaluation-work-text">
                    <strong title={candidate.title}>{candidate.title}</strong>
                    <span>{[kind, year].filter(Boolean).join(" · ")}</span>
                  </div>
                </div>
                <div className="evaluation-rating" role="radiogroup" aria-label={`${candidate.title} 평가`}>
                  {([
                    ["want", "보고 싶어요"],
                    ["okay", "괜찮아요"],
                    ["dislike", "싫어요"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={selected === value}
                      className={selected === value ? "evaluation-rating__option evaluation-rating__option--selected" : "evaluation-rating__option"}
                      onClick={() => chooseRating(candidate.id, value)}
                      disabled={requestState === "saving" || loadState === "loading"}
                    >
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {requestState === "save-error" && (
        <div className="evaluation-save-error" role="alert">평가를 저장하지 못했어요. 다시 시도해 주세요.</div>
      )}
      <div className="evaluation-submit-area">
        <button
          type="button"
          disabled={!allRated || requestState === "saving" || loadState === "loading"}
          aria-busy={requestState === "saving"}
          onClick={completeEvaluation}
        >
          <span>
            {requestState === "saving"
              ? "평가 저장 중…"
              : requestState === "save-error"
                ? "다시 저장"
                : isRevision
                  ? "수정 완료"
                  : "평가 완료"}
          </span>
        </button>
      </div>
    </main>
  );
}

const EVALUATION_PREVIEW_WORKS = [
  { id: "preview-rating-1", title: "인터스텔라", meta: "영화 · 2014", posterPath: "/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg" },
  { id: "preview-rating-2", title: "기생충", meta: "영화 · 2019", posterPath: "/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg" },
  { id: "preview-rating-3", title: "인사이드 아웃 2", meta: "영화 · 2024", posterPath: "/vpnVM9B6NMmQpWeZvzLvDESb2QY.jpg" },
  { id: "preview-rating-4", title: "듄: 파트 2", meta: "영화 · 2024", posterPath: "/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg" },
] as const;

function EvaluationPreviewScreen() {
  const [choices, setChoices] = useState<Record<string, EvaluationChoice>>({});
  const completedCount = Object.keys(choices).length;
  const remainingCount = EVALUATION_PREVIEW_WORKS.length - completedCount;
  const allRated = remainingCount === 0;

  return (
    <main className="evaluation-screen screen-transition" aria-label="1차 평가 실험">
      <header className="evaluation-header">
        <div className="evaluation-title-row">
          <h1>1차 평가</h1>
          <span aria-label={`${EVALUATION_PREVIEW_WORKS.length}편 중 ${completedCount}편 평가`}>{completedCount} / {EVALUATION_PREVIEW_WORKS.length}</span>
        </div>
        <p>{completedCount === 0 ? "싫어요는 함께 볼 수 없다는 강한 거절이에요" : allRated ? "모든 작품을 평가했어요 · 완료할 수 있어요" : `${remainingCount}개 남았어요 · 선택은 결정 전까지 비공개예요`}</p>
      </header>
      <div className="evaluation-scroll-area">
        <div className="evaluation-list">
          {EVALUATION_PREVIEW_WORKS.map((work) => {
            const selected = choices[work.id];
            return (
              <article className="evaluation-card" key={work.id}>
                <div className="evaluation-work-info">
                  <div className="evaluation-poster"><img src={`https://image.tmdb.org/t/p/w154${work.posterPath}`} alt="" /></div>
                  <div className="evaluation-work-text"><strong>{work.title}</strong><span>{work.meta}</span></div>
                </div>
                <div className="evaluation-rating" role="radiogroup" aria-label={`${work.title} 평가`}>
                  {([[
                    "want", "보고 싶어요",
                  ], ["okay", "괜찮아요"], ["dislike", "싫어요"]] as const).map(([value, label]) => (
                    <button key={value} type="button" role="radio" aria-checked={selected === value} className={selected === value ? "evaluation-rating__option evaluation-rating__option--selected" : "evaluation-rating__option"} onClick={() => setChoices((current) => ({ ...current, [work.id]: value }))}><span>{label}</span></button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </div>
      <div className="evaluation-submit-area">
        <button type="button" disabled={!allRated}><span>평가 완료</span></button>
      </div>
    </main>
  );
}

function RevoteSetupScreen({
  session,
  round,
  candidateIds,
  candidates,
  isLeaving,
  onTransitionEnd,
  onStarted,
}: TransitionProps & {
  session: RoomSession;
  round: 1 | 2;
  candidateIds: string[];
  candidates: Candidate[];
  onStarted: (round: 1 | 2) => void;
}) {
  const revoteCandidates = candidateIds
    .map((candidateId) => candidates.find((candidate) => candidate.id === candidateId))
    .filter((candidate): candidate is Candidate => Boolean(candidate));
  const maxSelectionCount = Math.max(1, revoteCandidates.length - 1);
  const [selectionCount, setSelectionCount] = useState(1);
  const [requestState, setRequestState] = useState<"idle" | "saving" | "error">("idle");

  const startRevote = async () => {
    if (requestState === "saving") return;
    setRequestState("saving");
    try {
      await startRoomRevote(session.room.id, round, selectionCount);
      onStarted(round);
    } catch (error) {
      console.error("Failed to start revote", error);
      setRequestState("error");
    }
  };

  return (
    <main
      className={`revote-setup-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`}
      aria-label="재투표 설정"
      onAnimationEnd={onTransitionEnd}
    >
      <header className="evaluation-complete-header">
        <h1>{round === 1 ? "재투표 설정" : "2차 재투표 설정"}</h1>
        <span>{round} / 2</span>
      </header>
      <div className="revote-setup-scroll-area revote-setup-scroll-area--with-action">
        <section className="revote-rule-card">
          <div><strong>한 사람당 고를 작품 수</strong><span>기본 1편 · 후보 수보다 적게</span></div>
          <b>{selectionCount}편</b>
        </section>
        <section className="revote-candidate-list" aria-label="재투표 후보">
          {revoteCandidates.map((candidate) => {
            const posterUrl = candidate.posterPath ? `https://image.tmdb.org/t/p/w154${candidate.posterPath}` : null;
            const kind = candidate.source === "manual" ? "직접 입력" : candidate.mediaType === "movie" ? "영화" : "TV 프로그램";
            return (
              <article className="revote-candidate-card" key={candidate.id}>
                <div className={`evaluation-result-poster${posterUrl ? "" : " evaluation-result-poster--missing"}`}>
                  {posterUrl ? <img src={posterUrl} alt="" /> : <span>포스터 없음</span>}
                </div>
                <div><strong>{candidate.title}</strong><span>{[kind, candidate.releaseDate?.slice(0, 4)].filter(Boolean).join(" · ")}</span></div>
                <span className="revote-candidate-check" aria-label="재투표 대상">✓</span>
              </article>
            );
          })}
        </section>
        <section className="revote-count-setting">
          <div><strong>선택 수</strong><span>참여자마다 정확히 골라요</span></div>
          <div className="revote-stepper" aria-label="재투표 선택 수">
            <button type="button" aria-label="선택 수 줄이기" disabled={selectionCount <= 1} onClick={() => setSelectionCount((count) => Math.max(1, count - 1))}><span>−</span></button>
            <strong>{selectionCount}</strong>
            <button type="button" aria-label="선택 수 늘리기" disabled={selectionCount >= maxSelectionCount} onClick={() => setSelectionCount((count) => Math.min(maxSelectionCount, count + 1))}><span>＋</span></button>
          </div>
        </section>
        <p className="revote-setup-notice">모든 참여자는 정확히 {selectionCount}편을 고르거나 이번 재투표를 기권할 수 있어요.</p>
        {requestState === "error" && <div className="evaluation-complete-error" role="alert">재투표를 시작하지 못했어요. 설정은 그대로 유지됐어요.</div>}
      </div>
      <div className="revote-setup-actions">
        <button type="button" onClick={startRevote} disabled={requestState === "saving"} aria-busy={requestState === "saving"}>
          <span>{requestState === "error" ? "다시 시도" : round === 1 ? "재투표 시작" : "2차 재투표 시작"}</span>
        </button>
      </div>
    </main>
  );
}

function RevoteScreen({
  session,
  candidates,
  isLeaving,
  onTransitionEnd,
  onOpenSecondSetup,
}: TransitionProps & {
  session: RoomSession;
  candidates: Candidate[];
  onOpenSecondSetup: (result: RevoteRound) => void;
}) {
  const preferredRound: 1 | 2 = session.room.stage === "revote_2" ? 2 : 1;
  const [revote, setRevote] = useState<RevoteRound | null>(null);
  const [statuses, setStatuses] = useState<RevoteStatus[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [abstained, setAbstained] = useState(false);
  const [mode, setMode] = useState<"editing" | "completed">("editing");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [requestState, setRequestState] = useState<"idle" | "saving" | "reopening" | "deciding" | "error">("idle");
  const [reloadVersion, setReloadVersion] = useState(0);
  const isHost = session.members.some((member) => member.userId === session.userId && member.role === "host");
  const allParticipantsCompleted = session.members.length >= 2
    && session.members.every((member) => statuses.some((status) => status.userId === member.userId && status.status === "completed"));

  useEffect(() => {
    let active = true;
    setLoadState("loading");
    void (async () => {
      const targetRound = session.room.stage === "ladder"
        ? await loadLatestRevoteRound(session.room.id)
        : await loadRevoteRound(session.room.id, preferredRound);
      if (!targetRound) throw new Error("revote_not_ready");
      const state = await loadRevoteState(session.room.id, targetRound.round);
      if (!active || !state.round) return;
      setRevote(state.round);
      setStatuses(state.statuses);
      setSelectedIds(state.selectedCandidateIds);
      setAbstained(state.abstained);
      const myStatus = state.statuses.find((status) => status.userId === session.userId)?.status;
      setMode(state.round.outcome || myStatus === "completed" ? "completed" : "editing");
      setLoadState("ready");
    })().catch((error) => {
      console.error("Failed to load revote", error);
      if (active) setLoadState("error");
    });
    return () => { active = false; };
  }, [preferredRound, reloadVersion, session.room.id, session.room.stage, session.userId]);

  const realtimeRound = revote?.round;
  useEffect(() => {
    if (!realtimeRound) return;
    const channel = supabase
      .channel(`revote-${session.room.id}-${realtimeRound}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "revote_statuses", filter: `room_id=eq.${session.room.id}` },
        () => void loadRevoteStatuses(session.room.id, realtimeRound).then(setStatuses).catch((error) => console.error("Failed to refresh revote statuses", error)),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "revote_rounds", filter: `room_id=eq.${session.room.id}` },
        () => void loadRevoteRound(session.room.id, realtimeRound).then((next) => next && setRevote(next)).catch((error) => console.error("Failed to refresh revote result", error)),
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [realtimeRound, session.room.id]);

  const toggleCandidate = (candidateId: string) => {
    if (!revote || requestState === "saving") return;
    setAbstained(false);
    setSelectedIds((current) => current.includes(candidateId)
      ? current.filter((id) => id !== candidateId)
      : current.length < revote.selectionCount ? [...current, candidateId] : current);
    if (requestState === "error") setRequestState("idle");
  };

  const completeRevote = async (shouldAbstain: boolean) => {
    if (!revote || requestState === "saving") return;
    if (!shouldAbstain && selectedIds.length !== revote.selectionCount) return;
    setRequestState("saving");
    try {
      await saveRoomRevote(session.room.id, revote.round, shouldAbstain ? [] : selectedIds, shouldAbstain);
      setAbstained(shouldAbstain);
      if (shouldAbstain) setSelectedIds([]);
      setStatuses((current) => [...current.filter((status) => status.userId !== session.userId), { userId: session.userId, status: "completed" }]);
      setMode("completed");
      setRequestState("idle");
    } catch (error) {
      console.error("Failed to save revote", error);
      setRequestState("error");
    }
  };

  const reopenRevote = async () => {
    if (!revote || requestState === "reopening") return;
    setRequestState("reopening");
    try {
      await reopenRoomRevote(session.room.id, revote.round);
      setStatuses((current) => [...current.filter((status) => status.userId !== session.userId), { userId: session.userId, status: "in_progress" }]);
      setMode("editing");
      setRequestState("idle");
    } catch (error) {
      console.error("Failed to reopen revote", error);
      setRequestState("error");
    }
  };

  const decideRevote = async () => {
    if (!revote || !isHost || !allParticipantsCompleted || requestState === "deciding") return;
    setRequestState("deciding");
    try {
      setRevote(await decideRoomRevote(session.room.id, revote.round));
      setRequestState("idle");
    } catch (error) {
      console.error("Failed to decide revote", error);
      setRequestState("error");
    }
  };

  if (loadState === "error" || !revote) {
    return (
      <main className={`revote-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} onAnimationEnd={onTransitionEnd}>
        <header className="evaluation-complete-header"><h1>재투표</h1></header>
        <div className="evaluation-load-error" role="alert"><strong>재투표 정보를 불러오지 못했어요.</strong><button type="button" onClick={() => setReloadVersion((value) => value + 1)}>다시 시도</button></div>
      </main>
    );
  }

  const revoteCandidates = revote.candidateIds
    .map((candidateId) => candidates.find((candidate) => candidate.id === candidateId))
    .filter((candidate): candidate is Candidate => Boolean(candidate));
  const title = revote.round === 1 ? "1차 재투표" : "2차 재투표";

  if (revote.outcome) {
    const advancing = new Set(revote.advancingCandidateIds);
    const sortedResults = [...revote.candidates].sort((a, b) => b.voteCount - a.voteCount);
    const isWinner = revote.outcome === "winner";
    const goesToLadder = revote.outcome === "all_abstained" || revote.round === 2;
    return (
      <main className={`evaluation-result-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} aria-label={`${title} 결과`} onAnimationEnd={onTransitionEnd}>
        <header className="evaluation-complete-header"><h1>{title} 결과</h1><span>{revote.round} / 2</span></header>
        <div className={`evaluation-result-scroll-area${isHost && !isWinner && !goesToLadder ? " evaluation-result-scroll-area--with-action" : ""}`}>
          <section className="evaluation-result-banner">
            <span>{isWinner ? "선택 완료" : goesToLadder ? "사다리타기" : "공동 1위"}</span>
            <h2>{isWinner ? "오늘 볼 작품이 정해졌어요" : goesToLadder ? "투표로는 정하지 못했어요" : "한 번만 더 골라볼까요?"}</h2>
            <p>{isWinner ? "가장 많은 선택을 받은 작품이에요." : goesToLadder ? "남은 작품으로 사다리타기를 진행해요." : "가장 많은 선택을 받은 작품끼리 2차 재투표를 해요."}</p>
          </section>
          <section className="evaluation-result-list" aria-label="재투표 후보별 결과">
            {sortedResults.map((candidateResult) => {
              const candidate = candidates.find((item) => item.id === candidateResult.candidateId);
              if (!candidate) return null;
              const posterUrl = candidate.posterPath ? `https://image.tmdb.org/t/p/w154${candidate.posterPath}` : null;
              return (
                <article className={`evaluation-result-card${advancing.has(candidate.id) ? " evaluation-result-card--advanced" : ""}`} key={candidate.id}>
                  <div className="evaluation-result-work">
                    <div className={`evaluation-result-poster${posterUrl ? "" : " evaluation-result-poster--missing"}`}>{posterUrl ? <img src={posterUrl} alt="" /> : <span>포스터 없음</span>}</div>
                    <div><strong>{candidate.title}</strong><span>{candidateResult.voteCount}표</span></div>
                  </div>
                  <div className="evaluation-result-names"><span>선택: {candidateResult.voterNicknames.length ? candidateResult.voterNicknames.join(", ") : "없음"}</span></div>
                </article>
              );
            })}
          </section>
          <p className="evaluation-result-notice">{goesToLadder ? "다음 단계에서 사다리타기를 준비해요." : isHost ? "2차 재투표의 선택 수를 정해 주세요." : "방장이 2차 재투표를 준비하고 있어요."}</p>
        </div>
        {isHost && !isWinner && !goesToLadder && (
          <div className="evaluation-result-actions"><button type="button" onClick={() => onOpenSecondSetup(revote)}><span>2차 재투표 설정하기</span></button></div>
        )}
      </main>
    );
  }

  if (mode === "completed") {
    return (
      <main className={`revote-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} aria-label={`${title} 완료`} onAnimationEnd={onTransitionEnd}>
        <header className="evaluation-complete-header"><h1>{title}</h1><span>{revote.round} / 2</span></header>
        <div className="evaluation-complete-content">
          <section className="revote-rule-card"><div><strong>{abstained ? "이번 재투표를 기권했어요" : `${selectedIds.length}편 선택을 완료했어요`}</strong><span>결과가 공개되기 전까지 선택은 비공개예요</span></div><b>완료</b></section>
          <section className="evaluation-participants" aria-label="참여자 재투표 상태">
            {session.members.map((member) => {
              const status = statuses.find((item) => item.userId === member.userId)?.status ?? "in_progress";
              return <div className="evaluation-participant" key={member.userId}><span className="evaluation-avatar" aria-hidden="true">{member.nickname.slice(0, 1)}</span><strong>{member.userId === session.userId ? `나 · ${member.nickname}` : member.nickname}</strong><span className={`evaluation-status-pill evaluation-status-pill--${status}`}>{status === "completed" ? "선택 완료" : "선택 중"}</span></div>;
            })}
          </section>
          {isHost && <section className="evaluation-decision-card"><span>{allParticipantsCompleted ? "결정할 준비가 됐어요" : "방장만 결과를 열 수 있어요"}</span><h2>{allParticipantsCompleted ? "모든 참여자가 선택을 마쳤어요" : "아직 선택 중인 참여자가 있어요"}</h2><p>{allParticipantsCompleted ? "이제 선택 결과를 공개해요." : "전원이 완료하면 결과 버튼이 열려요."}</p></section>}
          {isHost && !allParticipantsCompleted && <button type="button" className="revote-edit-link" onClick={reopenRevote} disabled={requestState === "reopening"}>내 선택 수정</button>}
          {requestState === "error" && <div className="evaluation-complete-error" role="alert">요청을 처리하지 못했어요. 선택은 그대로 유지됐어요.</div>}
        </div>
        <div className="evaluation-complete-actions">
          {isHost ? <button type="button" onClick={decideRevote} disabled={!allParticipantsCompleted || requestState === "deciding"}><span>{allParticipantsCompleted ? "재투표 결과 보기" : "모두의 선택을 기다리는 중"}</span></button> : <button type="button" onClick={reopenRevote} disabled={requestState === "reopening"}><span>선택 수정</span></button>}
        </div>
      </main>
    );
  }

  const remaining = Math.max(0, revote.selectionCount - selectedIds.length);
  return (
    <main className={`revote-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} aria-label={title} onAnimationEnd={onTransitionEnd}>
      <header className="evaluation-complete-header"><h1>{title}</h1><span>{revote.round} / 2</span></header>
      <div className="revote-vote-scroll-area">
        <section className="revote-rule-card"><div><strong>{revote.selectionCount}편을 골라 주세요</strong><span>선택은 결과가 열릴 때까지 비공개예요</span></div><b>{selectedIds.length} / {revote.selectionCount}</b></section>
        <section className="revote-candidate-list" aria-label="재투표 후보">
          {revoteCandidates.map((candidate) => {
            const posterUrl = candidate.posterPath ? `https://image.tmdb.org/t/p/w154${candidate.posterPath}` : null;
            const selected = selectedIds.includes(candidate.id);
            return <button type="button" className={`revote-candidate-card revote-candidate-card--button${selected ? " revote-candidate-card--selected" : ""}`} key={candidate.id} onClick={() => toggleCandidate(candidate.id)} aria-pressed={selected}><div className={`evaluation-result-poster${posterUrl ? "" : " evaluation-result-poster--missing"}`}>{posterUrl ? <img src={posterUrl} alt="" /> : <span>포스터 없음</span>}</div><div><strong>{candidate.title}</strong><span>{[candidate.mediaType === "movie" ? "영화" : candidate.mediaType === "tv" ? "TV 프로그램" : "직접 입력", candidate.releaseDate?.slice(0, 4)].filter(Boolean).join(" · ")}</span></div><span className="revote-candidate-check" aria-hidden="true">{selected ? "✓" : ""}</span></button>;
          })}
        </section>
        <section className="revote-inline-status"><strong>참여자 선택 상태</strong><div>{session.members.map((member) => { const status = statuses.find((item) => item.userId === member.userId)?.status ?? "in_progress"; return <span key={member.userId} className={status === "completed" ? "is-complete" : ""}>{member.nickname} · {status === "completed" ? "완료" : "선택 중"}</span>; })}</div></section>
        <button type="button" className="revote-abstain-button" onClick={() => completeRevote(true)} disabled={requestState === "saving"}>이번 재투표 기권하기</button>
        {requestState === "error" && <div className="evaluation-complete-error" role="alert">선택을 저장하지 못했어요. 선택 내용은 그대로예요.</div>}
      </div>
      <div className="evaluation-submit-area"><button type="button" onClick={() => completeRevote(false)} disabled={remaining > 0 || requestState === "saving"}><span>{remaining > 0 ? `${remaining}편 더 선택` : "선택 완료"}</span></button></div>
    </main>
  );
}

function buildLadderPath(run: LadderRun, laneCount: number) {
  const spacing = laneCount > 1 ? 270 / (laneCount - 1) : 0;
  const laneX = (lane: number) => 20.5 + spacing * lane;
  let lane = run.winningLane;
  let path = `M ${laneX(lane)} 0`;
  const rungsByLevel = new Map<number, number[]>();
  for (const rung of run.rungs) {
    const values = rungsByLevel.get(rung.level) ?? [];
    values.push(rung.leftLane);
    rungsByLevel.set(rung.level, values);
  }
  for (let level = 0; level < 8; level += 1) {
    const y = 18 + level * 18;
    path += ` L ${laneX(lane)} ${y}`;
    const rungs = rungsByLevel.get(level) ?? [];
    if (rungs.includes(lane)) lane += 1;
    else if (rungs.includes(lane - 1)) lane -= 1;
    path += ` L ${laneX(lane)} ${y}`;
  }
  return `${path} L ${laneX(lane)} 160`;
}

const LADDER_PREVIEW_CANDIDATES = [
  { id: "preview-1", title: "인터스텔라" },
  { id: "preview-2", title: "기생충" },
  { id: "preview-3", title: "인사이드 아웃 2" },
  { id: "preview-4", title: "듄: 파트 2" },
  { id: "preview-5", title: "헤어질 결심" },
  { id: "preview-6", title: "극한직업" },
] as const;

function makeLadderPreviewRun(
  run: 1 | 2,
  winningLane: number,
  candidateOrder: string[],
  rungs: LadderRun["rungs"],
): LadderRun {
  let destinationLane = winningLane;
  for (let level = 0; level < 8; level += 1) {
    const levelRungs = rungs.filter((rung) => rung.level === level);
    if (levelRungs.some((rung) => rung.leftLane === destinationLane)) destinationLane += 1;
    else if (levelRungs.some((rung) => rung.leftLane === destinationLane - 1)) destinationLane -= 1;
  }
  return { run, winningLane, candidateOrder, rungs, winnerCandidateId: candidateOrder[destinationLane] };
}

function makeWaitingLadderRun(candidateIds: string[]): LadderRun {
  const rungs: LadderRun["rungs"] = [];
  for (let level = 0; level < 8; level += 1) {
    rungs.push({ level, leftLane: (level * 2 + (level > 3 ? 1 : 0)) % (candidateIds.length - 1) });
  }
  return makeLadderPreviewRun(1, Math.min(1, candidateIds.length - 1), [...candidateIds], rungs);
}

const LADDER_PREVIEW_RUNS: [LadderRun, LadderRun] = [
  makeLadderPreviewRun(1, 1, ["preview-4", "preview-1", "preview-6", "preview-2", "preview-5", "preview-3"], [
    { level: 0, leftLane: 0 }, { level: 1, leftLane: 3 },
    { level: 2, leftLane: 0 }, { level: 3, leftLane: 1 },
    { level: 4, leftLane: 4 }, { level: 5, leftLane: 2 },
    { level: 6, leftLane: 3 }, { level: 7, leftLane: 0 },
  ]),
  makeLadderPreviewRun(2, 4, ["preview-2", "preview-5", "preview-3", "preview-6", "preview-1", "preview-4"], [
    { level: 0, leftLane: 2 }, { level: 1, leftLane: 4 },
    { level: 2, leftLane: 1 }, { level: 3, leftLane: 3 },
    { level: 4, leftLane: 0 }, { level: 5, leftLane: 2 },
    { level: 6, leftLane: 4 }, { level: 7, leftLane: 1 },
  ]),
];

function LadderPreviewScreen() {
  const [activeRun, setActiveRun] = useState<LadderRun | null>(null);
  const [motionPhase, setMotionPhase] = useState<"waiting" | "running" | "result">("waiting");
  const [motionKey, setMotionKey] = useState(0);
  const [finalized, setFinalized] = useState(false);
  const laneCount = LADDER_PREVIEW_CANDIDATES.length;
  const boardRun = activeRun ?? LADDER_PREVIEW_RUNS[0];
  const path = activeRun ? buildLadderPath(activeRun, laneCount) : "";
  const winner = LADDER_PREVIEW_CANDIDATES.find((candidate) => candidate.id === activeRun?.winnerCandidateId);
  const isResult = Boolean(activeRun) && motionPhase === "result";
  const isSecond = activeRun?.run === 2;

  const startRun = (run: 1 | 2) => {
    setFinalized(false);
    setActiveRun(LADDER_PREVIEW_RUNS[run - 1]);
    setMotionKey((value) => value + 1);
    setMotionPhase("running");
  };

  const reset = () => {
    setActiveRun(null);
    setMotionPhase("waiting");
    setFinalized(false);
  };

  const introTitle = finalized
    ? "오늘의 작품이 정해졌어요"
    : motionPhase === "running"
      ? "당첨 경로가 내려가고 있어요"
      : isResult
        ? isSecond ? "최종 당첨 작품이 정해졌어요" : "당첨 작품을 찾았어요!"
        : "무작위 당첨 칸에서 출발해요";
  const introDescription = finalized && winner
    ? `‘${winner.title}’으로 결정한 실험 결과예요.`
    : motionPhase === "running"
      ? "영화 티켓이 끊김 없이 연결된 경로를 따라가요."
      : isResult && winner
        ? `‘${winner.title}’에 당첨 경로가 닿았어요.`
        : "방장이 시작하면 섞인 번호가 공개되고 사다리가 출발해요.";

  return (
    <main className="ladder-screen screen-transition" aria-label="6개 후보 사다리타기 실험">
      <header className="evaluation-complete-header"><h1>사다리타기</h1></header>
      <div className={`ladder-scroll-area${isResult && !isSecond && !finalized ? " ladder-scroll-area--double-action" : ""}`}>
        <section className="ladder-intro"><h2>{introTitle}</h2><p>{introDescription}</p></section>
        <section className="ladder-six-notice"><b>6</b><div><strong>후보가 많아 같은 확률로 6편을 먼저 뽑았어요</strong><span>뽑힌 6편은 모두 같은 확률로 출발해요.</span></div></section>
        <section className="ladder-legend" aria-label="사다리 후보 번호">
          {LADDER_PREVIEW_CANDIDATES.map((candidate, index) => <div key={candidate.id}><b>{index + 1}</b><span>{candidate.title}</span></div>)}
        </section>
        <section className="ladder-board" aria-label="작품 사다리">
          <div className="ladder-top-row">
            {Array.from({ length: laneCount }, (_, lane) => {
              const winning = boardRun.winningLane === lane;
              return <span className={winning ? "is-winning" : ""} key={lane}><img src={winning ? ladderWinningPopcornIcon : ladderLosingDotIcon} alt="" /><em>{winning ? "당첨" : "꽝"}</em></span>;
            })}
          </div>
          <div className="ladder-track">
            <svg viewBox="0 0 311 160" preserveAspectRatio="none" aria-hidden="true">
              {Array.from({ length: laneCount }, (_, lane) => { const x = 20.5 + (270 / (laneCount - 1)) * lane; return <line key={`preview-lane-${lane}`} x1={x} y1="0" x2={x} y2="160" />; })}
              {boardRun.rungs.map((rung, index) => { const spacing = 270 / (laneCount - 1); const y = 18 + rung.level * 18; return <line key={`preview-rung-${index}`} x1={20.5 + spacing * rung.leftLane} y1={y} x2={20.5 + spacing * (rung.leftLane + 1)} y2={y} />; })}
              {activeRun && <path key={`preview-path-${motionKey}`} className={motionPhase === "running" ? "ladder-winning-path is-running" : "ladder-winning-path"} d={path} pathLength="1" />}
            </svg>
            {activeRun && motionPhase === "running" && <span key={`preview-ticket-${motionKey}`} className="ladder-ticket" style={{ offsetPath: `path("${path}")` } as CSSProperties} onAnimationEnd={() => setMotionPhase("result")} aria-label="당첨 경로를 따라가는 영화 티켓">🎟</span>}
          </div>
          <div className="ladder-bottom-row">
            {(activeRun?.candidateOrder ?? LADDER_PREVIEW_CANDIDATES.map((candidate) => candidate.id)).map((candidateId) => {
              const number = LADDER_PREVIEW_CANDIDATES.findIndex((candidate) => candidate.id === candidateId) + 1;
              return <span className={isResult && candidateId === activeRun?.winnerCandidateId ? "is-winner" : ""} key={candidateId}>{activeRun ? number : "?"}</span>;
            })}
          </div>
        </section>
        <div className="ladder-notice">{finalized ? "실험 화면이라 실제 방에는 저장되지 않았어요" : motionPhase === "running" ? `${isSecond ? "마지막" : "첫 번째"} 사다리 · 경로를 따라가는 중` : isResult ? isSecond ? "다시 하기를 모두 사용했어요" : "이 결과로 정하거나 한 번 다시 할 수 있어요" : "아래 버튼을 눌러 모션을 확인해 보세요"}</div>
      </div>
      <div className="ladder-actions">
        {isResult && !isSecond && !finalized && <button type="button" className="ladder-retry-button" onClick={() => startRun(2)}><span>한 번 다시 하기</span></button>}
        <button type="button" disabled={motionPhase === "running"} onClick={() => finalized ? reset() : isResult ? setFinalized(true) : startRun(1)}><span>{motionPhase === "running" ? "결과 확인 중" : finalized ? "처음부터 다시 보기" : isResult ? isSecond ? "오늘의 작품 확인" : "이 결과로 결정" : "사다리 출발!"}</span></button>
      </div>
    </main>
  );
}

function LadderScreen({
  session,
  candidates,
  isLeaving,
  onTransitionEnd,
  onRoomAdvanced,
}: TransitionProps & {
  session: RoomSession;
  candidates: Candidate[];
  onRoomAdvanced: (room: RoomSession["room"]) => void;
}) {
  const [ladder, setLadder] = useState<LadderSession | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [requestState, setRequestState] = useState<"idle" | "preparing" | "starting" | "finalizing" | "error">("idle");
  const [motionPhase, setMotionPhase] = useState<"waiting" | "running" | "result">("waiting");
  const [motionKey, setMotionKey] = useState(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const isHost = session.members.some((member) => member.userId === session.userId && member.role === "host");
  const hostNickname = session.members.find((member) => member.role === "host")?.nickname ?? "방장";

  const refreshLadder = useCallback(async () => {
    const loaded = await loadLadderSession(session.room.id);
    setLadder(loaded);
    setLoadState("ready");
    return loaded;
  }, [session.room.id]);

  useEffect(() => {
    let active = true;
    setLoadState("loading");
    void loadLadderSession(session.room.id)
      .then(async (loaded) => {
        if (!active) return;
        if (!loaded && isHost) {
          setRequestState("preparing");
          loaded = await prepareRoomLadder(session.room.id);
        }
        if (!active) return;
        setLadder(loaded);
        setRequestState("idle");
        setLoadState("ready");
      })
      .catch((error) => {
        console.error("Failed to prepare ladder", error);
        if (active) { setRequestState("error"); setLoadState("error"); }
      });
    return () => { active = false; };
  }, [isHost, reloadVersion, session.room.id]);

  useEffect(() => {
    const channel = supabase
      .channel(`ladder-${session.room.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "ladder_sessions", filter: `room_id=eq.${session.room.id}` }, () => {
        void refreshLadder().catch((error) => console.error("Failed to refresh ladder", error));
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [refreshLadder, session.room.id]);

  const activeRun = ladder?.secondRun ?? ladder?.firstRun ?? null;
  const activeRunNumber = activeRun?.run;
  const activeWinnerId = activeRun?.winnerCandidateId;
  useEffect(() => {
    if (!activeRunNumber || !activeWinnerId) {
      setMotionPhase("waiting");
      return;
    }
    setMotionKey((value) => value + 1);
    setMotionPhase("running");
  }, [activeRunNumber, activeWinnerId]);

  const startRun = async (run: 1 | 2) => {
    if (!isHost || requestState === "starting") return;
    setRequestState("starting");
    try {
      const next = await startLadderRun(session.room.id, run);
      setLadder(next);
      setRequestState("idle");
    } catch (error) {
      console.error("Failed to start ladder", error);
      setRequestState("error");
    }
  };

  const finalize = async (run: 1 | 2) => {
    if (!isHost || requestState === "finalizing") return;
    setRequestState("finalizing");
    try {
      onRoomAdvanced(await finalizeLadder(session.room.id, run));
    } catch (error) {
      console.error("Failed to finalize ladder", error);
      setRequestState("error");
    }
  };

  if (loadState === "error" || (!ladder && !isHost && loadState === "ready")) {
    return (
      <main className={`ladder-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} onAnimationEnd={onTransitionEnd}>
        <header className="evaluation-complete-header"><h1>사다리타기</h1></header>
        <div className="evaluation-load-error" role="alert"><strong>{isHost ? "사다리를 준비하지 못했어요." : "방장이 사다리를 준비하고 있어요."}</strong>{isHost && <button type="button" onClick={() => setReloadVersion((value) => value + 1)}>다시 시도</button>}</div>
      </main>
    );
  }

  if (!ladder) {
    return <main className={`ladder-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} onAnimationEnd={onTransitionEnd}><header className="evaluation-complete-header"><h1>사다리타기</h1></header></main>;
  }

  const ladderCandidates = ladder.candidateIds
    .map((id) => candidates.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Candidate => Boolean(candidate));
  const laneCount = ladder.candidateIds.length;
  const boardRun = activeRun ?? makeWaitingLadderRun(ladder.candidateIds);
  const laneItems = activeRun?.candidateOrder ?? ladder.candidateIds;
  const path = activeRun ? buildLadderPath(activeRun, laneCount) : "";
  const winner = candidates.find((candidate) => candidate.id === activeRun?.winnerCandidateId);
  const isResult = Boolean(activeRun) && motionPhase === "result";
  const isSecond = activeRun?.run === 2;
  const introTitle = motionPhase === "running"
    ? "당첨 경로가 내려가고 있어요"
    : isResult
      ? isSecond ? "최종 당첨 작품이 정해졌어요" : "당첨 작품을 찾았어요!"
      : isHost ? "무작위 당첨 칸에서 출발해요" : "당첨 사다리가 출발하길 기다려요";
  const introDescription = motionPhase === "running"
    ? "영화 티켓이 끊김 없이 연결된 경로를 따라가요."
    : isResult && winner
      ? `‘${winner.title}’${isSecond ? "이 모두의 최종 결과예요." : "에 당첨 경로가 닿았어요."}`
      : isHost ? "방장이 시작하면 섞인 번호가 공개되고 사다리가 출발해요." : "방장이 시작하면 같은 경로가 모두에게 보여요.";

  return (
    <main className={`ladder-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} aria-label="사다리타기" onAnimationEnd={onTransitionEnd}>
      <header className="evaluation-complete-header"><h1>사다리타기</h1></header>
      <div className={`ladder-scroll-area${isResult && isHost && !isSecond ? " ladder-scroll-area--double-action" : ""}`}>
        <section className="ladder-intro"><h2>{introTitle}</h2><p>{introDescription}</p></section>
        {ladder.sourceCandidateCount > 6 && <section className="ladder-six-notice"><b>6</b><div><strong>후보가 많아 같은 확률로 6편을 먼저 뽑았어요</strong><span>뽑힌 6편은 모두 같은 확률로 출발해요.</span></div></section>}
        <section className="ladder-legend" aria-label="사다리 후보 번호">
          {ladderCandidates.map((candidate, index) => <div key={candidate.id}><b>{index + 1}</b><span>{candidate.title}</span></div>)}
        </section>
        <section className="ladder-board" aria-label="작품 사다리">
          <div className="ladder-top-row">
            {Array.from({ length: laneCount }, (_, lane) => {
              const winning = boardRun.winningLane === lane;
              return <span className={winning ? "is-winning" : ""} key={lane}><img src={winning ? ladderWinningPopcornIcon : ladderLosingDotIcon} alt="" /><em>{winning ? "당첨" : "꽝"}</em></span>;
            })}
          </div>
          <div className="ladder-track">
            <svg viewBox="0 0 311 160" preserveAspectRatio="none" aria-hidden="true">
              {Array.from({ length: laneCount }, (_, lane) => { const x = 20.5 + (laneCount > 1 ? 270 / (laneCount - 1) : 0) * lane; return <line key={`lane-${lane}`} x1={x} y1="0" x2={x} y2="160" />; })}
              {boardRun.rungs.map((rung, index) => { const spacing = laneCount > 1 ? 270 / (laneCount - 1) : 0; const y = 18 + rung.level * 18; return <line key={`rung-${index}`} x1={20.5 + spacing * rung.leftLane} y1={y} x2={20.5 + spacing * (rung.leftLane + 1)} y2={y} />; })}
              {activeRun && <path key={`path-${motionKey}`} className={motionPhase === "running" ? "ladder-winning-path is-running" : "ladder-winning-path"} d={path} pathLength="1" />}
            </svg>
            {activeRun && motionPhase === "running" && (
              <span
                key={`ticket-${motionKey}`}
                className="ladder-ticket"
                style={{ offsetPath: `path("${path}")` } as CSSProperties}
                onAnimationEnd={() => setMotionPhase("result")}
                aria-label="당첨 경로를 따라가는 영화 티켓"
              >🎟</span>
            )}
          </div>
          <div className="ladder-bottom-row">
            {laneItems.map((candidateId) => {
              const number = ladder.candidateIds.indexOf(candidateId) + 1;
              return <span className={isResult && candidateId === activeRun?.winnerCandidateId ? "is-winner" : ""} key={candidateId}>{activeRun ? number : "?"}</span>;
            })}
          </div>
        </section>
        <div className="ladder-notice">{motionPhase === "running" ? `${isSecond ? "마지막" : "첫 번째"} 사다리 · 경로를 따라가는 중` : isResult ? isSecond ? "다시 하기를 모두 사용했어요" : isHost ? "이 결과로 정하거나 한 번 다시 할 수 있어요" : "방장이 결과를 정하고 있어요" : isHost ? `준비되면 ${hostNickname}님이 사다리를 출발시켜요` : `방장인 ${hostNickname}님이 시작할 때까지 기다려요`}</div>
        {requestState === "error" && <div className="evaluation-complete-error" role="alert">요청을 처리하지 못했어요. 저장된 사다리는 그대로예요.</div>}
      </div>
      <div className="ladder-actions">
        {isResult && isHost && !isSecond && <button type="button" className="ladder-retry-button" onClick={() => startRun(2)} disabled={requestState === "starting"}><span>한 번 다시 하기</span></button>}
        <button type="button" disabled={!isHost || requestState === "starting" || requestState === "finalizing" || motionPhase === "running"} onClick={() => isResult && activeRun ? finalize(activeRun.run) : startRun(1)}>
          <span>{!isHost ? isResult ? "방장 결정을 기다리는 중" : "방장을 기다리는 중" : motionPhase === "running" ? "결과 확인 중" : isResult ? isSecond ? "오늘의 작품 확인" : "이 결과로 결정" : "사다리 출발!"}</span>
        </button>
      </div>
    </main>
  );
}

type DecisionHistoryData = {
  evaluations: EvaluationRoundResult[];
  revotes: RevoteRound[];
  ladder: LadderSession | null;
};

async function loadDecisionHistoryData(roomId: string): Promise<DecisionHistoryData> {
  const [evaluations, firstRevote, secondRevote, ladder] = await Promise.all([
    loadEvaluationResults(roomId),
    loadRevoteRound(roomId, 1),
    loadRevoteRound(roomId, 2),
    loadLadderSession(roomId),
  ]);
  return { evaluations, revotes: [firstRevote, secondRevote].filter((round): round is RevoteRound => Boolean(round)), ladder };
}

function candidateMeta(candidate: Candidate) {
  const media = candidate.mediaType === "movie" ? "영화" : candidate.mediaType === "tv" ? "TV 프로그램" : "직접 입력";
  const year = candidate.releaseDate?.slice(0, 4);
  const genreMap = candidate.mediaType === "movie" ? MOVIE_GENRES : TV_GENRES;
  const genre = candidate.genreIds.map((id) => genreMap[id]).find(Boolean);
  return [media, year, genre].filter(Boolean).join(" · ");
}

function decisionReason(data: DecisionHistoryData) {
  if (data.ladder?.finalRun) return `${data.revotes.length ? "재투표 동점 후 " : ""}${data.ladder.finalRun === 1 ? "첫 번째" : "마지막"} 사다리타기로 결정됐어요.`;
  const lastRevote = data.revotes[data.revotes.length - 1];
  if (lastRevote) return `${data.evaluations[data.evaluations.length - 1]?.round === 2 ? "전체 후보 재평가" : "1차 평가"} 공동 1위 후 재투표로 결정됐어요.`;
  const lastEvaluation = data.evaluations[data.evaluations.length - 1];
  return lastEvaluation?.round === 2 ? "전체 후보 재평가에서 단독 1위로 결정됐어요." : "1차 평가에서 단독 1위로 결정됐어요.";
}

function ProviderMark({ name }: { name: string }) {
  const normalized = name.toLowerCase();
  const className = normalized.includes("netflix") ? "netflix" : normalized.includes("tving") ? "tving" : normalized.includes("wavve") ? "wavve" : normalized.includes("watcha") ? "watcha" : normalized.includes("disney") ? "disney" : normalized.includes("coupang") ? "coupang" : "other";
  return <span className={`provider-mark provider-mark--${className}`} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

function FinalResultView({
  session,
  candidates,
  data,
  isLeaving = false,
  onTransitionEnd,
  onCreateRoom,
  onOpenHistory,
  onRoomDeleted,
}: {
  session: RoomSession;
  candidates: Candidate[];
  data: DecisionHistoryData;
  isLeaving?: boolean;
  onTransitionEnd?: (event: AnimationEvent<HTMLElement>) => void;
  onCreateRoom: () => void;
  onOpenHistory: () => void;
  onRoomDeleted: () => void;
}) {
  const winnerId = session.room.final_candidate_id ?? data.ladder?.winnerCandidateId ?? data.revotes[data.revotes.length - 1]?.advancingCandidateIds[0] ?? data.evaluations[data.evaluations.length - 1]?.advancingCandidateIds[0];
  const winner = candidates.find((candidate) => candidate.id === winnerId);
  const posterUrl = winner?.posterPath ? `https://image.tmdb.org/t/p/w342${winner.posterPath}` : null;
  const stageCount = data.evaluations.length + data.revotes.length + (data.ladder?.finalRun ? 1 : 0);
  const providerCheckedDate = winner ? new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "numeric", day: "numeric" }).format(new Date(winner.createdAt)).replace(/\. /g, ". ").replace(/\.$/, "") : "";

  return (
    <main className={`final-result-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} aria-label="오늘의 작품" onAnimationEnd={onTransitionEnd}>
      <header className="evaluation-complete-header final-result-header">
        <h1>오늘의 작품</h1>
      </header>
      <HostRoomTerminationControl session={session} onRoomDeleted={onRoomDeleted} includeRoomInfo position="header" />
      <div className="final-result-scroll-area">
        {!winner ? <div className="evaluation-load-error" role="alert"><strong>최종 작품을 불러오지 못했어요.</strong></div> : (
          <>
            <section className="final-intro"><span>결정 완료</span><h2>오늘은 이 작품 어때요?</h2><p>{decisionReason(data)}</p></section>
            <section className="final-winner-card">
              <div className="final-winner-main">
                <div className={`final-winner-poster${posterUrl ? "" : " final-winner-poster--missing"}`}>{posterUrl ? <img src={posterUrl} alt="" /> : <span>포스터 없음</span>}</div>
                <div className="final-winner-copy"><strong>{winner.title}</strong><span>{candidateMeta(winner)}</span></div>
              </div>
              <p className="final-winner-note">OTT 정보 확인일 {providerCheckedDate} · 실제 정보와 다를 수 있어요</p>
            </section>
            <section className="final-stats" aria-label="결정 요약">
              <div><strong>{session.members.length}명</strong><span>참여자</span></div>
              <div><strong>{candidates.length}편</strong><span>전체 후보</span></div>
              <div><strong>{Math.max(1, stageCount)}회</strong><span>결정 단계</span></div>
            </section>
            <section className="final-provider-section">
              <h2>볼 수 있는 OTT</h2>
              {winner.watchProviders.length ? <div className="final-provider-list">{winner.watchProviders.map((provider) => <div key={provider}><ProviderMark name={provider} /><span>{provider}</span></div>)}</div> : <p>볼 수 있는 곳 정보 없음</p>}
            </section>
          </>
        )}
      </div>
      <div className="final-result-actions">
        <button type="button" className="final-history-button" onClick={onOpenHistory}><span>전체 결정 과정 보기</span></button>
        <button type="button" onClick={onCreateRoom}><span>새 선택방 만들기</span></button>
      </div>
    </main>
  );
}

function FinalResultScreen(props: TransitionProps & { session: RoomSession; candidates: Candidate[]; onCreateRoom: () => void; onOpenHistory: () => void; onRoomDeleted: () => void }) {
  const [data, setData] = useState<DecisionHistoryData | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let active = true;
    void loadDecisionHistoryData(props.session.room.id).then((loaded) => { if (active) { setData(loaded); setLoadState("ready"); } }).catch((error) => { console.error("Failed to load final result", error); if (active) setLoadState("error"); });
    return () => { active = false; };
  }, [props.session.room.id]);
  if (loadState === "loading") return <main className="final-result-screen"><header className="evaluation-complete-header"><h1>오늘의 작품</h1></header></main>;
  if (loadState === "error" || !data) return <main className="final-result-screen"><header className="evaluation-complete-header"><h1>오늘의 작품</h1></header><div className="final-result-scroll-area"><div className="evaluation-load-error" role="alert"><strong>최종 작품을 불러오지 못했어요.</strong></div></div></main>;
  return <FinalResultView {...props} data={data} />;
}

function DecisionHistoryView({ session, candidates, data, isLeaving = false, onTransitionEnd }: { session: RoomSession; candidates: Candidate[]; data: DecisionHistoryData; isLeaving?: boolean; onTransitionEnd?: (event: AnimationEvent<HTMLElement>) => void }) {
  const winnerId = session.room.final_candidate_id ?? data.ladder?.winnerCandidateId ?? data.revotes[data.revotes.length - 1]?.advancingCandidateIds[0] ?? data.evaluations[data.evaluations.length - 1]?.advancingCandidateIds[0];
  const winner = candidates.find((candidate) => candidate.id === winnerId);
  const createdDate = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(session.room.created_at)).replace(/\. /g, ".").replace(/\.$/, "");
  const steps = [
    ...data.evaluations.map((result) => ({ title: result.round === 1 ? "1차 평가 완료" : "전체 후보 재평가 완료", detail: `${result.candidates.length}편 평가 · ${session.members.length}명 참여`, final: false })),
    ...data.revotes.map((revote) => ({ title: revote.round === 1 ? "재투표 완료" : "2차 재투표 완료", detail: `상위 ${revote.candidateIds.length}편 · 1인당 ${revote.selectionCount}편 선택`, final: false })),
    { title: "최종 결정", detail: `${data.ladder?.finalRun ? "사다리타기" : data.revotes.length ? "재투표" : "후보 평가"}${winner ? ` · ${winner.title}${data.ladder?.finalRun ? " 당첨" : ""}` : ""}`, final: true },
  ];
  return (
    <main className={`decision-history-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} aria-label="전체 결정 과정" onAnimationEnd={onTransitionEnd}>
      <header className="evaluation-complete-header"><h1>전체 결정 과정</h1></header>
      <div className="decision-history-scroll-area">
        <section className="decision-history-intro"><h2>우리가 이 작품을 고른 과정</h2><p>후보 평가부터 재투표와 최종 결정까지 모두 남아 있어요.</p></section>
        <section className="decision-room-summary"><strong>{session.room.name}</strong><span>{session.members.length}명 · 후보 {candidates.length}편 · {createdDate}</span></section>
        <section className="decision-timeline"><h2>결정 타임라인</h2><div>{steps.map((step, index) => <article className={step.final ? "is-final" : ""} key={`${step.title}-${index}`}><b>{step.final ? "★" : "✓"}</b><div><strong>{step.title}</strong><span>{step.detail}</span></div></article>)}</div></section>
        {data.evaluations.map((evaluation) => (
          <section className="decision-record-section" key={`evaluation-${evaluation.round}`}>
            <h2>{evaluation.round === 1 ? "1차 평가 · 후보별 기록" : "전체 후보 재평가 · 후보별 기록"}</h2>
            <div className="decision-evaluation-list">{evaluation.candidates.map((result) => {
              const candidate = candidates.find((item) => item.id === result.candidateId);
              if (!candidate) return null;
              const poster = candidate.posterPath ? `https://image.tmdb.org/t/p/w154${candidate.posterPath}` : null;
              const scores = [["보고 싶어요", result.wantCount], ["괜찮아요", result.okayCount], ["싫어요", result.dislikeCount]].filter(([, count]) => Number(count) > 0).map(([label, count]) => `${label} ${count}`).join(" · ");
              return <article className={`evaluation-result-card${candidate.id === winnerId ? " evaluation-result-card--advanced" : ""}`} key={candidate.id}><div className="evaluation-result-work"><div className={`evaluation-result-poster${poster ? "" : " evaluation-result-poster--missing"}`}>{poster ? <img src={poster} alt="" /> : <span>포스터 없음</span>}</div><div><strong>{candidate.title}</strong><span>{scores || "평가 없음"}</span></div></div><div className="evaluation-result-names"><span>보고 싶어요: {result.wantNicknames.join(", ") || "없음"}</span><span>괜찮아요: {result.okayNicknames.join(", ") || "없음"} · 싫어요: {result.dislikeNicknames.join(", ") || "없음"}</span></div></article>;
            })}</div>
          </section>
        ))}
        {data.revotes.map((revote) => {
          const summaries = revote.candidates.map((result) => `${candidates.find((item) => item.id === result.candidateId)?.title ?? "후보"} ${result.voteCount}표`);
          return <section className="decision-record-section decision-revote-section" key={`revote-${revote.round}`}><div className="decision-revote-record"><strong>{revote.round === 1 ? "재투표 결과" : "2차 재투표 결과"}</strong><p>{summaries.slice(0, 2).join(" · ")}<br />{summaries.slice(2).join(" · ")}</p></div></section>;
        })}
        {winner && <section className="decision-record-section decision-final-section"><div className="decision-final-record"><div className={`decision-final-poster${winner.posterPath ? "" : " is-missing"}`}>{winner.posterPath ? <img src={`https://image.tmdb.org/t/p/w154${winner.posterPath}`} alt="" /> : <span>포스터 없음</span>}</div><div><span>최종 당첨 작품</span><strong>{winner.title}</strong><p>{data.ladder?.finalRun ? `사다리타기 ${data.ladder.finalRun === 1 ? "첫 번째" : "마지막"} 결과` : data.revotes.length ? "재투표로 결정" : "후보 평가로 결정"} · {winner.watchProviders.join(" · ") || "OTT 정보 없음"}</p></div></div></section>}
      </div>
    </main>
  );
}

function DecisionHistoryScreen(props: TransitionProps & { session: RoomSession; candidates: Candidate[] }) {
  const [data, setData] = useState<DecisionHistoryData | null>(null);
  useEffect(() => { let active = true; void loadDecisionHistoryData(props.session.room.id).then((loaded) => { if (active) setData(loaded); }).catch((error) => console.error("Failed to load decision history", error)); return () => { active = false; }; }, [props.session.room.id]);
  if (!data) return <main className="decision-history-screen"><header className="evaluation-complete-header"><h1>전체 결정 과정</h1></header></main>;
  return <DecisionHistoryView {...props} data={data} />;
}

type SearchState = "idle" | "loading" | "success" | "empty" | "error";

const MOVIE_GENRES: Record<number, string> = {
  16: "애니메이션",
  18: "드라마",
  27: "공포",
  28: "액션",
  35: "코미디",
  36: "역사",
  53: "스릴러",
  80: "범죄",
  99: "다큐멘터리",
  878: "SF",
  10749: "로맨스",
};

const TV_GENRES: Record<number, string> = {
  16: "애니메이션",
  18: "드라마",
  35: "코미디",
  80: "범죄",
  99: "다큐멘터리",
  9648: "미스터리",
  10759: "액션·모험",
  10764: "리얼리티",
  10765: "SF·판타지",
};

function getTitleMeta(result: SearchTitle) {
  const kind = result.mediaType === "movie" ? "영화" : "TV 프로그램";
  const year = result.releaseDate?.slice(0, 4);
  const genreMap = result.mediaType === "movie" ? MOVIE_GENRES : TV_GENRES;
  const genre = result.genreIds.map((id) => genreMap[id]).find(Boolean);
  return [kind, year, genre].filter(Boolean).join(" · ");
}

function SearchResultItem({
  result,
  onAdd,
  disabled = false,
  duplicateMessage,
}: {
  result: SearchTitle;
  onAdd?: (result: SearchTitle) => void;
  disabled?: boolean;
  duplicateMessage?: string;
}) {
  const posterUrl = result.posterPath
    ? `https://image.tmdb.org/t/p/w154${result.posterPath}`
    : null;
  const watchProviders = result.watchProviders ?? [];
  const visibleProviders = watchProviders.slice(0, 3);
  const remainingProviderCount = watchProviders.length - visibleProviders.length;
  const providerLabel = watchProviders.length
    ? `${visibleProviders.join(" · ")}${remainingProviderCount > 0 ? ` 외 ${remainingProviderCount}곳` : ""}`
    : "볼 수 있는 곳 정보 없음";

  return (
    <article className="search-result-card">
      <div className="search-result-card__content">
        <div className={`search-poster${posterUrl ? "" : " search-poster--missing"}`}>
          {posterUrl && <img src={posterUrl} alt="" loading="lazy" />}
        </div>
        <div className="search-result-info">
          <strong title={result.title}>{result.title}</strong>
          <span>{getTitleMeta(result)}</span>
          <span className={`search-result-source${watchProviders.length ? " search-result-source--available" : ""}`}>
            {providerLabel}
          </span>
          {duplicateMessage && <span className="search-result-inline-message" role="alert">{duplicateMessage}</span>}
        </div>
        <button
          type="button"
          className="search-add-button"
          aria-label={`${result.title} 후보 추가`}
          onClick={() => onAdd?.(result)}
          disabled={disabled || !onAdd}
        >
          추가
        </button>
      </div>
    </article>
  );
}

type SaveState = "idle" | "saving" | "error";

function TitleSearchScreen({
  session,
  isLeaving,
  onTransitionEnd,
  onCandidateAdded,
  onOpenManual,
}: TransitionProps & {
  session: RoomSession;
  onCandidateAdded: (candidate: Candidate) => void;
  onOpenManual: () => void;
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [results, setResults] = useState<SearchTitle[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [selectedResult, setSelectedResult] = useState<SearchTitle | null>(null);
  const [duplicateKey, setDuplicateKey] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const lastRequestedQuery = useRef("");

  const runSearch = useCallback(async (searchQuery: string, force = false) => {
    const cleanQuery = searchQuery.trim();
    if (cleanQuery.length < 2) {
      lastRequestedQuery.current = "";
      setSubmittedQuery("");
      setResults([]);
      setSearchState("idle");
      return;
    }
    if (!force && cleanQuery === lastRequestedQuery.current) return;

    lastRequestedQuery.current = cleanQuery;
    const sequence = ++requestSequence.current;
    setSubmittedQuery(cleanQuery);
    setSearchState("loading");

    try {
      const response = await searchTitles(cleanQuery);
      if (sequence !== requestSequence.current) return;
      const nextResults = response?.results ?? [];
      setResults(nextResults);
      setSearchState(nextResults.length > 0 ? "success" : "empty");
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      console.error("Failed to search titles", error);
      setResults([]);
      setSearchState("error");
    }
  }, []);

  const saveCandidate = async (result: SearchTitle) => {
    setSelectedResult(result);
    setDuplicateKey(null);
    setSaveState("saving");

    try {
      const savedCandidate = await addSearchCandidate(session.room.id, result, session.nickname);
      onCandidateAdded(savedCandidate);
    } catch (error) {
      if (isDuplicateCandidateError(error)) {
        setSaveState("idle");
        setSelectedResult(null);
        setDuplicateKey(`${result.mediaType}-${result.id}`);
        return;
      }
      console.error("Failed to add candidate", error);
      setSaveState("error");
    }
  };

  useEffect(() => {
    const cleanQuery = query.trim();
    if (cleanQuery.length < 2) {
      requestSequence.current += 1;
      lastRequestedQuery.current = "";
      setSubmittedQuery("");
      setResults([]);
      setSearchState("idle");
      return;
    }

    const timeoutId = window.setTimeout(() => runSearch(cleanQuery), 350);
    return () => window.clearTimeout(timeoutId);
  }, [query, runSearch]);

  return (
    <main
      className={`title-search-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`}
      aria-label="작품 검색"
      onAnimationEnd={onTransitionEnd}
    >
      <header className="content-header">
        <p className="header-title">작품 검색</p>
      </header>

      <div className={`title-search-scroll-area${searchState === "empty" || searchState === "error" || saveState === "error" ? " title-search-scroll-area--with-action" : ""}`}>
        <form
          className="title-search-field"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            runSearch(query);
          }}
        >
          <label htmlFor="title-search-input">작품명</label>
          <input
            id="title-search-input"
            className="title-search-input"
            value={query}
            placeholder="검색어를 입력해 주세요"
            autoComplete="off"
            enterKeyHint="search"
            maxLength={80}
            disabled={saveState !== "idle" || searchState === "error"}
            onChange={(event) => setQuery(event.target.value)}
          />
        </form>

        {saveState === "error" && selectedResult && (
          <section className="search-save-flow" aria-live="polite">
            <SearchResultItem result={selectedResult} disabled />
            <div className="search-save-state search-save-state--error">
              <span>문제가 생겼어요</span>
              <h1>후보를 추가하지 못했어요</h1>
              <p>검색 결과는 그대로 두었어요. 다시 시도해 주세요.</p>
            </div>
          </section>
        )}

        {saveState !== "error" && searchState === "idle" && (
          <section className="search-state-card" aria-label="작품 검색 안내">
            <span>작품을 찾아보세요</span>
            <h1>영화와 TV 프로그램을 함께 검색해요</h1>
            <p>사람 검색 결과는 제외하고 작품만 보여드려요.</p>
          </section>
        )}

        {saveState !== "error" && searchState === "loading" && (
          <div className="search-loading" role="status" aria-live="polite">
            <span className="search-spinner" aria-hidden="true" />
            <p>작품을 찾고 있어요</p>
          </div>
        )}

        {saveState !== "error" && searchState === "success" && (
          <section className="search-results" aria-labelledby="search-results-title">
            <h1 id="search-results-title">검색 결과</h1>
            <div className="search-result-list">
              {results.map((result) => (
                <SearchResultItem
                  key={`${result.mediaType}-${result.id}`}
                  result={result}
                  onAdd={saveCandidate}
                  disabled={saveState === "saving"}
                  duplicateMessage={duplicateKey === `${result.mediaType}-${result.id}` ? "이미 추가된 후보예요." : undefined}
                />
              ))}
            </div>
          </section>
        )}

        {saveState !== "error" && searchState === "empty" && (
          <section className="search-feedback-card" role="status">
            <span>검색 결과 없음</span>
            <h1>찾는 작품이 없어요</h1>
            <p>다른 검색어를 입력하거나 직접 등록해 주세요.</p>
          </section>
        )}

        {saveState !== "error" && searchState === "error" && (
          <section className="search-feedback-card search-feedback-card--error" role="alert">
            <span>검색 오류</span>
            <h1>작품을 불러오지 못했어요</h1>
            <p>인터넷 연결을 확인한 뒤 다시 시도해 주세요.</p>
            <button type="button" onClick={onOpenManual}>
              직접 입력하기
            </button>
          </section>
        )}
      </div>

      {searchState === "empty" && saveState !== "error" && (
        <div className="search-save-submit-area">
          <button type="button" className="search-direct-submit-button" onClick={onOpenManual}>
            <span>직접 입력하기</span>
          </button>
        </div>
      )}

      {(saveState === "error" && selectedResult) || searchState === "error" ? (
        <div className="search-save-submit-area">
          <button
            type="button"
            className="search-save-submit-button"
            onClick={() => {
              if (saveState === "error" && selectedResult) {
                saveCandidate(selectedResult);
              } else {
                runSearch(submittedQuery || query, true);
              }
            }}
          >
            <span>다시 시도</span>
          </button>
        </div>
      ) : null}
    </main>
  );
}

function ManualEntryScreen({
  session,
  isLeaving,
  onTransitionEnd,
  onCandidateAdded,
}: TransitionProps & {
  session: RoomSession;
  onCandidateAdded: (candidate: Candidate) => void;
}) {
  const [title, setTitle] = useState("");
  const [overview, setOverview] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [isDuplicate, setIsDuplicate] = useState(false);
  const cleanTitle = title.trim();
  const canSubmit = cleanTitle.length > 0 && cleanTitle.length <= 200;

  const saveManualCandidate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || saveState === "saving") return;

    setSaveState("saving");
    setIsDuplicate(false);

    try {
      const savedCandidate = await addManualCandidate(
        session.room.id,
        cleanTitle,
        overview.trim(),
        session.nickname,
      );
      onCandidateAdded(savedCandidate);
    } catch (error) {
      if (isDuplicateCandidateError(error)) {
        setSaveState("idle");
        setIsDuplicate(true);
        return;
      }
      console.error("Failed to add manual candidate", error);
      setSaveState("error");
    }
  };

  return (
    <main
      className={`manual-entry-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`}
      aria-label="작품 직접 입력"
      onAnimationEnd={onTransitionEnd}
    >
      <header className="content-header">
        <p className="header-title">직접 입력</p>
      </header>

      <form className="manual-entry-form" onSubmit={saveManualCandidate} aria-busy={saveState === "saving"}>
        <div className="manual-entry-scroll-area">
          <div className="manual-field-group">
            <label htmlFor="manual-title">작품 제목</label>
            <input
              id="manual-title"
              value={title}
              placeholder="작품 제목을 입력해 주세요"
              autoComplete="off"
              maxLength={200}
              readOnly={saveState === "saving"}
              onChange={(event) => {
                setTitle(event.target.value);
                setIsDuplicate(false);
                if (saveState === "error") setSaveState("idle");
              }}
            />
          </div>

          <div className="manual-field-group manual-overview-group">
            <label htmlFor="manual-overview">상세 설명</label>
            <input
              id="manual-overview"
              value={overview}
              placeholder="상세 설명 (선택)"
              autoComplete="off"
              readOnly={saveState === "saving"}
              onChange={(event) => {
                setOverview(event.target.value);
                setIsDuplicate(false);
                if (saveState === "error") setSaveState("idle");
              }}
            />
            {saveState !== "error" && (
              <p className={isDuplicate ? "manual-field-message manual-field-message--error" : "manual-field-message"} role={isDuplicate ? "alert" : undefined}>
                {isDuplicate ? "이미 추가된 후보예요." : "예: 만화영화, 마블 거임"}
              </p>
            )}
          </div>

          {saveState === "error" ? (
            <section className="manual-entry-error" role="alert">
              <span>문제가 생겼어요</span>
              <h1>후보를 추가하지 못했어요</h1>
              <p>입력한 내용은 그대로 두었어요. 다시 시도해 주세요.</p>
            </section>
          ) : (
            <section className="manual-entry-notice" aria-label="직접 입력 후보 안내">
              <strong>직접 입력 후보</strong>
              <p>포스터와 볼 수 있는 곳 정보가 없을 수 있어요.</p>
            </section>
          )}
        </div>

        <div className="manual-entry-submit-area">
          <button
            type="submit"
            className="manual-entry-submit-button"
            disabled={!canSubmit || saveState === "saving"}
            data-saving={saveState === "saving"}
          >
            <span>{saveState === "error" ? "다시 시도" : "후보에 추가하기"}</span>
          </button>
        </div>
      </form>
    </main>
  );
}

function InviteScreen({
  view,
  showLoading,
  isLeaving,
  onTransitionEnd,
  onRetry,
  onGoHome,
  onJoin,
}: TransitionProps & {
  view: InviteViewState;
  showLoading: boolean;
  onRetry: () => void;
  onGoHome: () => void;
  onJoin: (nickname: string) => Promise<void>;
}) {
  const [nickname, setNickname] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "joining" | "duplicate" | "error">("idle");
  const cleanNickname = nickname.trim();
  const canSubmit = cleanNickname.length > 0 && cleanNickname.length <= 6 && !/\s/.test(cleanNickname) && submitState !== "joining";

  if (view.kind === "loading") {
    return (
      <main className={`invite-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} onAnimationEnd={onTransitionEnd}>
        <header className="content-header"><p className="header-title">방 참여하기</p></header>
        {showLoading && (
          <section className="invite-loading" aria-live="polite">
            <span aria-hidden="true">•••</span>
            <h1>초대 링크를 확인하고 있어요</h1>
            <p>참여할 수 있는 방인지 살펴보는 중이에요.</p>
          </section>
        )}
      </main>
    );
  }

  if (view.kind !== "ready") {
    const copy = view.kind === "started"
      ? ["참여할 수 없어요", "이미 평가가 시작된 방이에요", "평가가 시작된 뒤에는 새로 들어가거나 관전할 수 없어요."]
      : view.kind === "full"
        ? ["참여할 수 없어요", "참여자가 모두 찼어요", "이 방은 최대 8명까지 참여할 수 있어요."]
        : view.kind === "kicked"
          ? ["참여할 수 없어요", "이 방에 다시 참여할 수 없어요", "방에서 내보내진 참여자는 같은 링크로 다시 들어갈 수 없어요."]
          : view.kind === "network-error"
            ? ["문제가 생겼어요", "방 정보를 불러오지 못했어요", "인터넷 연결을 확인한 뒤 다시 시도해 주세요."]
            : ["링크를 확인해 주세요", "초대 링크를 확인할 수 없어요", "링크가 잘못되었거나 더 이상 사용할 수 없어요."];
    return (
      <main className={`invite-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} onAnimationEnd={onTransitionEnd}>
        <header className="content-header"><p className="header-title">방 참여하기</p></header>
        <section className={`invite-state-card${view.kind === "network-error" || view.kind === "invalid" ? " invite-state-card--error" : ""}`} role="alert">
          <span>{copy[0]}</span><h1>{copy[1]}</h1><p>{copy[2]}</p>
        </section>
        <div className="invite-bottom-action">
          <button type="button" onClick={view.kind === "network-error" ? onRetry : onGoHome}><span>{view.kind === "network-error" ? "다시 시도" : "홈으로 가기"}</span></button>
        </div>
      </main>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitState("joining");
    try {
      await onJoin(cleanNickname);
    } catch (error) {
      if (isRoomServiceError(error, "nickname_duplicate")) setSubmitState("duplicate");
      else setSubmitState("error");
    }
  };

  return (
    <main className={`invite-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`} onAnimationEnd={onTransitionEnd}>
      <header className="content-header"><p className="header-title">방 참여하기</p></header>
      <form className="invite-form" onSubmit={submit} aria-busy={submitState === "joining"}>
        <div className="invite-scroll-area">
          <section className="invite-intro">
            <h1>이 방에서 사용할<br />이름을 알려주세요</h1>
            <p>작품을 올리고, 모두 평가한 뒤 함께 볼 한 편을 정해요.</p>
          </section>
          <section className="invite-summary-card">
            <span>초대받은 선택방</span>
            <strong>{view.invite.room.name}</strong>
            <p>현재 {view.invite.memberCount}명 참여 중 · 최대 8명</p>
          </section>
          <div className={`invite-field-group${submitState === "duplicate" ? " invite-field-group--error" : ""}`}>
            <label htmlFor="invite-nickname">닉네임</label>
            <input
              id="invite-nickname"
              value={nickname}
              maxLength={6}
              autoComplete="off"
              enterKeyHint="done"
              readOnly={submitState === "joining"}
              onChange={(event) => {
                setNickname(event.target.value.replace(/\s/g, "").slice(0, 6));
                setSubmitState("idle");
              }}
            />
            <p>{submitState === "duplicate" ? "이미 이 방에서 사용 중인 닉네임이에요. 다른 이름을 입력해 주세요." : "공백 없이 최대 6자예요. 이 방에서만 보여요."}</p>
          </div>
          {submitState === "error" && (
            <section className="invite-inline-error" role="alert">
              <span>문제가 생겼어요</span><h2>방에 들어가지 못했어요</h2><p>입력한 닉네임은 그대로 두었어요. 다시 시도해 주세요.</p>
            </section>
          )}
        </div>
        <div className="invite-bottom-action">
          <button type="submit" disabled={!canSubmit}><span>{submitState === "error" ? "다시 시도" : "입장하기"}</span></button>
        </div>
      </form>
    </main>
  );
}

function ParticipationEndedScreen({ isLeaving, onTransitionEnd, onGoHome }: TransitionProps & { onGoHome: () => void }) {
  return (
    <main
      className={`participation-ended-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`}
      onAnimationEnd={onTransitionEnd}
    >
      <header className="content-header"><p className="header-title">참여 종료</p></header>
      <section className="invite-state-card participation-ended-card" role="alert">
        <span>참여가 종료됐어요</span>
        <h1>이 방에서 내보내졌어요</h1>
        <p>더 이상 이 방의 후보와 참여자 정보를 볼 수 없어요.</p>
      </section>
      <div className="invite-bottom-action participation-ended-action">
        <button type="button" onClick={onGoHome}><span>홈으로 가기</span></button>
      </div>
    </main>
  );
}

function RoomEndedScreen({ isLeaving, onTransitionEnd, onGoHome }: TransitionProps & { onGoHome: () => void }) {
  return (
    <main
      className={`participation-ended-screen screen-transition${isLeaving ? " screen-transition--exit" : ""}`}
      onAnimationEnd={onTransitionEnd}
    >
      <header className="content-header"><p className="header-title">방 종료</p></header>
      <section className="invite-state-card participation-ended-card" role="alert">
        <span>방이 종료됐어요</span>
        <h1>방장이 이 방을 종료했어요</h1>
        <p>후보와 평가·결정 기록도 함께 삭제됐어요.</p>
      </section>
      <div className="invite-bottom-action participation-ended-action">
        <button type="button" onClick={onGoHome}><span>홈으로 가기</span></button>
      </div>
    </main>
  );
}

function screenForRoomStage(stage: RoomStage): Screen {
  if (stage === "rating") return "evaluation";
  if (stage === "revote_1" || stage === "revote_2") return "revote";
  if (stage === "ladder") return "ladder";
  if (stage === "completed") return "final-result";
  return "candidate-room";
}

function MainApp() {
  const [screen, setScreen] = useState<Screen>("home");
  const [roomSession, setRoomSession] = useState<RoomSession | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [homeLoadState, setHomeLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [inviteView, setInviteView] = useState<InviteViewState | null>(null);
  const [showInviteLoading, setShowInviteLoading] = useState(false);
  const [revoteSetup, setRevoteSetup] = useState<{ round: 1 | 2; candidateIds: string[] } | null>(null);
  const [isLeaving, setIsLeaving] = useState(false);
  const currentScreen = useRef<Screen>("home");
  const transitionInProgress = useRef(false);
  const nextScreen = useRef<Screen | null>(null);
  const activeRoomId = roomSession?.room.id;
  const activeInviteCode = roomSession?.room.invite_code;

  const changeScreen = useCallback((target: Screen) => {
    if (target === currentScreen.current || transitionInProgress.current) return;
    nextScreen.current = target;
    transitionInProgress.current = true;
    setIsLeaving(true);
  }, []);

  const refreshHome = useCallback(async () => {
    setHomeLoadState("loading");
    try {
      setRooms(await loadMyRooms());
      setHomeLoadState("ready");
    } catch (error) {
      console.error("Failed to load rooms", error);
      setHomeLoadState("error");
    }
  }, []);

  const loadInvite = useCallback(async (inviteCode: string) => {
    setInviteView({ kind: "loading", inviteCode });
    setShowInviteLoading(false);
    const loadingTimer = window.setTimeout(() => setShowInviteLoading(true), 600);
    try {
      const invite = await inspectInviteRoom(inviteCode);
      if (invite.status === "already_member") {
        const summary = await loadRoomSummary(invite.room.id);
        const roomCandidates = await loadCandidates(invite.room.id);
        const targetScreen = screenForRoomStage(summary.room.stage);
        setRoomSession(summary);
        setCandidates(roomCandidates);
        currentScreen.current = targetScreen;
        window.history.replaceState({ screen: targetScreen, roomId: invite.room.id }, "", window.location.pathname);
        setScreen(targetScreen);
        return;
      }
      setInviteView(invite.status === "open"
        ? { kind: "ready", inviteCode, invite }
        : { kind: invite.status, inviteCode });
    } catch (error) {
      setInviteView({ kind: isRoomServiceError(error, "invalid_invite") ? "invalid" : "network-error", inviteCode });
    } finally {
      window.clearTimeout(loadingTimer);
      setShowInviteLoading(false);
    }
  }, []);

  useEffect(() => {
    let schemeUrl: string | undefined;
    try {
      schemeUrl = Environment.initialURL;
    } catch {
      // The SDK entry URL is unavailable in a regular browser.
    }
    const inviteCode = getInitialInviteCode(window.location.href, schemeUrl);
    if (inviteCode) {
      currentScreen.current = "invite";
      setScreen("invite");
      window.history.replaceState({ screen: "invite", inviteCode }, "");
      void loadInvite(inviteCode);
    } else {
      window.history.replaceState({ screen: "home" }, "");
      void refreshHome();
    }

    const handleNavigation = (event: PopStateEvent) => {
      const target = event.state?.screen;
      const resolvedTarget = target === "information-source" || target === "create-room" || target === "candidate-room" || target === "room-info" || target === "participation-ended" || target === "room-ended" || target === "title-search" || target === "manual-entry" || target === "invite" || target === "evaluation" || target === "revote-setup" || target === "revote" || target === "ladder" || target === "final-result" || target === "decision-history"
        ? target
        : "home";
      const isRoomInfoOverlayChange = (currentScreen.current === "candidate-room" && resolvedTarget === "room-info")
        || (currentScreen.current === "room-info" && resolvedTarget === "candidate-room");
      if (isRoomInfoOverlayChange) {
        currentScreen.current = resolvedTarget;
        setIsLeaving(false);
        setScreen(resolvedTarget);
        return;
      }
      changeScreen(resolvedTarget);
    };
    window.addEventListener("popstate", handleNavigation);
    return () => window.removeEventListener("popstate", handleNavigation);
  }, [changeScreen, loadInvite, refreshHome]);

  useEffect(() => {
    const roomId = activeRoomId;
    if (!roomId) return;
    const refreshRoom = async () => {
      try {
        const summary = await loadRoomSummary(roomId);
        setRoomSession(summary);
        setRooms((current) => current.map((item) => item.room.id === summary.room.id ? summary : item));
        const targetScreen = screenForRoomStage(summary.room.stage);
        const roomInfoStillAvailable = currentScreen.current === "room-info" && targetScreen === "candidate-room";
        if (targetScreen !== currentScreen.current && !roomInfoStillAvailable) {
          window.history.replaceState({ screen: targetScreen, roomId: summary.room.id }, "");
          changeScreen(targetScreen);
        }
      } catch (error) {
        console.error("Failed to refresh room participants", error);
        if (activeInviteCode) {
          try {
            const access = await inspectInviteRoom(activeInviteCode);
            if (access.status === "kicked") {
              window.history.replaceState({ screen: "participation-ended" }, "", window.location.pathname);
              changeScreen("participation-ended");
            }
          } catch (accessError) {
            if (isRoomServiceError(accessError, "invalid_invite")) {
              setRooms((current) => current.filter((item) => item.room.id !== roomId));
              setCandidates([]);
              window.history.replaceState({ screen: "room-ended" }, "", window.location.pathname);
              changeScreen("room-ended");
            } else {
              console.error("Failed to verify room access", accessError);
            }
          }
        }
      }
    };
    const handleRoomDeleted = (payload: { old: Record<string, unknown> }) => {
      if (payload.old.id !== roomId) return;
      setRooms((current) => current.filter((item) => item.room.id !== roomId));
      setCandidates([]);
      window.history.replaceState({ screen: "room-ended" }, "", window.location.pathname);
      changeScreen("room-ended");
    };
    const channel = supabase
      .channel(`room-participants-${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "room_members", filter: `room_id=eq.${roomId}` }, refreshRoom)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` }, refreshRoom)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` }, handleRoomDeleted)
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [activeInviteCode, activeRoomId, changeScreen]);

  const openCreateRoom = () => {
    window.history.pushState({ screen: "create-room" }, "");
    changeScreen("create-room");
  };

  const openInformationSource = () => {
    window.history.pushState({ screen: "information-source" }, "");
    changeScreen("information-source");
  };

  const finishRoomCreation = (session: RoomSession) => {
    setRoomSession(session);
    setCandidates([]);
    setRooms((current) => [session, ...current.filter((item) => item.room.id !== session.room.id)]);
    window.history.replaceState({ screen: "candidate-room" }, "");
    changeScreen("candidate-room");
  };

  const openRoom = async (summary: RoomSummary) => {
    try {
      const roomCandidates = await loadCandidates(summary.room.id);
      const targetScreen = screenForRoomStage(summary.room.stage);
      setRoomSession(summary);
      setCandidates(roomCandidates);
      window.history.pushState({ screen: targetScreen, roomId: summary.room.id }, "");
      changeScreen(targetScreen);
    } catch (error) {
      console.error("Failed to open room", error);
      setHomeLoadState("error");
    }
  };

  const openCompletedDecisionHistory = async (summary: RoomSummary) => {
    try {
      const roomCandidates = await loadCandidates(summary.room.id);
      setRoomSession(summary);
      setCandidates(roomCandidates);
      window.history.pushState({ screen: "decision-history", roomId: summary.room.id }, "");
      changeScreen("decision-history");
    } catch (error) {
      console.error("Failed to open completed room history", error);
      setHomeLoadState("error");
    }
  };

  const finishCompletedRoomHide = (roomId: string) => {
    setRooms((current) => current.filter((item) => item.room.id !== roomId));
  };

  const openTitleSearch = () => {
    window.history.pushState({ screen: "title-search" }, "");
    changeScreen("title-search");
  };

  const openRoomInfo = () => {
    window.history.pushState({ screen: "room-info", roomId: roomSession?.room.id }, "");
    currentScreen.current = "room-info";
    setIsLeaving(false);
    setScreen("room-info");
  };

  const closeRoomInfo = () => {
    window.history.back();
  };

  const openDecisionHistory = () => {
    window.history.pushState({ screen: "decision-history", roomId: roomSession?.room.id }, "");
    changeScreen("decision-history");
  };

  const openManualEntry = () => {
    window.history.pushState({ screen: "manual-entry" }, "");
    changeScreen("manual-entry");
  };

  const finishCandidateSave = (candidate: Candidate) => {
    setCandidates((current) => {
      if (current.some((item) => item.id === candidate.id)) return current;
      return [...current, candidate];
    });
    setRoomSession((current) => current ? { ...current, candidateCount: current.candidateCount + 1 } : current);
    window.history.replaceState({ screen: "candidate-room" }, "");
    changeScreen("candidate-room");
  };

  const finishCandidateDelete = (candidateId: string) => {
    setCandidates((current) => current.filter((candidate) => candidate.id !== candidateId));
    setRoomSession((current) => current ? { ...current, candidateCount: Math.max(0, current.candidateCount - 1) } : current);
  };

  const finishRoomMemberKick = (result: RoomMembershipActionResult, userId: string) => {
    setRoomSession((current) => current ? {
      ...current,
      room: result.room,
      members: current.members.filter((member) => member.userId !== userId),
    } : current);
    setRooms((current) => current.map((item) => item.room.id === result.room.id ? {
      ...item,
      room: result.room,
      members: item.members.filter((member) => member.userId !== userId),
    } : item));
    window.history.replaceState({ screen: "candidate-room", roomId: result.room.id }, "");
    currentScreen.current = "candidate-room";
    setScreen("candidate-room");
  };

  const finishRoomLeave = () => {
    if (roomSession) setRooms((current) => current.filter((item) => item.room.id !== roomSession.room.id));
    const cleanUrl = new URL(window.location.href);
    cleanUrl.search = "";
    cleanUrl.hash = "";
    window.history.replaceState({ screen: "home" }, "", cleanUrl);
    void refreshHome();
    changeScreen("home");
  };

  const finishRoomDelete = () => {
    if (roomSession) setRooms((current) => current.filter((item) => item.room.id !== roomSession.room.id));
    setCandidates([]);
    const cleanUrl = new URL(window.location.href);
    cleanUrl.search = "";
    cleanUrl.hash = "";
    window.history.replaceState({ screen: "home" }, "", cleanUrl);
    void refreshHome();
    changeScreen("home");
  };

  const finishEvaluationStart = (room: RoomSession["room"]) => {
    setRoomSession((current) => current ? { ...current, room } : current);
    setRooms((current) => current.map((item) => item.room.id === room.id ? { ...item, room } : item));
    window.history.replaceState({ screen: "evaluation", roomId: room.id }, "");
    changeScreen("evaluation");
  };

  const finishResultAdvance = (room: RoomSession["room"]) => {
    const targetScreen = screenForRoomStage(room.stage);
    setRoomSession((current) => current ? { ...current, room } : current);
    setRooms((current) => current.map((item) => item.room.id === room.id ? { ...item, room } : item));
    window.history.replaceState({ screen: targetScreen, roomId: room.id }, "");
    changeScreen(targetScreen);
  };

  const openRevoteSetup = (result: EvaluationResult) => {
    setRevoteSetup({ round: 1, candidateIds: result.advancingCandidateIds });
    window.history.pushState({ screen: "revote-setup", roomId: roomSession?.room.id }, "");
    changeScreen("revote-setup");
  };

  const openSecondRevoteSetup = (result: RevoteRound) => {
    setRevoteSetup({ round: 2, candidateIds: result.advancingCandidateIds });
    window.history.pushState({ screen: "revote-setup", roomId: roomSession?.room.id }, "");
    changeScreen("revote-setup");
  };

  const finishRevoteStart = (round: 1 | 2) => {
    setRoomSession((current) => current ? { ...current, room: { ...current.room, stage: round === 1 ? "revote_1" : "revote_2" } } : current);
    window.history.replaceState({ screen: "revote", roomId: roomSession?.room.id }, "");
    changeScreen("revote");
  };

  const finishInviteJoin = async (nickname: string) => {
    if (!inviteView || inviteView.kind !== "ready") return;
    const joined = await joinRoomByInvite(inviteView.inviteCode, nickname);
    const summary = await loadRoomSummary(joined.room.id);
    const roomCandidates = await loadCandidates(joined.room.id);
    setRoomSession(summary);
    setCandidates(roomCandidates);
    setRooms((current) => [summary, ...current.filter((item) => item.room.id !== summary.room.id)]);
    window.history.replaceState({ screen: "candidate-room", roomId: summary.room.id }, "", window.location.pathname);
    changeScreen("candidate-room");
  };

  const goHome = () => {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.search = "";
    cleanUrl.hash = "";
    window.history.replaceState({ screen: "home" }, "", cleanUrl);
    void refreshHome();
    changeScreen("home");
  };

  const finishTransition = (event: AnimationEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.animationName !== "screen-fade-out") return;
    const target = nextScreen.current;
    if (target) {
      currentScreen.current = target;
      setScreen(target);
      if (target === "home" || target === "participation-ended" || target === "room-ended") setRoomSession(null);
    }
    nextScreen.current = null;
    transitionInProgress.current = false;
    setIsLeaving(false);
  };

  if (screen === "home") {
    return <HomeScreen onCreateRoom={openCreateRoom} onOpenInformationSource={openInformationSource} onOpenRoom={openRoom} onOpenDecisionHistory={openCompletedDecisionHistory} onHideCompletedRoom={finishCompletedRoomHide} rooms={rooms} loadState={homeLoadState} onRetry={refreshHome} isLeaving={isLeaving} onTransitionEnd={finishTransition} />;
  }

  if (screen === "information-source") {
    return <InformationSourceScreen isLeaving={isLeaving} onTransitionEnd={finishTransition} />;
  }

  if (screen === "invite" && inviteView) {
    if (inviteView.kind === "kicked") {
      return <ParticipationEndedScreen isLeaving={isLeaving} onTransitionEnd={finishTransition} onGoHome={goHome} />;
    }
    return (
      <InviteScreen
        view={inviteView}
        showLoading={showInviteLoading}
        isLeaving={isLeaving}
        onTransitionEnd={finishTransition}
        onRetry={() => loadInvite(inviteView.inviteCode)}
        onGoHome={goHome}
        onJoin={finishInviteJoin}
      />
    );
  }

  if ((screen === "candidate-room" || screen === "room-info") && roomSession) {
    return (
      <CandidateRoomScreen
        session={roomSession}
        candidates={candidates}
        isLeaving={isLeaving}
        onTransitionEnd={finishTransition}
        onOpenSearch={openTitleSearch}
        onOpenManual={openManualEntry}
        onOpenRoomInfo={openRoomInfo}
        onCloseRoomInfo={closeRoomInfo}
        onMemberKicked={finishRoomMemberKick}
        onRoomLeft={finishRoomLeave}
        onRoomDeleted={finishRoomDelete}
        onCandidateDeleted={finishCandidateDelete}
        onEvaluationStarted={finishEvaluationStart}
        isRoomInfoOpen={screen === "room-info"}
      />
    );
  }

  if (screen === "participation-ended") {
    return <ParticipationEndedScreen isLeaving={isLeaving} onTransitionEnd={finishTransition} onGoHome={goHome} />;
  }

  if (screen === "room-ended") {
    return <RoomEndedScreen isLeaving={isLeaving} onTransitionEnd={finishTransition} onGoHome={goHome} />;
  }

  if (screen === "evaluation" && roomSession) {
    return (
      <>
        <EvaluationScreen
          session={roomSession}
          candidates={candidates}
          onRoomAdvanced={finishResultAdvance}
          onOpenRevoteSetup={openRevoteSetup}
          isLeaving={isLeaving}
          onTransitionEnd={finishTransition}
        />
        <HostRoomTerminationControl session={roomSession} onRoomDeleted={finishRoomDelete} position="evaluation" />
      </>
    );
  }

  if (screen === "revote-setup" && roomSession && revoteSetup) {
    return (
      <>
        <RevoteSetupScreen
          session={roomSession}
          round={revoteSetup.round}
          candidateIds={revoteSetup.candidateIds}
          candidates={candidates}
          onStarted={finishRevoteStart}
          isLeaving={isLeaving}
          onTransitionEnd={finishTransition}
        />
        <HostRoomTerminationControl session={roomSession} onRoomDeleted={finishRoomDelete} />
      </>
    );
  }

  if (screen === "revote" && roomSession) {
    return (
      <>
        <RevoteScreen
          session={roomSession}
          candidates={candidates}
          onOpenSecondSetup={openSecondRevoteSetup}
          isLeaving={isLeaving}
          onTransitionEnd={finishTransition}
        />
        <HostRoomTerminationControl session={roomSession} onRoomDeleted={finishRoomDelete} />
      </>
    );
  }

  if (screen === "ladder" && roomSession) {
    return (
      <>
        <LadderScreen
          session={roomSession}
          candidates={candidates}
          onRoomAdvanced={finishResultAdvance}
          isLeaving={isLeaving}
          onTransitionEnd={finishTransition}
        />
        <HostRoomTerminationControl session={roomSession} onRoomDeleted={finishRoomDelete} />
      </>
    );
  }

  if (screen === "final-result" && roomSession) {
    return (
      <FinalResultScreen
        session={roomSession}
        candidates={candidates}
        isLeaving={isLeaving}
        onTransitionEnd={finishTransition}
        onCreateRoom={openCreateRoom}
        onOpenHistory={openDecisionHistory}
        onRoomDeleted={finishRoomDelete}
      />
    );
  }

  if (screen === "decision-history" && roomSession) {
    return (
      <>
        <DecisionHistoryScreen session={roomSession} candidates={candidates} isLeaving={isLeaving} onTransitionEnd={finishTransition} />
        <HostRoomTerminationControl session={roomSession} onRoomDeleted={finishRoomDelete} />
      </>
    );
  }

  if (screen === "title-search" && roomSession) {
    return (
      <TitleSearchScreen
        session={roomSession}
        isLeaving={isLeaving}
        onTransitionEnd={finishTransition}
        onCandidateAdded={finishCandidateSave}
        onOpenManual={openManualEntry}
      />
    );
  }

  if (screen === "manual-entry" && roomSession) {
    return (
      <ManualEntryScreen
        session={roomSession}
        isLeaving={isLeaving}
        onTransitionEnd={finishTransition}
        onCandidateAdded={finishCandidateSave}
      />
    );
  }

  return (
    <CreateRoomScreen
      isLeaving={isLeaving}
      onTransitionEnd={finishTransition}
      onRoomCreated={finishRoomCreation}
    />
  );
}

const FINAL_PREVIEW_CANDIDATES: Candidate[] = [
  { id: "final-1", roomId: "preview-room", addedBy: "preview-host", addedByNickname: "민지", source: "tmdb", mediaType: "movie", tmdbId: 157336, title: "인터스텔라", originalTitle: "Interstellar", releaseDate: "2014-11-06", overview: "", posterPath: "/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg", genreIds: [18, 878], watchProviders: ["Netflix", "Watcha"], collectionRound: 1, createdAt: "2026-09-16T10:00:00Z" },
  { id: "final-2", roomId: "preview-room", addedBy: "preview-2", addedByNickname: "준호", source: "tmdb", mediaType: "movie", tmdbId: 496243, title: "기생충", originalTitle: "기생충", releaseDate: "2019-05-30", overview: "", posterPath: "/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg", genreIds: [18, 35], watchProviders: ["Netflix", "Wavve", "Watcha"], collectionRound: 1, createdAt: "2026-09-16T10:01:00Z" },
  { id: "final-3", roomId: "preview-room", addedBy: "preview-3", addedByNickname: "수아", source: "tmdb", mediaType: "movie", tmdbId: 1022789, title: "인사이드 아웃 2", originalTitle: "Inside Out 2", releaseDate: "2024-06-12", overview: "", posterPath: "/vpnVM9B6NMmQpWeZvzLvDESb2QY.jpg", genreIds: [16, 35], watchProviders: ["Disney Plus"], collectionRound: 1, createdAt: "2026-09-16T10:02:00Z" },
  { id: "final-4", roomId: "preview-room", addedBy: "preview-host", addedByNickname: "민지", source: "tmdb", mediaType: "movie", tmdbId: 693134, title: "듄: 파트 2", originalTitle: "Dune: Part Two", releaseDate: "2024-02-28", overview: "", posterPath: "/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg", genreIds: [878, 28], watchProviders: ["Netflix", "TVING"], collectionRound: 1, createdAt: "2026-09-16T10:03:00Z" },
  { id: "final-5", roomId: "preview-room", addedBy: "preview-2", addedByNickname: "준호", source: "manual", mediaType: null, tmdbId: null, title: "헤어질 결심", originalTitle: null, releaseDate: "2022-06-29", overview: "", posterPath: null, genreIds: [], watchProviders: ["Netflix"], collectionRound: 1, createdAt: "2026-09-16T10:04:00Z" },
  { id: "final-6", roomId: "preview-room", addedBy: "preview-3", addedByNickname: "수아", source: "manual", mediaType: null, tmdbId: null, title: "극한직업", originalTitle: null, releaseDate: "2019-01-23", overview: "", posterPath: null, genreIds: [], watchProviders: ["Watcha"], collectionRound: 1, createdAt: "2026-09-16T10:05:00Z" },
];

const FINAL_PREVIEW_SESSION: RoomSession = {
  room: { id: "preview-room", name: "금요일 영화 모임", owner_id: "preview-host", is_auto_name: false, member_count: 3, stage: "completed", evaluation_round: 1, final_candidate_id: "final-4", invite_code: "PREVIEW", created_at: "2026-09-16T10:00:00Z" },
  nickname: "민지",
  userId: "preview-host",
  members: [{ userId: "preview-host", nickname: "민지", role: "host" }, { userId: "preview-2", nickname: "준호", role: "member" }, { userId: "preview-3", nickname: "수아", role: "member" }],
  candidateCount: 6,
  finalCandidate: { title: "듄: 파트 2", posterPath: "/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg" },
  progress: { percent: 100, label: "결정 완료", detail: "최종 작품 결정 완료" },
};

const FINAL_PREVIEW_DATA: DecisionHistoryData = {
  evaluations: [{
    round: 1,
    outcome: "revote",
    advancingCandidateIds: ["final-1", "final-2", "final-4"],
    candidates: FINAL_PREVIEW_CANDIDATES.map((candidate, index) => ({ candidateId: candidate.id, wantCount: index < 3 ? 2 : 1, okayCount: index % 2, dislikeCount: index === 5 ? 2 : 0, wantNicknames: index < 3 ? ["민지", "준호"] : ["수아"], okayNicknames: index % 2 ? ["수아"] : [], dislikeNicknames: index === 5 ? ["민지", "준호"] : [] })),
  }],
  revotes: [{ round: 1, selectionCount: 1, candidateIds: ["final-1", "final-2", "final-4"], outcome: "winner", advancingCandidateIds: ["final-4"], candidates: [{ candidateId: "final-1", voteCount: 1, voterNicknames: ["준호"] }, { candidateId: "final-2", voteCount: 0, voterNicknames: [] }, { candidateId: "final-4", voteCount: 2, voterNicknames: ["민지", "수아"] }] }],
  ladder: null,
};

function FinalResultPreviewFlow() {
  const [view, setView] = useState<"result" | "history">("result");
  if (view === "history") return <DecisionHistoryView session={FINAL_PREVIEW_SESSION} candidates={FINAL_PREVIEW_CANDIDATES} data={FINAL_PREVIEW_DATA} />;
  return <FinalResultView session={FINAL_PREVIEW_SESSION} candidates={FINAL_PREVIEW_CANDIDATES} data={FINAL_PREVIEW_DATA} onCreateRoom={() => undefined} onOpenHistory={() => setView("history")} onRoomDeleted={() => undefined} />;
}

function RoomInfoPreviewScreen() {
  const params = new URLSearchParams(window.location.search);
  const variant = params.get("variant");
  const action = params.get("action");
  const memberCount = variant === "one" ? 1 : 8;
  const members = Array.from({ length: memberCount }, (_, index) => ({
    userId: `preview-${index + 1}`,
    nickname: ["해원", "민지", "다인", "준호", "수아", "지우", "서윤", "도윤"][index],
    role: index === 0 ? "host" as const : "member" as const,
  }));
  const session: RoomSession = {
    room: {
      id: "room-info-preview",
      name: variant === "long" ? "이번 주말에 꼭 함께 보고 싶은 영화와 드라마 모임" : "금요일 밤 영화",
      owner_id: "preview-1",
      is_auto_name: false,
      member_count: memberCount,
      stage: "collecting",
      evaluation_round: 1,
      final_candidate_id: null,
      invite_code: "PREVIEW",
      created_at: "2026-09-15T10:00:00Z",
    },
    nickname: variant === "member" ? "민지" : "해원",
    userId: variant === "member" ? "preview-2" : "preview-1",
    members,
    candidateCount: 0,
    finalCandidate: null,
    progress: { percent: 10, label: "후보 모으는 중", detail: "후보 모으는 중" },
  };
  const initialMembershipAction: MembershipAction | null = action?.startsWith("kick-")
    ? { kind: "kick", target: members[1], state: action.slice(5) as "confirm" | "submitting" | "error" }
    : action?.startsWith("leave-")
      ? { kind: "leave", state: action.slice(6) as "confirm" | "submitting" | "error" }
      : action?.startsWith("delete-room-")
        ? { kind: "delete-room", state: action.slice(12) as "confirm" | "submitting" | "error" }
      : null;

  return (
    <CandidateRoomScreen
      session={session}
      candidates={[]}
      isLeaving={false}
      onTransitionEnd={() => undefined}
      onOpenSearch={() => undefined}
      onOpenManual={() => undefined}
      onOpenRoomInfo={() => undefined}
      onCloseRoomInfo={() => undefined}
      onMemberKicked={() => undefined}
      onRoomLeft={() => undefined}
      onRoomDeleted={() => undefined}
      onCandidateDeleted={() => undefined}
      onEvaluationStarted={() => undefined}
      isRoomInfoOpen={!action}
      initialMembershipAction={initialMembershipAction}
    />
  );
}

function HomeCompletedPreviewScreen() {
  const params = new URLSearchParams(window.location.search);
  const variant = params.get("variant");
  const action = params.get("action") as "menu" | "delete-confirm" | "delete-deleting" | "delete-error" | "deleted" | null;
  const count = variant === "many" ? 6 : 1;
  const completedRooms = Array.from({ length: count }, (_, index): RoomSummary => ({
    ...FINAL_PREVIEW_SESSION,
    room: {
      ...FINAL_PREVIEW_SESSION.room,
      id: `completed-preview-${index}`,
      name: variant === "long" && index === 0
        ? "이번 주말에 꼭 함께 보고 싶은 영화와 드라마를 고르는 아주 긴 모임 이름"
        : ["친구들과 영화 보기", "토요일 밤 정주행", "비 오는 날의 영화", "퇴근 후 한 편", "주말 드라마 모임", "우리 집 영화관"][index],
      created_at: new Date(Date.UTC(2026, 8, 7 - index)).toISOString(),
    },
    finalCandidate: index === 1
      ? { title: "직접 입력한 아주 길고 긴 작품 제목이 한 줄에서 자연스럽게 줄어드는지 확인", posterPath: null }
      : FINAL_PREVIEW_SESSION.finalCandidate,
  }));
  return <HomeScreen onCreateRoom={() => undefined} onOpenInformationSource={() => undefined} onOpenRoom={() => undefined} onOpenDecisionHistory={() => undefined} onHideCompletedRoom={() => undefined} rooms={action === "deleted" ? [] : completedRooms} loadState="ready" onRetry={() => undefined} isLeaving={false} onTransitionEnd={() => undefined} previewAction={action ?? undefined} />;
}

function App() {
  const preview = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("preview")
    : null;
  if (preview === "ladder6") return <LadderPreviewScreen />;
  if (preview === "evaluation") return <EvaluationPreviewScreen />;
  if (preview === "final-result") return <FinalResultPreviewFlow />;
  if (preview === "room-info") return <RoomInfoPreviewScreen />;
  if (preview === "home-completed") return <HomeCompletedPreviewScreen />;
  if (preview === "information-source") return <InformationSourceScreen isLeaving={false} onTransitionEnd={() => undefined} />;
  if (preview === "participation-ended") return <ParticipationEndedScreen isLeaving={false} onTransitionEnd={() => undefined} onGoHome={() => undefined} />;
  return <MainApp />;
}

export default App;
