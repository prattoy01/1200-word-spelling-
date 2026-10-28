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
} from 'lucide-react';
import { CATEGORIES, type WordItem } from '../data/words';
import {
  type CloudRecording,
  type SessionWordResult,
} from '../services/recordingsService';
import {
  type ContestRecord,
  type ContestSubmissionRecord,
  createScheduledContest,
  deleteOrCancelContest,
  registerForContest,
  submitContestExamResult,
  deriveContestWordDeck,
  getContestCandidatePool,
  getContestPhase,
} from '../services/contestService';
import { playWordAudio } from '../utils/audioUtils';
import { NoSuggestSpellingInput } from './NoSuggestSpellingInput';
import { signInQuickProfile, type User } from '../firebase';

interface ContestPlatformViewProps {
  user: User | null;
  isAdmin: boolean;
  onRequestSignIn: () => void;
  recordingsMap: Record<string, CloudRecording>;
  contests: ContestRecord[];
  submissions: ContestSubmissionRecord[];
  onBackToPractice: () => void;
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

function computeStrictWordExamTiming(
  word: WordItem,
  recording?: CloudRecording,
  baseWritingSec = 12
) {
  const singlePlayDurationMs = recording?.durationMs
    ? Math.max(900, Math.min(4500, recording.durationMs))
    : Math.max(950, Math.min(3200, word.word.length * 105));

  const pauseBetweenPlaysMs = 2100;
  const play1AtMs = 150;
  const play2AtMs = play1AtMs + singlePlayDurationMs + pauseBetweenPlaysMs;
  const play3AtMs = play2AtMs + singlePlayDurationMs + pauseBetweenPlaysMs;
  const threePlaysTotalSec = Math.ceil(
    (play3AtMs + singlePlayDurationMs) / 1000
  );

  const extraCharSec = Math.max(0, Math.ceil((word.word.length - 7) * 0.45));
  const totalWindowSec = Math.max(
    baseWritingSec,
    threePlaysTotalSec +
      Math.max(4, Math.floor(baseWritingSec * 0.55)) +
      extraCharSec
  );

  return {
    singlePlayDurationMs,
    play1AtMs,
    play2AtMs,
    play3AtMs,
    totalWindowSec,
  };
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
}) => {
  // Real-time 1-second clock so scheduled contests automatically unlock at the exact second
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  const [activeTab, setActiveTab] = useState<'contests' | 'create'>('contests');
  const [selectedContestId, setSelectedContestId] = useState<string | null>(
    null
  );
  const [autoStartWhenLive, setAutoStartWhenLive] = useState<boolean>(true);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

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

  // Active Running Contest Exam State
  const [runningContest, setRunningContest] = useState<ContestRecord | null>(
    null
  );
  const [contestDeck, setContestDeck] = useState<WordItem[]>([]);
  const [examIndex, setExamIndex] = useState<number>(0);
  const [examInput, setExamInput] = useState<string>('');
  const [examAnswers, setExamAnswers] = useState<SessionWordResult[]>([]);
  const [examRemainingMs, setExamRemainingMs] = useState<number>(12000);
  const [examTotalMs, setExamTotalMs] = useState<number>(12000);
  const [examPlayCount, setExamPlayCount] = useState<number>(0);
  const [examStartedAtMs, setExamStartedAtMs] = useState<number>(0);
  const [isSubmittingResult, setIsSubmittingResult] = useState<boolean>(false);

  const examInputRef = useRef<HTMLInputElement>(null);
  const latestExamInputRef = useRef<string>('');
  latestExamInputRef.current = examInput;

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
    // 3. Faster timeTakenMs first (tie-breaker!)
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

  const mySubmissionForSelected = useMemo(() => {
    if (!selectedContest || !currentUserIdSanitized) return undefined;
    const list = submissionsByContest[selectedContest.id] || [];
    return list.find((s) => s.userId === currentUserIdSanitized);
  }, [selectedContest, submissionsByContest, currentUserIdSanitized]);

  const ensureSignedInForContest = useCallback(async (): Promise<User | null> => {
    if (user) return user;
    const randNum = Math.floor(1000 + Math.random() * 9000);
    const chosenName =
      participantNameInput.trim() || `Participant #${randNum}`;
    const slug = chosenName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 24);
    const autoEmail = `${slug || 'student'}${randNum}@contest.listenwrite.app`;
    return signInQuickProfile({
      email: autoEmail,
      displayName: chosenName,
    });
  }, [user, participantNameInput]);

  // Launch the strict contest exam for a contest that is currently LIVE
  const handleStartLiveContestExam = useCallback(
    async (contest: ContestRecord) => {
      const activeUser = await ensureSignedInForContest();
      if (!activeUser) {
        onRequestSignIn();
        return;
      }
      const activeUserIdSanitized = activeUser.uid
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 120);
      const phase = getContestPhase(contest, Date.now());
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
          text: 'This contest window has already closed.',
        });
        return;
      }

      const existingSub = (submissionsByContest[contest.id] || []).find(
        (s) => s.userId === activeUserIdSanitized
      );
      if (existingSub?.status === 'completed') {
        setStatusMessage({
          type: 'error',
          text: 'You have already completed and submitted this contest exam!',
        });
        return;
      }

      // Derive the deterministic word deck (identical for all logged-in participants!)
      const derivedDeck = deriveContestWordDeck(contest, Date.now());
      if (derivedDeck.length === 0) {
        setStatusMessage({
          type: 'error',
          text: 'Could not load contest words.',
        });
        return;
      }

      setRunningContest(contest);
      setContestDeck(derivedDeck);
      setExamAnswers([]);
      setExamIndex(0);
      setExamInput('');
      latestExamInputRef.current = '';
      setExamStartedAtMs(Date.now());
    },
    [ensureSignedInForContest, onRequestSignIn, submissionsByContest]
  );

  // Auto-launch exam if the user registered for the selected contest, is waiting in the lobby,
  // and the countdown just transitioned to LIVE
  useEffect(() => {
    if (
      !autoStartWhenLive ||
      !user ||
      !selectedContest ||
      runningContest ||
      activeTab !== 'contests'
    ) {
      return;
    }
    const phase = getContestPhase(selectedContest, nowMs);
    if (
      phase === 'live' &&
      mySubmissionForSelected?.status === 'registered' &&
      nowMs - selectedContest.startTimeMs < 4000
    ) {
      void handleStartLiveContestExam(selectedContest);
    }
  }, [
    nowMs,
    autoStartWhenLive,
    user,
    selectedContest,
    runningContest,
    activeTab,
    mySubmissionForSelected,
    handleStartLiveContestExam,
  ]);

  // Strict Contest Exam: Advance word & auto-submit when finished
  const advanceContestWord = useCallback(
    (typedValue: string) => {
      if (!runningContest) return;
      const currentWord = contestDeck[examIndex];
      if (!currentWord) return;

      const rec = recordingsMap[currentWord.id];
      const cleanTyped = typedValue.trim();
      const matched = checkSpellingCorrect(cleanTyped, currentWord.word);

      const newResult: SessionWordResult = {
        wordId: currentWord.id,
        word: currentWord.word,
        userAnswer: cleanTyped,
        isCorrect: matched,
        bangla: rec?.banglaMeaning || currentWord.bangla,
        category: currentWord.category,
        page: currentWord.page,
      };

      const nextAnswers = [...examAnswers, newResult];
      setExamAnswers(nextAnswers);

      if (examIndex + 1 >= contestDeck.length) {
        // Contest Exam Completed! Submit immediately to live leaderboard
        const totalElapsedMs = Math.max(1000, Date.now() - examStartedAtMs);
        const correctTotal = nextAnswers.filter((a) => a.isCorrect).length;
        const existingSub = (
          submissionsByContest[runningContest.id] || []
        ).find((s) => s.userId === currentUserIdSanitized);

        setIsSubmittingResult(true);
        void submitContestExamResult({
          contest: runningContest,
          totalWords: nextAnswers.length,
          correctCount: correctTotal,
          timeTakenMs: totalElapsedMs,
          results: nextAnswers,
          existingSubmission: existingSub,
        })
          .then(() => {
            setSelectedContestId(runningContest.id);
            setRunningContest(null);
            setStatusMessage({
              type: 'success',
              text: `Contest submitted! You scored ${correctTotal}/${nextAnswers.length} in ${formatDurationMs(
                totalElapsedMs
              )}.`,
            });
          })
          .catch((err) => {
            setRunningContest(null);
            setStatusMessage({
              type: 'error',
              text:
                err instanceof Error
                  ? err.message
                  : 'Failed to submit contest score.',
            });
          })
          .finally(() => {
            setIsSubmittingResult(false);
          });
      } else {
        setExamInput('');
        latestExamInputRef.current = '';
        setExamIndex((idx) => idx + 1);
      }
    },
    [
      runningContest,
      contestDeck,
      examIndex,
      examAnswers,
      recordingsMap,
      examStartedAtMs,
      submissionsByContest,
      currentUserIdSanitized,
    ]
  );

  // Schedule 3 automatic audio plays with pauses + strict countdown timer for the active contest word
  useEffect(() => {
    if (!runningContest) return;
    const wordObj = contestDeck[examIndex];
    if (!wordObj) return;

    const rec = recordingsMap[wordObj.id];
    const timing = computeStrictWordExamTiming(
      wordObj,
      rec,
      runningContest.baseSeconds
    );
    const totalMs = timing.totalWindowSec * 1000;

    setExamTotalMs(totalMs);
    setExamRemainingMs(totalMs);
    setExamPlayCount(0);

    setTimeout(() => {
      examInputRef.current?.focus();
    }, 60);

    let cancelled = false;
    const triggerPlay = (playNumber: number) => {
      if (cancelled) return;
      setExamPlayCount(playNumber);
      void playWordAudio({
        word: wordObj.word,
        audioDataUrl: rec?.audioDataUrl,
        bundledAudioFile: wordObj.bundledAudioFile,
        playbackRate: 1.0,
      });
    };

    const t1 = window.setTimeout(() => triggerPlay(1), timing.play1AtMs);
    const t2 = window.setTimeout(() => triggerPlay(2), timing.play2AtMs);
    const t3 = window.setTimeout(() => triggerPlay(3), timing.play3AtMs);

    const startPerf = performance.now();
    const intervalId = window.setInterval(() => {
      if (cancelled) return;
      const elapsed = performance.now() - startPerf;
      const left = Math.max(0, totalMs - elapsed);
      setExamRemainingMs(left);
      if (left <= 0) {
        window.clearInterval(intervalId);
        advanceContestWord(latestExamInputRef.current);
      }
    }, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearInterval(intervalId);
    };
  }, [runningContest, examIndex, contestDeck, recordingsMap, advanceContestWord]);

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
        return;
      }
      scheduledStartMs = parsed;
    } else if (startPresetMins === 0) {
      // Immediate live contest (starts 3 seconds from now so setter also experiences the blind lock)
      scheduledStartMs = Date.now() + 3000;
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
        text: `Contest "${created.title}" scheduled! Words are cryptographically locked until start time — even you (the setter) cannot see them in advance.`,
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
  // ACTIVE STRICT CONTEST EXAM FULLSCREEN VIEW
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

    return (
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 sm:px-6 pt-6 pb-24 space-y-6">
        <section className="rounded-3xl bg-[#0d1d16] border-2 border-[#fbbf24]/60 p-5 sm:p-8 space-y-6 shadow-2xl">
          {/* Top Contest Lock Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1c382b]">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-1 rounded-lg bg-[#fbbf24]/15 border border-[#fbbf24]/40 text-[#fbbf24] text-xs font-bold flex items-center gap-1.5">
                <Trophy className="w-3.5 h-3.5" />
                <span>LIVE CONTEST: {runningContest.title}</span>
              </span>
              <span className="text-xs font-mono font-bold text-white">
                Word {examIndex + 1} of {contestDeck.length}
              </span>
            </div>

            <div className="flex items-center gap-2 text-xs font-mono font-bold text-[#fbbf24]">
              <Timer className="w-4 h-4 animate-pulse" />
              <span>{examSecondsLeft}s remaining</span>
            </div>
          </div>

          {/* Countdown Progress Bar */}
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
                  Automatic 3x Pronunciation Playback (Synchronized Exam)
                </div>
                <div className="text-[11px] text-[#8ba89a] mt-0.5">
                  Everyone in this contest receives the exact same words. No manual replay or going back.
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

          {/* Write-Only Input Form */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              advanceContestWord(examInput);
            }}
            className="space-y-4"
          >
            <div>
              <label
                htmlFor="contest-exam-input"
                className="block text-xs font-semibold text-[#9ab5a7] mb-2"
              >
                Type the word before the timer reaches 0.0s (Press Enter to submit early for faster tie-breaker time):
              </label>
              <NoSuggestSpellingInput
                id="contest-exam-input"
                inputRef={examInputRef}
                value={examInput}
                onChange={(val) => {
                  setExamInput(val);
                  latestExamInputRef.current = val;
                }}
                disabled={isSubmittingResult}
                placeholder="Write spelling here..."
                enterKeyHint="next"
                variant="exam"
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-1.5 text-[11px] text-[#7ea090]">
                <ShieldAlert className="w-4 h-4 text-[#fbbf24] shrink-0" />
                <span>
                  Strict Contest Lock: Ties on score are broken by fastest total completion time.
                </span>
              </div>

              <button
                type="submit"
                disabled={isSubmittingResult}
                className="min-h-[46px] px-5 py-2.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-bold text-xs sm:text-sm flex items-center gap-2 shrink-0 transition-colors"
              >
                <span>
                  {examIndex + 1 >= contestDeck.length
                    ? 'Finish & Submit Contest'
                    : 'Submit & Next Word'}
                </span>
              </button>
            </div>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 pt-5 pb-28 md:py-6 space-y-5">
      {/* Top Navigation & Blind Fair-Play Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBackToPractice}
          className="min-h-[40px] text-xs sm:text-sm font-semibold text-[#10b981] hover:text-[#34d399] flex items-center gap-1.5 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Practice &amp; Study</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('contests')}
            className={`min-h-[40px] px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors ${
              activeTab === 'contests'
                ? 'bg-[#10b981] text-[#04120c]'
                : 'bg-[#11241b] text-[#9ab5a7] hover:text-white border border-[#1f3d2f]'
            }`}
          >
            <Trophy className="w-4 h-4" />
            <span>Live &amp; Scheduled Contests ({contests.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('create')}
            className={`min-h-[40px] px-4 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-colors ${
              activeTab === 'create'
                ? 'bg-[#fbbf24] text-[#08120e]'
                : 'bg-[#fbbf24]/15 hover:bg-[#fbbf24]/25 text-[#fbbf24] border border-[#fbbf24]/40'
            }`}
          >
            <Plus className="w-4 h-4" />
            <span>Schedule New Contest</span>
          </button>
        </div>
      </div>

      {/* Hero Explanation Banner */}
      <section className="rounded-3xl bg-gradient-to-r from-[#0e241b] via-[#102a20] to-[#1a2514] border border-[#244b39] p-5 sm:p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
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
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* LEFT COLUMN (5 cols): Contest List */}
          <div className="lg:col-span-5 rounded-3xl bg-[#0d1d16] border border-[#1d382b] p-4 sm:p-5 space-y-3.5">
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
                  const endTimeMs =
                    contest.startTimeMs + contest.durationMinutes * 60 * 1000;

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
                            ? `Closes in ${formatCountdown(endTimeMs - nowMs)}`
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

          {/* RIGHT COLUMN (7 cols): Selected Contest Lobby, Blind Lock Status & Live Leaderboard */}
          <div className="lg:col-span-7 rounded-3xl bg-[#0d1d16] border border-[#1d382b] p-5 sm:p-6 space-y-5">
            {!selectedContest ? (
              <div className="py-16 text-center text-sm text-[#8ba89a]">
                Select a contest on the left or schedule a new one to view the lobby and live leaderboard.
              </div>
            ) : (
              (() => {
                const phase = getContestPhase(selectedContest, nowMs);
                const endTimeMs =
                  selectedContest.startTimeMs +
                  selectedContest.durationMinutes * 60 * 1000;
                const contestSubs =
                  submissionsByContest[selectedContest.id] || [];
                const canDelete =
                  isAdmin ||
                  (Boolean(user) &&
                    selectedContest.creatorId === currentUserIdSanitized);

                // Words are ONLY revealed if the user has completed the contest OR the contest has ended
                const canRevealWords =
                  phase === 'ended' ||
                  mySubmissionForSelected?.status === 'completed';
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
                              OPEN FOR ALL LOGGED-IN USERS
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
                          ({selectedContest.baseSeconds}s+ strict timer)
                        </p>
                      </div>

                      {canDelete && (
                        <button
                          type="button"
                          onClick={async () => {
                            await deleteOrCancelContest(selectedContest.id);
                            setStatusMessage({
                              type: 'success',
                              text: 'Contest removed.',
                            });
                          }}
                          className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#2a1215] hover:bg-[#3b181d] border border-[#f87171]/40 text-xs font-semibold text-[#f87171] flex items-center gap-1.5"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Delete</span>
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

                          <div className="flex flex-col gap-2 shrink-0">
                            {!user && (
                              <input
                                type="text"
                                value={participantNameInput}
                                onChange={(e) =>
                                  setParticipantNameInput(e.target.value)
                                }
                                placeholder="Your Name for Leaderboard..."
                                className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#08130e] border border-[#fbbf24]/50 text-xs text-white placeholder-[#6d8a7b] focus:outline-none"
                              />
                            )}
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
                                  await ensureSignedInForContest();
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
                                Contest is LIVE Now! Open for All Logged-In Users
                              </span>
                            </div>
                            <div className="text-lg sm:text-xl font-bold text-white">
                              Closes in {formatCountdown(endTimeMs - nowMs)}
                            </div>
                            <p className="text-xs text-[#a7f3d0]">
                              Same rules as Strict Test: 3x automatic audio per word, strict timer, no replay.
                            </p>
                          </div>

                          <div className="flex flex-col gap-2 shrink-0">
                            {!user && (
                              <input
                                type="text"
                                value={participantNameInput}
                                onChange={(e) =>
                                  setParticipantNameInput(e.target.value)
                                }
                                placeholder="Your Name for Leaderboard..."
                                className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#08130e] border border-[#10b981]/50 text-xs text-white placeholder-[#6d8a7b] focus:outline-none"
                              />
                            )}
                            {mySubmissionForSelected?.status === 'completed' ? (
                              <div className="px-4 py-3 rounded-xl bg-[#081610] border border-[#10b981]/50 text-[#10b981] text-xs font-bold flex items-center gap-2 shrink-0">
                                <CheckCircle2 className="w-4 h-4" />
                                <span>
                                  Completed: {mySubmissionForSelected.correctCount}/
                                  {mySubmissionForSelected.totalWords} (
                                  {mySubmissionForSelected.accuracy}%)
                                </span>
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
                                <span>Enter Strict Contest Exam Now</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-2xl bg-[#09140f] border border-[#183126] p-4 flex items-center justify-between gap-3">
                        <div className="text-xs text-[#8ba89a]">
                          This contest has ended. Official standings and contest words are unlocked below.
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
                          Ranked by Score &rarr; Fastest Time
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
                                        ? `Finished in ${formatDurationMs(
                                            sub.timeTakenMs
                                          )}`
                                        : 'Waiting in Lobby / In Progress'}
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

                    {/* Post-Completion / Post-Contest Word & Answer Sheet Reveal */}
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
                            <strong>Cryptographic Blind Lock Active:</strong>{' '}
                            Neither the contest setter nor participants can view
                            the contest words until they complete the live exam
                            (or the contest ends).
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
      )}
    </main>
  );
};
