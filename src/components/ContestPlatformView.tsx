import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Trophy,
  Timer,
  Lock,
  Play,
  Plus,
  Users,
  Calendar,
  Clock,
  CheckCircle2,
  XCircle,
  Volume2,
  ShieldAlert,
  Sparkles,
  LogIn,
  Trash2,
  Eye,
  ArrowLeft,
  Award,
  Check,
  Flame,
  RefreshCw,
} from 'lucide-react';
import { CATEGORIES, type WordItem } from '../data/words';
import {
  type CloudRecording,
  type SessionWordResult,
} from '../services/recordingsService';
import {
  type ContestRecord,
  type ContestSubmissionRecord,
  type ContestAttemptLockedWord,
  createScheduledContest,
  deleteOrCancelContest,
  registerForContest,
  markContestAttemptInProgress,
  submitContestExamResult,
  deriveContestWordDeck,
  getContestCandidatePool,
  getContestPhase,
  getContestEndTimeMs,
  getLiveContestTimeline,
  getDeviceContestLock,
  saveDeviceContestCheckpoint,
  syncContestsNow,
} from '../services/contestService';
import { playWordAudio } from '../utils/audioUtils';
import { NoSuggestSpellingInput } from './NoSuggestSpellingInput';
import { signInStudentWithUniqueId, type User } from '../firebase';

interface ContestPlatformViewProps {
  user: User | null;
  isAdmin: boolean;
  onRequestSignIn: () => void;
  recordingsMap: Record<string, CloudRecording>;
  contests: ContestRecord[];
  submissions: ContestSubmissionRecord[];
  onBackToPractice: () => void;
  onSyncContests?: (
    contests: ContestRecord[],
    submissions: ContestSubmissionRecord[]
  ) => void;
}

const SPELLING_ALTERNATIVE_GROUPS: string[][] = [
  ['colour', 'color'],
  ['grey', 'gray'],
  ['aluminum', 'aluminium'],
  ['fiberglass', 'fibreglass'],
  ['dialog', 'dialogue'],
  ['encyclopedia', 'encyclopaedia'],
  ['theatre', 'theater'],
  ['centre', 'center'],
  ['computer centre', 'computer center'],
  ['fulfilment', 'fulfillment'],
  ['personal fulfilment', 'personal fulfillment'],
  ['driving licence', 'driving license'],
  ['fund-raising event', 'fundraising event'],
];

function normalizeSpelling(s: string): string {
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑–—]/g, '-')
    .trim()
    .replace(/\s+/g, ' ');
}

function checkSpellingCorrect(answer: string, targetWord: string): boolean {
  const normAns = normalizeSpelling(answer);
  if (!normAns) return false;
  const normTarget = normalizeSpelling(targetWord);
  const slashAlternatives = normTarget.split(/\s*\/\s*/);
  const group = SPELLING_ALTERNATIVE_GROUPS.find((g) => g.includes(normTarget));
  const accepted = group || slashAlternatives;
  return accepted.includes(normAns);
}

function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return '00:00';
  const totalSeconds = Math.ceil(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(
      seconds
    ).padStart(2, '0')}s`;
  }
  return `${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(
    2,
    '0'
  )}s`;
}

function formatDurationMs(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function toLocalDateTimeInputValue(timestampMs: number): string {
  const d = new Date(timestampMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export const ContestPlatformView: React.FC<ContestPlatformViewProps> = ({
  user,
  isAdmin,
  onRequestSignIn,
  recordingsMap,
  contests,
  submissions,
  onBackToPractice,
  onSyncContests,
}) => {
  // Real-time 1-second clock so scheduled contests automatically unlock at the exact second
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [isSyncingCloud, setIsSyncingCloud] = useState<boolean>(false);

  const handleManualSync = useCallback(async () => {
    setIsSyncingCloud(true);
    try {
      const { contests: c, submissions: s } = await syncContestsNow();
      onSyncContests?.(c, s);
    } finally {
      setTimeout(() => setIsSyncingCloud(false), 350);
    }
  }, [onSyncContests]);

  useEffect(() => {
    void handleManualSync();
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [handleManualSync]);

  const [activeTab, setActiveTab] = useState<'contests' | 'create'>(() => {
    try {
      const saved = localStorage.getItem('lw_contest_view_state_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.activeTab === 'create') return 'create';
      }
    } catch {
      // ignore
    }
    return 'contests';
  });
  const [selectedContestId, setSelectedContestId] = useState<string | null>(
    () => {
      try {
        const saved = localStorage.getItem('lw_contest_view_state_v1');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (typeof parsed?.selectedContestId === 'string') {
            return parsed.selectedContestId;
          }
        }
      } catch {
        // ignore
      }
      return null;
    }
  );
  const [autoStartWhenLive, setAutoStartWhenLive] = useState<boolean>(true);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(
        'lw_contest_view_state_v1',
        JSON.stringify({ activeTab, selectedContestId })
      );
    } catch {
      // ignore
    }
  }, [activeTab, selectedContestId]);

  // Create Contest Form State
  const [participantNameInput, setParticipantNameInput] = useState<string>(
    () => user?.displayName || ''
  );
  const [titleInput, setTitleInput] = useState<string>(
    'IELTS Live Spelling Contest'
  );
  const [pageFilter, setPageFilter] = useState<'page1' | 'page2' | 'all'>(
    'page1'
  );
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [wordCountPreset, setWordCountPreset] = useState<
    10 | 15 | 20 | 30 | 50 | 'custom'
  >(15);
  const [customWordCount, setCustomWordCount] = useState<string>('20');
  const [baseSeconds, setBaseSeconds] = useState<number>(12);
  const [showBangla, setShowBangla] = useState<boolean>(true);
  const [startPresetMins, setStartPresetMins] = useState<
    0 | 1 | 2 | 5 | 15 | 30 | 'custom'
  >(2);
  const [customStartDateTime, setCustomStartDateTime] = useState<string>(() =>
    toLocalDateTimeInputValue(Date.now() + 5 * 60 * 1000)
  );
  const [durationMinutes, setDurationMinutes] = useState<number>(30);
  const [isCreating, setIsCreating] = useState<boolean>(false);

  // Active Running Contest Exam State (Synchronized Global Clock + Anti-Cheat Lock)
  const [runningContest, setRunningContest] = useState<ContestRecord | null>(
    null
  );
  const [contestDeck, setContestDeck] = useState<WordItem[]>([]);
  const [examIndex, setExamIndex] = useState<number>(0);
  const [examInput, setExamInput] = useState<string>('');
  const [lockedWordsMap, setLockedWordsMap] = useState<
    Record<number, ContestAttemptLockedWord>
  >({});
  const [tabSwitchCount, setTabSwitchCount] = useState<number>(0);
  const [proctorAlertText, setProctorAlertText] = useState<string | null>(null);
  const [confirmEarlyForfeit, setConfirmEarlyForfeit] =
    useState<boolean>(false);
  const [examRemainingMs, setExamRemainingMs] = useState<number>(12000);
  const [examTotalMs, setExamTotalMs] = useState<number>(12000);
  const [examPlayCount, setExamPlayCount] = useState<number>(0);
  const [examStartedAtMs, setExamStartedAtMs] = useState<number>(0);
  const [isSubmittingResult, setIsSubmittingResult] = useState<boolean>(false);

  const examInputRef = useRef<HTMLInputElement>(null);
  const latestExamInputRef = useRef<string>('');
  latestExamInputRef.current = examInput;
  const lockedWordsMapRef = useRef<Record<number, ContestAttemptLockedWord>>(
    {}
  );
  lockedWordsMapRef.current = lockedWordsMap;
  const tabSwitchCountRef = useRef<number>(0);
  tabSwitchCountRef.current = tabSwitchCount;
  const prevSlotIndexRef = useRef<number>(0);
  const isFinalizingRef = useRef<boolean>(false);

  // Candidate pool for the Create Contest form
  const candidatePool = useMemo(
    () => getContestCandidatePool(pageFilter, selectedCategories),
    [pageFilter, selectedCategories]
  );

  // Select first contest by default if none selected
  const selectedContest = useMemo(() => {
    if (selectedContestId) {
      const found = contests.find((c) => c.id === selectedContestId);
      if (found) return found;
    }
    return contests[0] || null;
  }, [contests, selectedContestId]);

  const currentUserIdSanitized = useMemo(
    () => (user?.uid || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120),
    [user]
  );

  const handleRemoveContest = useCallback(
    async (contest: ContestRecord, e?: React.MouseEvent) => {
      if (e) {
        e.stopPropagation();
      }
      await deleteOrCancelContest(contest.id);
      const remainingContests = contests.filter((c) => c.id !== contest.id);
      const remainingSubs = submissions.filter(
        (s) => s.contestId !== contest.id
      );
      onSyncContests?.(remainingContests, remainingSubs);
      if (selectedContestId === contest.id) {
        setSelectedContestId(remainingContests[0]?.id || null);
      }
      setStatusMessage({
        type: 'success',
        text: `Removed contest "${contest.title}".`,
      });
    },
    [contests, submissions, onSyncContests, selectedContestId]
  );

  // Submissions grouped by contestId
  const submissionsByContest = useMemo(() => {
    const map: Record<string, ContestSubmissionRecord[]> = {};
    for (const sub of submissions) {
      if (!map[sub.contestId]) map[sub.contestId] = [];
      map[sub.contestId].push(sub);
    }
    // Sort each contest's leaderboard:
    // 1. 'completed' before 'in_progress' / 'registered'
    // 2. Higher correctCount first
    // 3. Faster active typing timeTakenMs first (tie-breaker!)
    for (const cid of Object.keys(map)) {
      map[cid].sort((a, b) => {
        const aDone = a.status === 'completed' ? 1 : 0;
        const bDone = b.status === 'completed' ? 1 : 0;
        if (aDone !== bDone) return bDone - aDone;
        if (b.correctCount !== a.correctCount) {
          return b.correctCount - a.correctCount;
        }
        const aTime = a.timeTakenMs || 999999999;
        const bTime = b.timeTakenMs || 999999999;
        return aTime - bTime;
      });
    }
    return map;
  }, [submissions]);

  const recordingsMapRef = useRef(recordingsMap);
  recordingsMapRef.current = recordingsMap;
  const submissionsByContestRef = useRef(submissionsByContest);
  submissionsByContestRef.current = submissionsByContest;

  const mySubmissionForSelected = useMemo(() => {
    if (!selectedContest || !currentUserIdSanitized) return undefined;
    const list = submissionsByContest[selectedContest.id] || [];
    return list.find((s) => s.userId === currentUserIdSanitized);
  }, [selectedContest, submissionsByContest, currentUserIdSanitized]);

  // Keep participantNameInput synced when user changes
  useEffect(() => {
    if (user?.displayName) {
      setParticipantNameInput(user.displayName);
    }
  }, [user?.uid, user?.displayName]);

  const ensureSignedInForContest = useCallback(
    async (
      forceNewStudentId = false,
      targetContestId?: string
    ): Promise<User | null> => {
      // Anti-Cheat Device Lock: Once this browser/device has entered or completed a specific contest,
      // block creating a second student ID or switching names to retake the same contest!
      const cidToCheck = targetContestId || selectedContest?.id;
      if (cidToCheck) {
        const deviceLock = getDeviceContestLock(cidToCheck);
        if (
          deviceLock &&
          (deviceLock.status === 'in_progress' ||
            deviceLock.status === 'completed')
        ) {
          if (forceNewStudentId) {
            setStatusMessage({
              type: 'error',
              text: `Anti-Cheat Device Lock: This device is already locked to "${deviceLock.userName}" for this contest (1 attempt per device).`,
            });
            return user;
          }
          if (user) {
            setParticipantNameInput(user.displayName || deviceLock.userName);
            return user;
          }
        }
      }

      const stripTag = (s: string) =>
        s.replace(/\s*\(?#[A-Z0-9]{3,6}\)?$/i, '').trim().toLowerCase();

      const typedName = participantNameInput.trim();
      const currentBaseName = user?.displayName
        ? stripTag(user.displayName)
        : '';
      const typedBaseName = typedName ? stripTag(typedName) : '';

      if (
        !user ||
        forceNewStudentId ||
        (typedBaseName &&
          typedBaseName !== currentBaseName &&
          !user.isVerifiedAdmin)
      ) {
        const createdProfile = await signInStudentWithUniqueId(typedName);
        setParticipantNameInput(createdProfile.displayName || '');
        return createdProfile;
      }

      return user;
    },
    [user, participantNameInput, selectedContest?.id]
  );

  // Finalize and submit the synchronized contest exam (either when the global timer ends or on explicit forfeit)
  const finalizeAndSubmitContestExam = useCallback(
    async (
      contest: ContestRecord,
      deck: WordItem[],
      finalLockedMap: Record<number, ContestAttemptLockedWord>,
      startedAtWallMs: number
    ) => {
      if (isFinalizingRef.current) return;
      isFinalizingRef.current = true;
      setIsSubmittingResult(true);

      const timeline = getLiveContestTimeline(
        contest,
        Math.max(Date.now(), contest.startTimeMs + 1000)
      );
      const compiledResults: SessionWordResult[] = [];
      let totalActiveTypingTimeMs = 0;

      for (let i = 0; i < deck.length; i++) {
        const w = deck[i];
        const rec = recordingsMapRef.current[w.id];
        const lockedEntry = finalLockedMap[i];
        const slotDurMs =
          timeline.slots[i]?.durationMs || contest.baseSeconds * 1000;
        const cleanTyped = (lockedEntry?.userAnswer || '').trim();
        const isCorrect = checkSpellingCorrect(cleanTyped, w.word);
        const wordTimeMs = lockedEntry
          ? Math.max(400, Math.min(slotDurMs, lockedEntry.lockedAfterMs))
          : slotDurMs;
        totalActiveTypingTimeMs += wordTimeMs;

        compiledResults.push({
          wordId: w.id,
          word: w.word,
          userAnswer: cleanTyped,
          isCorrect,
          bangla: rec?.banglaMeaning || w.bangla,
          category: w.category,
          page: w.page,
        });
      }

      const correctTotal = compiledResults.filter((a) => a.isCorrect).length;
      const existingSub = (
        submissionsByContestRef.current[contest.id] || []
      ).find((s) => s.userId === currentUserIdSanitized);

      // Permanently mark device lock as 'completed' so this browser/device can never re-enter
      saveDeviceContestCheckpoint({
        contestId: contest.id,
        userId: currentUserIdSanitized || 'user',
        userName: user?.displayName || participantNameInput || 'Participant',
        status: 'completed',
        lockedWords: finalLockedMap,
        tabSwitchCount: tabSwitchCountRef.current,
        startedAtMs: startedAtWallMs || contest.startTimeMs,
        updatedAtMs: Date.now(),
      });

      try {
        await submitContestExamResult({
          contest,
          totalWords: compiledResults.length,
          correctCount: correctTotal,
          timeTakenMs: Math.max(1000, Math.round(totalActiveTypingTimeMs)),
          results: compiledResults,
          existingSubmission: existingSub,
        });
        setSelectedContestId(contest.id);
        setRunningContest(null);
        setConfirmEarlyForfeit(false);
        setStatusMessage({
          type: 'success',
          text: `Contest completed & locked! You scored ${correctTotal}/${compiledResults.length} (Active typing time: ${formatDurationMs(
            totalActiveTypingTimeMs
          )}). Official words unlock when the contest timer finishes for everyone.`,
        });
      } catch (err) {
        setRunningContest(null);
        setConfirmEarlyForfeit(false);
        setStatusMessage({
          type: 'error',
          text:
            err instanceof Error
              ? err.message
              : 'Submitted locally; cloud sync will retry automatically.',
        });
      } finally {
        setIsSubmittingResult(false);
        isFinalizingRef.current = false;
      }
    },
    [currentUserIdSanitized, user?.displayName, participantNameInput]
  );

  const isStartingExamRef = useRef<boolean>(false);
  const waitingLobbyContestIdRef = useRef<string | null>(null);

  // Launch or Resume the strict synchronized contest exam
  const handleStartLiveContestExam = useCallback(
    async (contest: ContestRecord) => {
      if (isStartingExamRef.current) return;
      isStartingExamRef.current = true;
      try {
        const existingDeviceLock = getDeviceContestLock(contest.id);
        if (existingDeviceLock?.status === 'completed') {
          setStatusMessage({
            type: 'error',
            text: `Anti-Cheat Lock: This device has already completed and submitted "${contest.title}" (${existingDeviceLock.userName}). Re-entry is blocked.`,
          });
          return;
        }

        const activeUser = await ensureSignedInForContest(false, contest.id);
        if (!activeUser) {
          onRequestSignIn();
          return;
        }
        const activeUserIdSanitized = activeUser.uid
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 120);
        const nowWall = Date.now();
        const phase = getContestPhase(contest, nowWall);
        if (phase === 'upcoming') {
          setStatusMessage({
            type: 'error',
            text: 'This contest has not started yet! Wait for the countdown to reach 00:00.',
          });
          return;
        }
        if (phase !== 'live') {
          setStatusMessage({
            type: 'error',
            text: 'This contest has already ended simultaneously for all participants.',
          });
          return;
        }

        const existingSub = (
          submissionsByContestRef.current[contest.id] || []
        ).find((s) => s.userId === activeUserIdSanitized);
        if (existingSub?.status === 'completed') {
          setStatusMessage({
            type: 'error',
            text: 'You have already completed and submitted this contest exam! Only 1 attempt is permitted.',
          });
          return;
        }

        const timeline = getLiveContestTimeline(contest, nowWall);
        if (timeline.slots.length === 0 || timeline.isFinished) {
          setStatusMessage({
            type: 'error',
            text: 'This contest broadcast has just finished.',
          });
          return;
        }

        // Restore any existing in_progress checkpoint from this device so backing out / refreshing NEVER restarts from Word 1
        const restoredLocks: Record<number, ContestAttemptLockedWord> = {
          ...(existingDeviceLock?.lockedWords || {}),
        };
        // Any earlier word slot (0 .. activeSlotIndex - 1) that already passed on the global clock while the user was away or late
        // is permanently locked as missed so nobody can ever go back to earlier words!
        for (let i = 0; i < timeline.activeSlotIndex; i++) {
          if (!restoredLocks[i]) {
            restoredLocks[i] = {
              userAnswer: '',
              lockedAfterMs: timeline.slots[i].durationMs,
              lockedAtWallMs: nowWall,
              missedWhileAway: true,
            };
          }
        }

        const initialStartedAt = existingDeviceLock?.startedAtMs || nowWall;
        const initialTabSwitches = existingDeviceLock?.tabSwitchCount || 0;

        saveDeviceContestCheckpoint({
          contestId: contest.id,
          userId: activeUserIdSanitized,
          userName: activeUser.displayName || 'Participant',
          status: 'in_progress',
          lockedWords: restoredLocks,
          tabSwitchCount: initialTabSwitches,
          startedAtMs: initialStartedAt,
          updatedAtMs: nowWall,
        });

        void markContestAttemptInProgress({
          contest,
          existingSubmission: existingSub,
        });

        const activeSlot = timeline.slots[timeline.activeSlotIndex];
        isFinalizingRef.current = false;
        prevSlotIndexRef.current = timeline.activeSlotIndex;
        setContestDeck(timeline.slots.map((s) => s.word));
        setLockedWordsMap(restoredLocks);
        lockedWordsMapRef.current = restoredLocks;
        setTabSwitchCount(initialTabSwitches);
        tabSwitchCountRef.current = initialTabSwitches;
        setProctorAlertText(null);
        setConfirmEarlyForfeit(false);
        setExamIndex(timeline.activeSlotIndex);
        const currentLocked = restoredLocks[timeline.activeSlotIndex];
        setExamInput(currentLocked ? currentLocked.userAnswer : '');
        latestExamInputRef.current = currentLocked
          ? currentLocked.userAnswer
          : '';
        setExamTotalMs(activeSlot.durationMs);
        setExamRemainingMs(Math.max(0, activeSlot.endMs - nowWall));
        setExamStartedAtMs(initialStartedAt);
        setRunningContest(contest);
      } finally {
        isStartingExamRef.current = false;
      }
    },
    [ensureSignedInForContest, onRequestSignIn]
  );

  // Auto-launch exam if the user registered for the selected contest, is waiting in the lobby,
  // OR had an in-progress attempt on this device and reloaded the page while the contest is LIVE
  useEffect(() => {
    if (!selectedContest || runningContest || activeTab !== 'contests') {
      return;
    }
    const phase = getContestPhase(selectedContest, nowMs);
    if (phase === 'upcoming') {
      waitingLobbyContestIdRef.current = selectedContest.id;
      return;
    }
    if (phase !== 'live') return;

    const deviceLock = getDeviceContestLock(selectedContest.id);
    if (deviceLock?.status === 'completed' || mySubmissionForSelected?.status === 'completed') {
      return;
    }

    if (deviceLock?.status === 'in_progress') {
      void handleStartLiveContestExam(selectedContest);
      return;
    }

    const wasWaitingInLobby =
      waitingLobbyContestIdRef.current === selectedContest.id;
    const isRegistered = mySubmissionForSelected?.status === 'registered';

    if (
      autoStartWhenLive &&
      (wasWaitingInLobby ||
        (isRegistered && nowMs - selectedContest.startTimeMs < 30000))
    ) {
      waitingLobbyContestIdRef.current = null;
      void handleStartLiveContestExam(selectedContest);
    }
  }, [
    nowMs,
    autoStartWhenLive,
    selectedContest,
    runningContest,
    activeTab,
    mySubmissionForSelected,
    handleStartLiveContestExam,
  ]);

  // Lock the user's answer for a specific word slot WITHOUT advancing early (so everyone stays on the exact same word)
  const lockWordAnswerAtSlot = useCallback(
    (
      slotIdx: number,
      typedValue: string,
      options?: { autoLockedByTabSwitch?: boolean }
    ) => {
      if (!runningContest) return;
      if (lockedWordsMapRef.current[slotIdx]) {
        // Already locked for this word! Cannot be unlocked or modified.
        return;
      }

      const nowWall = Date.now();
      const timeline = getLiveContestTimeline(runningContest, nowWall);
      const slot = timeline.slots[slotIdx];
      const elapsedInSlotMs = slot
        ? Math.max(400, Math.min(slot.durationMs, nowWall - slot.startMs))
        : runningContest.baseSeconds * 1000;

      const entry: ContestAttemptLockedWord = {
        userAnswer: typedValue.trim(),
        lockedAfterMs: elapsedInSlotMs,
        lockedAtWallMs: nowWall,
        autoLockedByTabSwitch: options?.autoLockedByTabSwitch,
      };

      const nextMap: Record<number, ContestAttemptLockedWord> = {
        ...lockedWordsMapRef.current,
        [slotIdx]: entry,
      };
      lockedWordsMapRef.current = nextMap;
      setLockedWordsMap(nextMap);

      saveDeviceContestCheckpoint({
        contestId: runningContest.id,
        userId: currentUserIdSanitized || 'user',
        userName: user?.displayName || participantNameInput || 'Participant',
        status: 'in_progress',
        lockedWords: nextMap,
        tabSwitchCount: tabSwitchCountRef.current,
        startedAtMs: examStartedAtMs || runningContest.startTimeMs,
        updatedAtMs: nowWall,
      });

      // Compute partial score so live leaderboard shows real-time progress
      let partialCorrect = 0;
      let partialTimeMs = 0;
      for (const [k, v] of Object.entries(nextMap)) {
        const w = contestDeck[Number(k)];
        if (w && checkSpellingCorrect(v.userAnswer, w.word)) {
          partialCorrect++;
        }
        partialTimeMs += v.lockedAfterMs;
      }
      const existingSub = (
        submissionsByContestRef.current[runningContest.id] || []
      ).find((s) => s.userId === currentUserIdSanitized);
      void markContestAttemptInProgress({
        contest: runningContest,
        existingSubmission: existingSub,
        correctCountSoFar: partialCorrect,
        timeTakenMsSoFar: partialTimeMs,
      });
    },
    [
      runningContest,
      currentUserIdSanitized,
      user?.displayName,
      participantNameInput,
      examStartedAtMs,
      contestDeck,
    ]
  );

  // Global Synchronized Contest Clock Driver:
  // Keeps every participant on the exact same word at the exact same millisecond,
  // auto-locks any unlocked answer when a word's timer expires, and ends the contest simultaneously for everyone!
  useEffect(() => {
    if (!runningContest || contestDeck.length === 0) return;

    const tickSynchronizedClock = () => {
      const wallNow = Date.now();
      const timeline = getLiveContestTimeline(runningContest, wallNow);

      // If any previous slot (<= timeline.activeSlotIndex - 1, or all slots if finished) was not locked yet,
      // auto-lock it now with whatever was typed on the active slot!
      const prevIdx = prevSlotIndexRef.current;
      if (timeline.isFinished) {
        const finalMap: Record<number, ContestAttemptLockedWord> = {
          ...lockedWordsMapRef.current,
        };
        if (!finalMap[prevIdx]) {
          const prevSlot = timeline.slots[prevIdx];
          finalMap[prevIdx] = {
            userAnswer: latestExamInputRef.current.trim(),
            lockedAfterMs:
              prevSlot?.durationMs || runningContest.baseSeconds * 1000,
            lockedAtWallMs: wallNow,
          };
        }
        for (let i = 0; i < timeline.slots.length; i++) {
          if (!finalMap[i]) {
            finalMap[i] = {
              userAnswer: '',
              lockedAfterMs: timeline.slots[i].durationMs,
              lockedAtWallMs: wallNow,
              missedWhileAway: true,
            };
          }
        }
        lockedWordsMapRef.current = finalMap;
        setLockedWordsMap(finalMap);
        void finalizeAndSubmitContestExam(
          runningContest,
          contestDeck,
          finalMap,
          examStartedAtMs
        );
        return;
      }

      if (timeline.activeSlotIndex !== prevIdx) {
        // Auto-lock the word that just finished!
        if (!lockedWordsMapRef.current[prevIdx]) {
          lockWordAnswerAtSlot(prevIdx, latestExamInputRef.current);
        }
        // Also mark any intermediate skipped slots if the tab was frozen
        for (let i = prevIdx + 1; i < timeline.activeSlotIndex; i++) {
          if (!lockedWordsMapRef.current[i]) {
            lockWordAnswerAtSlot(i, '');
          }
        }
        prevSlotIndexRef.current = timeline.activeSlotIndex;
        setExamIndex(timeline.activeSlotIndex);
        const alreadyLockedForNew =
          lockedWordsMapRef.current[timeline.activeSlotIndex];
        const nextVal = alreadyLockedForNew
          ? alreadyLockedForNew.userAnswer
          : '';
        setExamInput(nextVal);
        latestExamInputRef.current = nextVal;
      }

      const activeSlot = timeline.slots[timeline.activeSlotIndex];
      if (activeSlot) {
        setExamTotalMs(activeSlot.durationMs);
        setExamRemainingMs(Math.max(0, activeSlot.endMs - wallNow));
      }
    };

    tickSynchronizedClock();
    const intervalId = window.setInterval(tickSynchronizedClock, 80);
    return () => window.clearInterval(intervalId);
  }, [
    runningContest,
    contestDeck,
    examStartedAtMs,
    lockWordAnswerAtSlot,
    finalizeAndSubmitContestExam,
  ]);

  // Schedule 3 automatic audio plays synchronized to the current word slot
  useEffect(() => {
    if (!runningContest) return;
    const wordObj = contestDeck[examIndex];
    if (!wordObj) return;

    const wallNow = Date.now();
    const timeline = getLiveContestTimeline(runningContest, wallNow);
    const slot = timeline.slots[examIndex];
    if (!slot) return;

    const elapsedInSlotMs = Math.max(0, wallNow - slot.startMs);

    setExamPlayCount(0);
    setTimeout(() => {
      examInputRef.current?.focus();
    }, 60);

    let cancelled = false;
    const triggerPlay = (playNumber: number) => {
      if (cancelled) return;
      setExamPlayCount(playNumber);
      const rec = recordingsMapRef.current[wordObj.id];
      void playWordAudio({
        word: wordObj.word,
        audioDataUrl: rec?.audioDataUrl,
        bundledAudioFile: wordObj.bundledAudioFile,
        playbackRate: 1.0,
      });
    };

    const timers: number[] = [];
    const schedulePlayIfUpcoming = (playNum: number, targetOffsetMs: number) => {
      const delay = targetOffsetMs - elapsedInSlotMs;
      if (delay >= -350) {
        const tid = window.setTimeout(
          () => triggerPlay(playNum),
          Math.max(20, delay)
        );
        timers.push(tid);
      } else {
        setExamPlayCount((c) => Math.max(c, playNum));
      }
    };

    schedulePlayIfUpcoming(1, slot.play1AtMs);
    schedulePlayIfUpcoming(2, slot.play2AtMs);
    schedulePlayIfUpcoming(3, slot.play3AtMs);

    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [runningContest, examIndex, contestDeck]);

  // Anti-Cheat Proctoring: Tab-Switch / Window Blur Detector & BeforeUnload Guard
  useEffect(() => {
    if (!runningContest) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue =
        'Live contest is in progress! The synchronized broadcast clock does not pause if you leave.';
      return e.returnValue;
    };

    let lastViolationMs = 0;
    const recordFocusViolation = (reason: string) => {
      const now = Date.now();
      if (now - lastViolationMs < 1200) return;
      lastViolationMs = now;

      const nextCount = tabSwitchCountRef.current + 1;
      tabSwitchCountRef.current = nextCount;
      setTabSwitchCount(nextCount);
      setProctorAlertText(
        `Anti-Cheat Proctoring Alert (#${nextCount}): ${reason}. Your current word answer has been automatically locked to prevent external lookup!`
      );

      // Immediately lock the active word so the user cannot look up the spelling in another tab and come back to type it!
      const activeIdx = prevSlotIndexRef.current;
      if (!lockedWordsMapRef.current[activeIdx]) {
        lockWordAnswerAtSlot(activeIdx, latestExamInputRef.current, {
          autoLockedByTabSwitch: true,
        });
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        recordFocusViolation('Tab switch or app minimize detected');
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [runningContest, lockWordAnswerAtSlot]);

  const handleCreateContestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreating(true);
    setStatusMessage(null);

    try {
      const activeUser = await ensureSignedInForContest();
      if (!activeUser) {
        onRequestSignIn();
        setIsCreating(false);
        return;
      }
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Sign-in failed.',
      });
      setIsCreating(false);
      return;
    }

    const desiredCount =
      wordCountPreset === 'custom'
        ? Math.max(1, parseInt(customWordCount, 10) || 15)
        : wordCountPreset;

    let scheduledStartMs = Date.now() + 2 * 60 * 1000;
    if (startPresetMins === 'custom') {
      const parsed = new Date(customStartDateTime).getTime();
      if (!Number.isFinite(parsed)) {
        setStatusMessage({
          type: 'error',
          text: 'Please choose a valid start date and time.',
        });
        setIsCreating(false);
        return;
      }
      scheduledStartMs = parsed;
    } else if (startPresetMins === 0) {
      // Starts in 15 seconds so participants in the lobby can see the countdown and start Word #1 simultaneously
      scheduledStartMs = Date.now() + 15000;
    } else {
      scheduledStartMs = Date.now() + startPresetMins * 60 * 1000;
    }

    setIsCreating(true);
    setStatusMessage(null);
    try {
      const created = await createScheduledContest({
        title: titleInput,
        pageFilter,
        categories: selectedCategories,
        wordCount: Math.min(candidatePool.length, desiredCount),
        baseSeconds,
        showBangla,
        startTimeMs: scheduledStartMs,
        durationMinutes,
      });
      // Automatically register the setter into the lobby as a fair participant
      await registerForContest(created);
      setSelectedContestId(created.id);
      setActiveTab('contests');
      setStatusMessage({
        type: 'success',
        text: `Contest "${created.title}" scheduled! All participants will start Word #1 and finish the final word at the exact same synchronized second.`,
      });
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text:
          err instanceof Error ? err.message : 'Failed to schedule contest.',
      });
    } finally {
      setIsCreating(false);
    }
  };

  // ============================================================================
  // ACTIVE SYNCHRONIZED CONTEST EXAM FULLSCREEN VIEW (ANTI-CHEAT LOCKED)
  // ============================================================================
  if (runningContest) {
    const activeExamWord = contestDeck[examIndex];
    const activeExamRec = activeExamWord
      ? recordingsMap[activeExamWord.id]
      : undefined;
    const activeExamBangla =
      activeExamRec?.banglaMeaning || activeExamWord?.bangla || '';
    const examTimerPct = Math.max(
      0,
      Math.min(100, (examRemainingMs / Math.max(1, examTotalMs)) * 100)
    );
    const examSecondsLeft = (examRemainingMs / 1000).toFixed(1);
    const contestEndMs = getContestEndTimeMs(runningContest);
    const totalContestLeftMs = Math.max(0, contestEndMs - nowMs);
    const currentWordLocked = lockedWordsMap[examIndex];
    const isCurrentWordLocked = Boolean(currentWordLocked);

    return (
      <main
        onCopy={(e) => e.preventDefault()}
        onCut={(e) => e.preventDefault()}
        onPaste={(e) => e.preventDefault()}
        onContextMenu={(e) => e.preventDefault()}
        className="flex-1 max-w-3xl w-full mx-auto px-3.5 sm:px-6 pt-4 sm:pt-6 pb-28 space-y-4 select-none"
      >
        <section className="rounded-3xl bg-[#0d1d16] border-2 border-[#fbbf24]/70 p-4 sm:p-7 space-y-5 shadow-2xl">
          {/* Top Synchronized Contest Lock Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1c382b]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-1 rounded-lg bg-[#fbbf24] text-[#08120e] text-xs font-extrabold flex items-center gap-1.5">
                <Trophy className="w-3.5 h-3.5" />
                <span>SYNCED LIVE EXAM: {runningContest.title}</span>
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-[#122b20] border border-[#10b981]/40 text-xs font-mono font-bold text-white">
                Word {examIndex + 1} of {contestDeck.length}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-[#8ba89a]">
                  Global Exam Ends In
                </div>
                <div className="text-xs font-mono font-bold text-[#10b981]">
                  {formatCountdown(totalContestLeftMs)}
                </div>
              </div>
              <div className="px-3 py-1.5 rounded-xl bg-[#1f1909] border border-[#fbbf24]/50 flex items-center gap-1.5 text-xs font-mono font-extrabold text-[#fbbf24]">
                <Timer className="w-4 h-4 animate-pulse" />
                <span>{examSecondsLeft}s</span>
              </div>
            </div>
          </div>

          {/* Anti-Cheat Proctoring Status Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-xl bg-[#08130e] border border-[#1b3629] text-[11px]">
            <div className="flex items-center gap-2 text-[#a7f3d0] font-semibold">
              <Lock className="w-3.5 h-3.5 text-[#10b981] shrink-0" />
              <span>
                Synchronized Broadcast: All participants are on Word #
                {examIndex + 1} right now and finish at the exact same second.
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className={`px-2 py-0.5 rounded font-mono font-bold ${
                  tabSwitchCount === 0
                    ? 'bg-[#10b981]/15 text-[#10b981]'
                    : 'bg-[#f87171]/20 text-[#f87171]'
                }`}
              >
                {tabSwitchCount === 0
                  ? 'Proctor: Clean (0 Tab Switches)'
                  : `⚠️ Tab Switches: ${tabSwitchCount}`}
              </span>
            </div>
          </div>

          {proctorAlertText && (
            <div className="p-3 rounded-xl bg-[#2a1215] border border-[#f87171] text-xs text-[#fecaca] font-semibold flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-[#f87171] shrink-0" />
              <span>{proctorAlertText}</span>
            </div>
          )}

          {/* Word Slot Progress Pills (Shows Locked vs Current vs Future Encrypted Words) */}
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
            {contestDeck.map((_, idx) => {
              const locked = lockedWordsMap[idx];
              const isCurrent = idx === examIndex;
              const isPast = idx < examIndex;
              return (
                <div
                  key={idx}
                  className={`h-7 min-w-[32px] px-2 rounded-lg font-mono text-[11px] font-bold flex items-center justify-center shrink-0 border ${
                    isCurrent
                      ? 'bg-[#fbbf24] border-[#fbbf24] text-[#08120e] scale-105'
                      : locked && !locked.missedWhileAway
                      ? 'bg-[#113022] border-[#10b981]/50 text-[#10b981]'
                      : isPast
                      ? 'bg-[#261316] border-[#f87171]/40 text-[#f87171]'
                      : 'bg-[#08130e] border-[#173024] text-[#5c786a]'
                  }`}
                >
                  {idx + 1}
                </div>
              );
            })}
          </div>

          {/* Countdown Progress Bar for Current Word */}
          <div className="w-full h-3 rounded-full bg-[#07110c] border border-[#1c382b] overflow-hidden">
            <div
              className={`h-full transition-all duration-100 ${
                examTimerPct > 40
                  ? 'bg-[#10b981]'
                  : examTimerPct > 20
                  ? 'bg-[#fbbf24]'
                  : 'bg-[#f87171]'
              }`}
              style={{ width: `${examTimerPct}%` }}
            />
          </div>

          {/* 3-Play Automatic Audio Indicator */}
          <div className="rounded-2xl bg-[#08130e] border border-[#1b3629] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-[#10b981]/20 border border-[#10b981] flex items-center justify-center text-[#10b981] shrink-0">
                <Volume2 className="w-5 h-5 animate-pulse" />
              </div>
              <div>
                <div className="text-xs font-bold text-white">
                  Automatic 3x Pronunciation Playback (Live Broadcast)
                </div>
                <div className="text-[11px] text-[#8ba89a] mt-0.5">
                  No skipping ahead and no going back. Everyone advances to Word #
                  {Math.min(contestDeck.length, examIndex + 2)} when the timer hits 0.0s.
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {[1, 2, 3].map((num) => {
                const active = examPlayCount >= num;
                const current = examPlayCount === num;
                return (
                  <div
                    key={num}
                    className={`px-3 py-1.5 rounded-xl border text-xs font-mono font-bold transition-all ${
                      current
                        ? 'bg-[#10b981] border-[#10b981] text-[#04120c] scale-105'
                        : active
                        ? 'bg-[#123123] border-[#10b981]/50 text-[#10b981]'
                        : 'bg-[#0b1712] border-[#1d352a] text-[#597567]'
                    }`}
                  >
                    Play {num}/3
                  </div>
                );
              })}
            </div>
          </div>

          {/* Optional Bangla Clue */}
          {runningContest.showBangla && activeExamWord && (
            <div className="rounded-xl bg-[#11241b] border border-[#1f3d2f] px-4 py-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] text-[#7ea090]">
                  Bangla Meaning Clue ({activeExamWord.category})
                </div>
                <div className="text-base font-medium text-white mt-0.5">
                  {activeExamBangla}
                </div>
              </div>
              <span className="text-xs font-mono text-[#7ea090]">
                {activeExamWord.word.length} chars
              </span>
            </div>
          )}

          {/* Write-Only Input Box or Locked Waiting State */}
          <div className="space-y-4">
            {isCurrentWordLocked ? (
              <div className="rounded-2xl bg-[#0b2419] border-2 border-[#10b981] p-5 space-y-2 text-center">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#10b981]/20 text-[#10b981] text-xs font-extrabold">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    Answer Locked for Word #{examIndex + 1} in{' '}
                    {(currentWordLocked.lockedAfterMs / 1000).toFixed(1)}s!
                  </span>
                </div>
                <div className="font-mono text-lg font-bold text-white tracking-wider">
                  {currentWordLocked.userAnswer || '(blank)'}
                </div>
                <p className="text-xs text-[#9ab5a7]">
                  {examIndex + 1 < contestDeck.length
                    ? `Waiting ${examSecondsLeft}s for all participants to advance to Word #${
                        examIndex + 2
                      } simultaneously (prevents early word leakage)...`
                    : `Waiting ${examSecondsLeft}s for the final word timer to finish for all participants...`}
                </p>
              </div>
            ) : (
              <div>
                <label
                  htmlFor="contest-exam-input"
                  className="block text-xs font-semibold text-[#9ab5a7] mb-2"
                >
                  Type the spelling and press Enter (or Lock Answer) to record your fast typing time:
                </label>
                <NoSuggestSpellingInput
                  id="contest-exam-input"
                  inputRef={examInputRef}
                  value={examInput}
                  onChange={(val) => {
                    setExamInput(val);
                    latestExamInputRef.current = val;
                  }}
                  onEnterPress={() => lockWordAnswerAtSlot(examIndex, examInput)}
                  disabled={isSubmittingResult || isCurrentWordLocked}
                  placeholder="Write spelling here..."
                  enterKeyHint="done"
                  variant="exam"
                />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-1.5 text-[11px] text-[#7ea090]">
                <ShieldAlert className="w-4 h-4 text-[#fbbf24] shrink-0" />
                <span>
                  Anti-Leakage Lock: Next word unlocks simultaneously for everyone when the timer hits 0.0s.
                </span>
              </div>

              <div className="flex items-center gap-2 ml-auto">
                {!isCurrentWordLocked && (
                  <button
                    type="button"
                    disabled={isSubmittingResult}
                    onClick={() => lockWordAnswerAtSlot(examIndex, examInput)}
                    className="min-h-[46px] px-5 py-2.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-extrabold text-xs sm:text-sm flex items-center gap-2 shrink-0 transition-colors"
                  >
                    <Lock className="w-4 h-4" />
                    <span>Lock Answer for Word #{examIndex + 1}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Optional Emergency Forfeit (With Strict Anti-Re-Entry Warning) */}
            <div className="pt-3 border-t border-[#183126] flex flex-wrap items-center justify-between gap-2">
              {!confirmEarlyForfeit ? (
                <button
                  type="button"
                  onClick={() => setConfirmEarlyForfeit(true)}
                  className="text-[11px] text-[#6d8a7b] hover:text-[#f87171] underline"
                >
                  Forfeit &amp; Exit Contest Early (Cannot Re-Enter)
                </button>
              ) : (
                <div className="w-full p-3 rounded-xl bg-[#261114] border border-[#f87171]/50 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-[#fecaca] font-semibold">
                    Are you sure? Remaining words will be marked blank and you CANNOT re-enter this contest!
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmEarlyForfeit(false)}
                      className="px-3 py-1.5 rounded-lg bg-[#14291f] text-xs font-bold text-white"
                    >
                      Stay in Exam
                    </button>
                    <button
                      type="button"
                      disabled={isSubmittingResult}
                      onClick={() => {
                        const finalMap = { ...lockedWordsMapRef.current };
                        if (!finalMap[examIndex] && examInput.trim()) {
                          finalMap[examIndex] = {
                            userAnswer: examInput.trim(),
                            lockedAfterMs: Math.max(1000, examTotalMs - examRemainingMs),
                            lockedAtWallMs: Date.now(),
                          };
                        }
                        void finalizeAndSubmitContestExam(
                          runningContest,
                          contestDeck,
                          finalMap,
                          examStartedAtMs
                        );
                      }}
                      className="px-3 py-1.5 rounded-lg bg-[#f87171] text-[#08120e] text-xs font-extrabold"
                    >
                      Confirm Forfeit &amp; Lock Attempt
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex-1 max-w-6xl w-full mx-auto px-3.5 sm:px-6 pt-3 sm:pt-5 pb-28 md:py-6 space-y-4 sm:space-y-5">
      {/* Top Navigation & Blind Fair-Play Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBackToPractice}
          className="min-h-[38px] text-xs sm:text-sm font-semibold text-[#10b981] hover:text-[#34d399] flex items-center gap-1.5 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Practice</span>
        </button>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={() => void handleManualSync()}
            title="Sync Live Contests from Cloud"
            className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#11241b] hover:bg-[#173326] border border-[#1f3d2f] text-xs font-bold text-[#10b981] flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isSyncingCloud ? 'animate-spin' : ''}`}
            />
            <span>Sync</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('contests')}
            className={`min-h-[38px] px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors ${
              activeTab === 'contests'
                ? 'bg-[#10b981] text-[#04120c]'
                : 'bg-[#11241b] text-[#9ab5a7] hover:text-white border border-[#1f3d2f]'
            }`}
          >
            <Trophy className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            <span>Contests ({contests.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('create')}
            className={`min-h-[38px] px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-colors ${
              activeTab === 'create'
                ? 'bg-[#fbbf24] text-[#08120e]'
                : 'bg-[#fbbf24]/15 hover:bg-[#fbbf24]/25 text-[#fbbf24] border border-[#fbbf24]/40'
            }`}
          >
            <Plus className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            <span>+ Host Contest</span>
          </button>
        </div>
      </div>

      {/* Hero Explanation Banner (Desktop/Tablet only so Mobile shows Active Live Contest Card immediately at top) */}
      <section className="hidden md:flex rounded-3xl bg-gradient-to-r from-[#0e241b] via-[#102a20] to-[#1a2514] border border-[#244b39] p-5 sm:p-6 flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="space-y-1.5">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[#fbbf24]/15 border border-[#fbbf24]/40 text-[#fbbf24] text-[11px] font-extrabold uppercase tracking-wider">
            <Lock className="w-3.5 h-3.5" />
            <span>100% Blind &amp; Fair Multi-User Exam Platform</span>
          </div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">
            Scheduled Live IELTS Spelling Contests
          </h1>
          <p className="text-xs sm:text-sm text-[#9ab5a7] max-w-3xl leading-relaxed">
            Anyone logged in can schedule a contest for a specific time.{' '}
            <strong className="text-white">
              Even the contest setter cannot see the words beforehand
            </strong>{' '}
            — the words are cryptographically generated at the exact start second
            so every logged-in participant takes the{' '}
            <strong className="text-[#10b981]">
              exact same Strict Test simultaneously
            </strong>
            .
          </p>
        </div>

        {!user && (
          <button
            type="button"
            onClick={onRequestSignIn}
            className="self-start md:self-center min-h-[46px] px-5 py-2.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-extrabold text-xs sm:text-sm flex items-center gap-2 shrink-0 shadow-lg"
          >
            <LogIn className="w-4 h-4" />
            <span>Sign In to Join or Host Contests</span>
          </button>
        )}
      </section>

      {statusMessage && (
        <div
          className={`rounded-2xl px-4 py-3 border text-xs sm:text-sm flex items-center justify-between gap-3 ${
            statusMessage.type === 'success'
              ? 'bg-[#0e291e] border-[#10b981]/50 text-[#a7f3d0]'
              : 'bg-[#2a1215] border-[#f87171]/50 text-[#fecaca]'
          }`}
        >
          <span>{statusMessage.text}</span>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            className="text-xs underline opacity-80 hover:opacity-100 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {activeTab === 'create' ? (
        /* =================================================================== */
        /* SCHEDULE NEW BLIND CONTEST FORM                                     */
        /* =================================================================== */
        <section className="rounded-3xl bg-[#0d1d16] border border-[#244737] p-5 sm:p-8 space-y-6 shadow-2xl">
          <div className="flex items-start gap-3.5 pb-4 border-b border-[#193327]">
            <div className="w-11 h-11 rounded-2xl bg-[#fbbf24]/15 border border-[#fbbf24]/40 flex items-center justify-center text-[#fbbf24] shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg sm:text-xl font-bold text-white">
                Schedule a Blind Multi-User Spelling Contest
              </h2>
              <p className="text-xs sm:text-sm text-[#8ba89a] mt-0.5">
                You choose the category pool, word count, and start time. The system keeps the actual words <strong>completely hidden from everyone (including you)</strong> until the countdown reaches 00:00!
              </p>
            </div>
          </div>

          <form onSubmit={handleCreateContestSubmit} className="space-y-6">
            {!user && (
              <div>
                <label
                  htmlFor="setter-display-name"
                  className="block text-xs font-bold text-[#fbbf24] mb-2"
                >
                  Your Display Name (Setter &amp; Leaderboard Name)
                </label>
                <input
                  id="setter-display-name"
                  type="text"
                  required
                  maxLength={80}
                  value={participantNameInput}
                  onChange={(e) => setParticipantNameInput(e.target.value)}
                  placeholder="e.g., Prattoy / Rahat"
                  className="w-full min-h-[46px] px-4 py-2.5 rounded-xl bg-[#08130e] border border-[#fbbf24]/50 focus:border-[#fbbf24] text-sm font-semibold text-white focus:outline-none"
                />
              </div>
            )}

            {/* 1. Contest Title */}
            <div>
              <label
                htmlFor="contest-title"
                className="block text-xs font-bold text-[#c4d9ce] mb-2"
              >
                Contest Name / Title
              </label>
              <input
                id="contest-title"
                type="text"
                required
                maxLength={120}
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                placeholder="e.g., Tonight 9 PM IELTS Listening Challenge"
                className="w-full min-h-[46px] px-4 py-2.5 rounded-xl bg-[#08130e] border border-[#1f3d2f] focus:border-[#10b981] text-sm font-semibold text-white focus:outline-none"
              />
            </div>

            {/* 2. Scheduled Start Time */}
            <div className="space-y-2.5">
              <label className="block text-xs font-bold text-[#c4d9ce]">
                When should the contest open for all logged-in users?
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
                {(
                  [
                    { val: 0, label: 'Now (3s)' },
                    { val: 1, label: 'In 1 Min' },
                    { val: 2, label: 'In 2 Mins' },
                    { val: 5, label: 'In 5 Mins' },
                    { val: 15, label: 'In 15 Mins' },
                    { val: 30, label: 'In 30 Mins' },
                    { val: 'custom', label: 'Exact Time' },
                  ] as const
                ).map((item) => (
                  <button
                    key={String(item.val)}
                    type="button"
                    onClick={() => setStartPresetMins(item.val)}
                    className={`min-h-[42px] px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
                      startPresetMins === item.val
                        ? 'bg-[#fbbf24] border-[#fbbf24] text-[#08120e]'
                        : 'bg-[#08130e] border-[#1d382b] text-[#d2e5dc] hover:border-[#fbbf24]/50'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {startPresetMins === 'custom' && (
                <div className="pt-2 flex flex-wrap items-center gap-3">
                  <label
                    htmlFor="contest-custom-time"
                    className="text-xs text-[#8ba89a]"
                  >
                    Select exact local start date &amp; time:
                  </label>
                  <input
                    id="contest-custom-time"
                    type="datetime-local"
                    value={customStartDateTime}
                    onChange={(e) => setCustomStartDateTime(e.target.value)}
                    className="min-h-[42px] px-3.5 py-2 rounded-xl bg-[#08130e] border border-[#fbbf24] text-xs sm:text-sm font-mono text-white focus:outline-none"
                  />
                </div>
              )}
            </div>

            {/* 3. Page & Category Pool */}
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs font-bold text-[#c4d9ce]">
                  Select Word Pool (Candidate Pool: {candidatePool.length} words)
                </label>
                <div className="inline-flex rounded-xl bg-[#08130e] p-1 border border-[#1c382b]">
                  {(
                    [
                      { id: 'page1', label: 'Page 1' },
                      { id: 'page2', label: 'Page 2' },
                      { id: 'all', label: 'All Pages' },
                    ] as const
                  ).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setPageFilter(p.id);
                        setSelectedCategories([]);
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                        pageFilter === p.id
                          ? 'bg-[#10b981] text-[#04120c]'
                          : 'text-[#8ba89a] hover:text-white'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-48 overflow-y-auto p-1">
                <button
                  type="button"
                  onClick={() => setSelectedCategories([])}
                  className={`min-h-[38px] px-3 py-1.5 rounded-xl border text-left text-xs font-bold flex items-center justify-between gap-2 ${
                    selectedCategories.length === 0
                      ? 'bg-[#143325] border-[#10b981] text-white'
                      : 'bg-[#09140f] border-[#183126] text-[#9ab5a7]'
                  }`}
                >
                  <span className="truncate">All Categories</span>
                  {selectedCategories.length === 0 && (
                    <Check className="w-3.5 h-3.5 text-[#10b981] shrink-0" />
                  )}
                </button>

                {CATEGORIES.filter((c) => c !== 'All Categories').map((cat) => {
                  const active = selectedCategories.includes(cat);
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() =>
                        setSelectedCategories((prev) =>
                          prev.includes(cat)
                            ? prev.filter((x) => x !== cat)
                            : [...prev, cat]
                        )
                      }
                      className={`min-h-[38px] px-3 py-1.5 rounded-xl border text-left text-xs flex items-center justify-between gap-2 ${
                        active
                          ? 'bg-[#143325] border-[#10b981] text-white font-bold'
                          : 'bg-[#09140f] border-[#183126] text-[#9ab5a7]'
                      }`}
                    >
                      <span className="truncate">{cat}</span>
                      {active && (
                        <Check className="w-3.5 h-3.5 text-[#10b981] shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 4. Word Count & Strict Exam Settings */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-2xl bg-[#09140f] border border-[#193327] p-4 space-y-2">
                <div className="text-xs font-bold text-[#c4d9ce]">
                  Number of Contest Words
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {([10, 15, 20, 30, 50, 'custom'] as const).map((preset) => (
                    <button
                      key={String(preset)}
                      type="button"
                      onClick={() => setWordCountPreset(preset)}
                      className={`min-h-[36px] rounded-lg text-xs font-mono font-bold ${
                        wordCountPreset === preset
                          ? 'bg-[#10b981] text-[#04120c]'
                          : 'bg-[#11241b] text-[#9ab5a7]'
                      }`}
                    >
                      {preset === 'custom' ? 'Custom' : `${preset}w`}
                    </button>
                  ))}
                </div>
                {wordCountPreset === 'custom' && (
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={customWordCount}
                    onChange={(e) => setCustomWordCount(e.target.value)}
                    className="w-full mt-2 min-h-[36px] px-3 rounded-lg bg-[#08130e] border border-[#10b981] text-xs font-mono text-white"
                  />
                )}
              </div>

              <div className="rounded-2xl bg-[#09140f] border border-[#193327] p-4 space-y-2">
                <div className="text-xs font-bold text-[#c4d9ce]">
                  Strict Timer Per Word (3x Audio)
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {[10, 12, 15].map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      onClick={() => setBaseSeconds(sec)}
                      className={`min-h-[36px] rounded-lg text-xs font-mono font-bold ${
                        baseSeconds === sec
                          ? 'bg-[#10b981] text-[#04120c]'
                          : 'bg-[#11241b] text-[#9ab5a7]'
                      }`}
                    >
                      {sec}s+
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-[#6d8a7b]">
                  Plays 3 times with pauses, then auto-advances.
                </p>
              </div>

              <div className="rounded-2xl bg-[#09140f] border border-[#193327] p-4 space-y-2">
                <div className="text-xs font-bold text-[#c4d9ce]">
                  Contest Window &amp; Clue
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {[15, 30, 60].map((mins) => (
                    <button
                      key={mins}
                      type="button"
                      onClick={() => setDurationMinutes(mins)}
                      className={`min-h-[36px] rounded-lg text-xs font-mono font-bold ${
                        durationMinutes === mins
                          ? 'bg-[#fbbf24] text-[#08120e]'
                          : 'bg-[#11241b] text-[#9ab5a7]'
                      }`}
                    >
                      {mins}m open
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-2 pt-1 text-xs text-[#9ab5a7] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showBangla}
                    onChange={(e) => setShowBangla(e.target.checked)}
                    className="rounded accent-[#10b981]"
                  />
                  <span>Show Bangla Meaning Clue</span>
                </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#193327]">
              <div className="text-xs text-[#8ba89a] flex items-center gap-2">
                <Lock className="w-4 h-4 text-[#fbbf24] shrink-0" />
                <span>
                  Words will remain <strong>100% hidden from you and all users</strong> until the scheduled start time.
                </span>
              </div>

              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setActiveTab('contests')}
                  className="min-h-[46px] px-4 py-2.5 rounded-xl bg-[#13291f] text-xs font-bold text-[#9ab5a7] hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isCreating || candidatePool.length === 0}
                  className="min-h-[46px] px-6 py-2.5 rounded-xl bg-[#fbbf24] hover:bg-[#f59e0b] disabled:opacity-50 text-[#08120e] font-extrabold text-xs sm:text-sm flex items-center gap-2 transition-colors"
                >
                  <Calendar className="w-4 h-4" />
                  <span>
                    {isCreating
                      ? 'Scheduling Contest...'
                      : 'Create Blind Scheduled Contest'}
                  </span>
                </button>
              </div>
            </div>
          </form>
        </section>
      ) : (
        /* =================================================================== */
        /* LIVE & SCHEDULED CONTESTS LOBBY + REAL-TIME LEADERBOARD             */
        /* =================================================================== */
        <div className="space-y-4">
          {/* Mobile Horizontal Contest Switcher Strip (so mobile users see & switch contests at the very top!) */}
          {contests.length > 0 && (
            <div className="lg:hidden flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
              {contests.map((c) => {
                const p = getContestPhase(c, nowMs);
                const active = selectedContest?.id === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedContestId(c.id)}
                    className={`min-h-[40px] px-3 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-2 whitespace-nowrap shrink-0 transition-all ${
                      active
                        ? 'bg-[#132c21] border-[#10b981] text-white shadow-md'
                        : 'bg-[#09140f] border-[#183126] text-[#8ba89a]'
                    }`}
                  >
                    {p === 'live' ? (
                      <span className="px-1.5 py-0.5 rounded bg-[#fbbf24] text-[#08120e] text-[9px] font-extrabold uppercase">
                        LIVE
                      </span>
                    ) : p === 'upcoming' ? (
                      <span className="px-1.5 py-0.5 rounded bg-[#fbbf24]/20 text-[#fbbf24] text-[9px] font-mono font-bold">
                        SOON
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded bg-[#152a20] text-[#6d8a7b] text-[9px] font-bold">
                        END
                      </span>
                    )}
                    <span className="max-w-[150px] truncate">{c.title}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* LEFT COLUMN on Desktop / SECOND on Mobile: Contest List */}
            <div className="order-2 lg:order-1 lg:col-span-5 rounded-3xl bg-[#0d1d16] border border-[#1d382b] p-4 sm:p-5 space-y-3.5">
              <div className="flex items-center justify-between pb-2 border-b border-[#162d22]">
                <h2 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                  <Flame className="w-4 h-4 text-[#fbbf24]" />
                  <span>All Contests ({contests.length})</span>
                </h2>
                <button
                  type="button"
                  onClick={() => setActiveTab('create')}
                  className="text-xs font-bold text-[#10b981] hover:underline flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Contest</span>
                </button>
              </div>

              {contests.length === 0 ? (
                <div className="py-10 text-center space-y-3">
                  <Trophy className="w-8 h-8 text-[#fbbf24] mx-auto opacity-80" />
                  <p className="text-xs sm:text-sm text-[#8ba89a]">
                    No contests scheduled yet. Be the first to schedule a live spelling contest!
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('create')}
                    className="min-h-[42px] px-4 py-2 rounded-xl bg-[#fbbf24] text-[#08120e] text-xs font-extrabold inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Schedule First Contest</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5 max-h-[600px] overflow-y-auto pr-1">
                  {contests.map((contest) => {
                    const phase = getContestPhase(contest, nowMs);
                    const isSelected = selectedContest?.id === contest.id;
                    const contestSubs = submissionsByContest[contest.id] || [];
                    const endTimeMs = getContestEndTimeMs(contest);
                    const canDeleteThisContest =
                      isAdmin ||
                      (Boolean(user) &&
                        contest.creatorId === currentUserIdSanitized);

                    return (
                      <div
                        key={contest.id}
                        onClick={() => setSelectedContestId(contest.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedContestId(contest.id);
                          }
                        }}
                        className={`p-3.5 rounded-2xl border transition-all cursor-pointer space-y-2 ${
                          isSelected
                            ? 'bg-[#132c21] border-[#10b981] ring-1 ring-[#10b981]/30'
                            : 'bg-[#09140f] hover:bg-[#10231a] border-[#183126]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-white truncate">
                              {contest.title}
                            </div>
                            <div className="text-[11px] text-[#7ea090] mt-0.5">
                              Set by{' '}
                              <span className="text-[#c4d9ce] font-semibold">
                                {contest.creatorName}
                              </span>{' '}
                              · {contest.wordCount} words · {contest.baseSeconds}s+
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {phase === 'live' ? (
                              <span className="px-2.5 py-0.5 rounded-full bg-[#10b981] text-[#04120c] text-[10px] font-extrabold uppercase tracking-wider animate-pulse shrink-0">
                                LIVE NOW
                              </span>
                            ) : phase === 'upcoming' ? (
                              <span className="px-2.5 py-0.5 rounded-full bg-[#fbbf24]/20 border border-[#fbbf24]/50 text-[#fbbf24] text-[10px] font-mono font-bold shrink-0">
                                In {formatCountdown(contest.startTimeMs - nowMs)}
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-md bg-[#13261d] text-[#6d8a7b] text-[10px] font-bold uppercase shrink-0">
                                Ended
                              </span>
                            )}

                            {canDeleteThisContest && (
                              <button
                                type="button"
                                onClick={(e) =>
                                  void handleRemoveContest(contest, e)
                                }
                                title="Remove Contest"
                                className="min-h-[28px] px-2 py-1 rounded-lg bg-[#2a1215] hover:bg-[#3b181d] border border-[#f87171]/40 text-[10px] font-bold text-[#f87171] flex items-center gap-1 transition-colors"
                              >
                                <Trash2 className="w-3 h-3" />
                                <span>Remove</span>
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8ba89a] pt-1 border-t border-[#152a20]">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3 text-[#10b981]" />
                            {phase === 'upcoming'
                              ? `Starts ${new Date(
                                  contest.startTimeMs
                                ).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })}`
                              : phase === 'live'
                              ? `Ends for all in ${formatCountdown(endTimeMs - nowMs)}`
                              : new Date(contest.startTimeMs).toLocaleDateString()}
                          </span>

                          <span className="flex items-center gap-1 font-mono text-[#10b981] font-semibold">
                            <Users className="w-3 h-3" />
                            {contestSubs.length} joined
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* RIGHT COLUMN on Desktop / FIRST AT TOP on Mobile: Selected Contest Lobby & Live Leaderboard */}
            <div className="order-1 lg:order-2 lg:col-span-7 rounded-3xl bg-[#0d1d16] border border-[#1d382b] p-4 sm:p-6 space-y-5">
              {!selectedContest ? (
                <div className="py-12 text-center space-y-3">
                  <Trophy className="w-8 h-8 text-[#fbbf24] mx-auto opacity-80" />
                  <p className="text-xs sm:text-sm text-[#8ba89a]">
                    No active contest selected yet. Tap &ldquo;+ Host Contest&rdquo; above to schedule or start a Synchronized Live Contest!
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('create')}
                    className="min-h-[42px] px-4 py-2 rounded-xl bg-[#fbbf24] text-[#08120e] text-xs font-extrabold inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Schedule or Start Live Contest</span>
                  </button>
                </div>
              ) : (
              (() => {
                const phase = getContestPhase(selectedContest, nowMs);
                const endTimeMs = getContestEndTimeMs(selectedContest);
                const liveTimeline =
                  phase === 'live'
                    ? getLiveContestTimeline(selectedContest, nowMs)
                    : null;
                const deviceLockForSelected = getDeviceContestLock(
                  selectedContest.id
                );
                const isDeviceLockedForSelected = Boolean(
                  deviceLockForSelected &&
                    (deviceLockForSelected.status === 'in_progress' ||
                      deviceLockForSelected.status === 'completed')
                );
                const isCompletedOnDeviceOrCloud =
                  mySubmissionForSelected?.status === 'completed' ||
                  deviceLockForSelected?.status === 'completed';

                const contestSubs =
                  submissionsByContest[selectedContest.id] || [];
                const canDelete =
                  isAdmin ||
                  (Boolean(user) &&
                    selectedContest.creatorId === currentUserIdSanitized);

                // Anti-Leakage Security Rule:
                // Contest words and correct spellings are ONLY revealed once `phase === 'ended'` (when the exam finishes simultaneously for EVERYONE).
                const canRevealWords = phase === 'ended';
                const revealedWords = canRevealWords
                  ? deriveContestWordDeck(selectedContest, Date.now())
                  : [];

                return (
                  <>
                    {/* Contest Detail Header */}
                    <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-[#183126]">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-lg sm:text-xl font-extrabold text-white">
                            {selectedContest.title}
                          </h2>
                          {phase === 'live' && (
                            <span className="px-2.5 py-0.5 rounded-full bg-[#10b981] text-[#04120c] text-[10px] font-extrabold uppercase tracking-wider">
                              SYNCHRONIZED LIVE BROADCAST
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[#8ba89a]">
                          Setter:{' '}
                          <strong className="text-white">
                            {selectedContest.creatorName}
                          </strong>{' '}
                          · Pool:{' '}
                          <strong className="text-[#10b981]">
                            {selectedContest.pageFilter.toUpperCase()} (
                            {selectedContest.categories.length === 0
                              ? 'All Categories'
                              : selectedContest.categories.join(', ')}
                            )
                          </strong>{' '}
                          ·{' '}
                          <strong className="text-white">
                            {selectedContest.wordCount} Words
                          </strong>{' '}
                          ({selectedContest.baseSeconds}s+ synchronized timer)
                        </p>
                      </div>

                      {canDelete && (
                        <button
                          type="button"
                          onClick={(e) =>
                            void handleRemoveContest(selectedContest, e)
                          }
                          className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#2a1215] hover:bg-[#3b181d] border border-[#f87171]/40 text-xs font-semibold text-[#f87171] flex items-center gap-1.5"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Remove Contest</span>
                        </button>
                      )}
                    </div>

                    {/* Contest Status & Action Box */}
                    {phase === 'upcoming' ? (
                      <div className="rounded-2xl bg-[#141f14] border-2 border-[#fbbf24]/50 p-5 space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="space-y-1">
                            <div className="text-xs font-bold uppercase tracking-wider text-[#fbbf24] flex items-center gap-1.5">
                              <Lock className="w-4 h-4" />
                              <span>
                                Blind Pre-Contest Lobby (Words Hidden From Setter &amp; All Users)
                              </span>
                            </div>
                            <div className="text-2xl sm:text-3xl font-extrabold font-mono text-white">
                              Starts in{' '}
                              {formatCountdown(
                                selectedContest.startTimeMs - nowMs
                              )}
                            </div>
                            <div className="text-xs text-[#8ba89a]">
                              Scheduled for{' '}
                              {new Date(
                                selectedContest.startTimeMs
                              ).toLocaleString()}
                            </div>
                          </div>

                          <div className="flex flex-col gap-2 shrink-0 min-w-[240px]">
                            <div className="space-y-1">
                              <input
                                type="text"
                                value={participantNameInput}
                                onChange={(e) =>
                                  setParticipantNameInput(e.target.value)
                                }
                                placeholder="Your Name for Leaderboard..."
                                className="w-full min-h-[38px] px-3 py-1.5 rounded-xl bg-[#08130e] border border-[#fbbf24]/50 text-xs text-white placeholder-[#6d8a7b] focus:outline-none focus:border-[#fbbf24]"
                              />
                              <div className="text-[10px] text-[#9ab5a7] flex items-center justify-between gap-2 px-1">
                                <span>
                                  {user
                                    ? `Active ID: ${user.displayName}`
                                    : 'Auto-assigns unique #ID'}
                                </span>
                                {user && !user.isVerifiedAdmin && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void ensureSignedInForContest(
                                        true,
                                        selectedContest.id
                                      )
                                    }
                                    className="text-[#fbbf24] hover:underline font-semibold"
                                  >
                                    New #ID
                                  </button>
                                )}
                              </div>
                            </div>
                            {mySubmissionForSelected ? (
                              <div className="px-4 py-2.5 rounded-xl bg-[#0e291e] border border-[#10b981]/50 text-[#10b981] text-xs font-bold flex items-center gap-2">
                                <CheckCircle2 className="w-4 h-4 shrink-0" />
                                <span>
                                  You are Registered! Exam opens at 00:00
                                </span>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={async () => {
                                  await ensureSignedInForContest(
                                    false,
                                    selectedContest.id
                                  );
                                  await registerForContest(selectedContest);
                                }}
                                className="min-h-[46px] px-5 py-2.5 rounded-xl bg-[#fbbf24] hover:bg-[#f59e0b] text-[#08120e] font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2"
                              >
                                <Users className="w-4 h-4" />
                                <span>Register / Join Waiting Lobby</span>
                              </button>
                            )}

                            <label className="flex items-center gap-2 text-[11px] text-[#9ab5a7] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={autoStartWhenLive}
                                onChange={(e) =>
                                  setAutoStartWhenLive(e.target.checked)
                                }
                                className="rounded accent-[#10b981]"
                              />
                              <span>
                                Auto-launch exam when countdown hits 00:00
                              </span>
                            </label>
                          </div>
                        </div>
                      </div>
                    ) : phase === 'live' ? (
                      <div className="rounded-2xl bg-[#0e291e] border-2 border-[#10b981] p-5 space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          <div className="space-y-1">
                            <div className="text-xs font-extrabold uppercase tracking-wider text-[#10b981] flex items-center gap-1.5">
                              <Play className="w-4 h-4 fill-[#10b981]" />
                              <span>
                                Synchronized Contest is LIVE! (Broadcast: Word #
                                {(liveTimeline?.activeSlotIndex ?? 0) + 1} of{' '}
                                {selectedContest.wordCount})
                              </span>
                            </div>
                            <div className="text-lg sm:text-xl font-bold text-white">
                              Ends simultaneously for all in{' '}
                              {formatCountdown(endTimeMs - nowMs)}
                            </div>
                            <p className="text-xs text-[#a7f3d0]">
                              Anti-Leakage Lock: Everyone hears the same word at the same second and finishes together. Re-entering never resets to Word 1.
                            </p>
                          </div>

                          <div className="flex flex-col gap-2 shrink-0 min-w-[250px]">
                            <div className="space-y-1">
                              <input
                                type="text"
                                disabled={isDeviceLockedForSelected}
                                value={
                                  deviceLockForSelected?.userName ||
                                  participantNameInput
                                }
                                onChange={(e) =>
                                  setParticipantNameInput(e.target.value)
                                }
                                placeholder="Your Name for Leaderboard..."
                                className="w-full min-h-[38px] px-3 py-1.5 rounded-xl bg-[#08130e] border border-[#10b981]/50 disabled:opacity-60 text-xs text-white placeholder-[#6d8a7b] focus:outline-none focus:border-[#10b981]"
                              />
                              <div className="text-[10px] text-[#a7f3d0] flex items-center justify-between gap-2 px-1">
                                <span>
                                  {isDeviceLockedForSelected
                                    ? `🔒 Device Locked: ${deviceLockForSelected?.userName}`
                                    : user
                                    ? `Active ID: ${user.displayName}`
                                    : 'Auto-assigns unique #ID'}
                                </span>
                                {user &&
                                  !user.isVerifiedAdmin &&
                                  !isDeviceLockedForSelected && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void ensureSignedInForContest(
                                          true,
                                          selectedContest.id
                                        )
                                      }
                                      className="text-[#fbbf24] hover:underline font-semibold"
                                    >
                                      New Student #ID
                                    </button>
                                  )}
                              </div>
                            </div>
                            {isCompletedOnDeviceOrCloud ? (
                              <div className="space-y-1.5">
                                <div className="px-4 py-3 rounded-xl bg-[#081610] border border-[#10b981]/50 text-[#10b981] text-xs font-bold flex items-center gap-2 shrink-0">
                                  <Lock className="w-4 h-4 shrink-0" />
                                  <span>
                                    Attempt Locked &amp; Submitted
                                    {mySubmissionForSelected
                                      ? `: ${mySubmissionForSelected.correctCount}/${mySubmissionForSelected.totalWords} (${mySubmissionForSelected.accuracy}%)`
                                      : ''}
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleStartLiveContestExam(selectedContest)
                                }
                                className="min-h-[50px] px-6 py-3 rounded-xl bg-[#fbbf24] hover:bg-[#f59e0b] text-[#08120e] font-extrabold text-sm flex items-center justify-center gap-2 shrink-0 shadow-lg"
                              >
                                <Play className="w-4 h-4 fill-[#08120e]" />
                                <span>
                                  {deviceLockForSelected?.status === 'in_progress'
                                    ? `Resume Synced Exam (Word #${
                                        (liveTimeline?.activeSlotIndex ?? 0) + 1
                                      })`
                                    : 'Enter Strict Contest Exam Now'}
                                </span>
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-2xl bg-[#09140f] border border-[#183126] p-4 flex items-center justify-between gap-3">
                        <div className="text-xs text-[#8ba89a]">
                          This contest has ended for all participants. Official standings and contest words are unlocked below.
                        </div>
                        <span className="px-2.5 py-1 rounded-lg bg-[#13291f] text-xs font-bold text-[#9ab5a7]">
                          Contest Finished
                        </span>
                      </div>
                    )}

                    {/* Live Leaderboard */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-white flex items-center gap-2">
                          <Award className="w-4 h-4 text-[#fbbf24]" />
                          <span>
                            Live Contest Leaderboard &amp; Lobby (
                            {contestSubs.length})
                          </span>
                        </h3>
                        <span className="text-[11px] text-[#7ea090]">
                          Ranked by Score &rarr; Fastest Active Typing Time
                        </span>
                      </div>

                      {contestSubs.length === 0 ? (
                        <div className="p-6 rounded-2xl bg-[#09140f] border border-[#173024] text-center text-xs text-[#7ea090]">
                          No participants have registered or submitted yet.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {contestSubs.map((sub, idx) => {
                            const isMe = sub.userId === currentUserIdSanitized;
                            const isSetter =
                              sub.userId === selectedContest.creatorId;
                            const rank = idx + 1;

                            return (
                              <div
                                key={sub.id}
                                className={`p-3 rounded-xl border flex flex-wrap items-center justify-between gap-2 ${
                                  isMe
                                    ? 'bg-[#122b20] border-[#10b981]'
                                    : 'bg-[#09140f] border-[#173024]'
                                }`}
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <span
                                    className={`w-7 h-7 rounded-lg font-mono text-xs font-extrabold flex items-center justify-center shrink-0 ${
                                      sub.status !== 'completed'
                                        ? 'bg-[#13291f] text-[#6d8a7b]'
                                        : rank === 1
                                        ? 'bg-[#fbbf24] text-[#08120e]'
                                        : rank === 2
                                        ? 'bg-[#cbd5e1] text-[#08120e]'
                                        : rank === 3
                                        ? 'bg-[#d97706] text-white'
                                        : 'bg-[#13291f] text-[#9ab5a7]'
                                    }`}
                                  >
                                    {sub.status === 'completed'
                                      ? `#${rank}`
                                      : '—'}
                                  </span>

                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-xs sm:text-sm font-bold text-white truncate">
                                        {sub.userName}
                                      </span>
                                      {isMe && (
                                        <span className="px-1.5 py-0.5 rounded bg-[#10b981]/20 text-[#10b981] text-[10px] font-bold">
                                          You
                                        </span>
                                      )}
                                      {isSetter && (
                                        <span className="px-1.5 py-0.5 rounded bg-[#fbbf24]/20 text-[#fbbf24] text-[10px] font-bold">
                                          Setter
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[11px] text-[#7ea090]">
                                      {sub.status === 'completed'
                                        ? `Active typing time: ${formatDurationMs(
                                            sub.timeTakenMs
                                          )}`
                                        : sub.status === 'in_progress'
                                        ? `Live in Exam (${sub.correctCount}/${sub.totalWords} so far)`
                                        : 'Waiting in Lobby'}
                                    </div>
                                  </div>
                                </div>

                                {sub.status === 'completed' ? (
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span className="px-2.5 py-1 rounded-lg bg-[#0e291e] border border-[#10b981]/40 font-mono text-xs font-extrabold text-[#10b981]">
                                      {sub.correctCount}/{sub.totalWords} (
                                      {sub.accuracy}%)
                                    </span>
                                  </div>
                                ) : sub.status === 'in_progress' ? (
                                  <span className="px-2.5 py-1 rounded-lg bg-[#123123] border border-[#10b981]/30 text-[11px] font-mono font-bold text-[#10b981]">
                                    In Exam · {sub.correctCount}/{sub.totalWords}
                                  </span>
                                ) : (
                                  <span className="px-2.5 py-1 rounded-lg bg-[#13291f] text-[11px] font-semibold text-[#fbbf24]">
                                    Registered
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Post-Contest Word & Answer Sheet Reveal (Strictly Locked Until Contest Ends Globally) */}
                    <div className="pt-2 border-t border-[#183126] space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs sm:text-sm font-bold text-white flex items-center gap-2">
                          {canRevealWords ? (
                            <Eye className="w-4 h-4 text-[#10b981]" />
                          ) : (
                            <Lock className="w-4 h-4 text-[#fbbf24]" />
                          )}
                          <span>
                            Contest Words &amp; Answer Breakdown (
                            {selectedContest.wordCount} Words)
                          </span>
                        </h3>
                      </div>

                      {!canRevealWords ? (
                        <div className="p-4 rounded-2xl bg-[#09140f] border border-[#173024] text-xs text-[#8ba89a] flex items-center gap-2.5">
                          <Lock className="w-4 h-4 text-[#fbbf24] shrink-0" />
                          <span>
                            <strong>Anti-Leakage Blind Lock Active:</strong>{' '}
                            Official contest words and correct spellings are
                            strictly hidden from everyone (even after early
                            submission) until the synchronized contest ends for
                            all participants simultaneously.
                          </span>
                        </div>
                      ) : mySubmissionForSelected?.results &&
                        mySubmissionForSelected.results.length > 0 ? (
                        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                          {mySubmissionForSelected.results.map((r, i) => {
                            const rec = recordingsMap[r.wordId];
                            return (
                              <div
                                key={`${r.wordId}_${i}`}
                                className={`p-3 rounded-xl border flex items-center justify-between gap-3 ${
                                  r.isCorrect
                                    ? 'bg-[#0b1f17] border-[#10b981]/40'
                                    : 'bg-[#211013] border-[#f87171]/40'
                                }`}
                              >
                                <div className="flex items-start gap-2.5 min-w-0">
                                  {r.isCorrect ? (
                                    <CheckCircle2 className="w-4 h-4 text-[#10b981] shrink-0 mt-0.5" />
                                  ) : (
                                    <XCircle className="w-4 h-4 text-[#f87171] shrink-0 mt-0.5" />
                                  )}
                                  <div className="min-w-0 text-xs">
                                    <div className="font-mono font-bold text-white">
                                      #{i + 1}. {r.word}{' '}
                                      <span className="font-sans font-normal text-[#8ba89a]">
                                        ({r.bangla})
                                      </span>
                                    </div>
                                    <div className="text-[11px] mt-0.5">
                                      Your Answer:{' '}
                                      <span
                                        className={`font-mono font-semibold ${
                                          r.isCorrect
                                            ? 'text-[#10b981]'
                                            : 'text-[#f87171] line-through'
                                        }`}
                                      >
                                        {r.userAnswer || '(blank)'}
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  onClick={() =>
                                    void playWordAudio({
                                      word: r.word,
                                      audioDataUrl: rec?.audioDataUrl,
                                    })
                                  }
                                  className="px-2.5 py-1.5 rounded-lg bg-[#13291f] hover:bg-[#1a372a] text-xs font-bold text-[#10b981] flex items-center gap-1 shrink-0"
                                >
                                  <Volume2 className="w-3.5 h-3.5" />
                                  <span>Listen</span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-64 overflow-y-auto pr-1">
                          {revealedWords.map((w, idx) => (
                            <div
                              key={w.id}
                              className="p-2.5 rounded-xl bg-[#09140f] border border-[#173024] text-xs flex items-center justify-between gap-2"
                            >
                              <span className="font-mono font-bold text-white truncate">
                                #{idx + 1}. {w.word}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  void playWordAudio({
                                    word: w.word,
                                    audioDataUrl: recordingsMap[w.id]?.audioDataUrl,
                                    bundledAudioFile: w.bundledAudioFile,
                                  })
                                }
                                className="p-1.5 rounded-lg bg-[#13291f] text-[#10b981] shrink-0"
                              >
                                <Volume2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                );
              })()
            )}
          </div>
        </div>
        </div>
      )}
    </main>
  );
};
