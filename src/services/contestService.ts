import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  limit,
  serverTimestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { WORDS_CATALOG, type WordItem } from '../data/words';
import {
  type SessionWordResult,
  savePracticeSession,
} from './recordingsService';

export interface ContestRecord {
  id: string;
  title: string;
  creatorId: string;
  creatorName: string;
  pageFilter: 'page1' | 'page2' | 'all';
  categories: string[];
  wordCount: number;
  baseSeconds: number;
  showBangla: boolean;
  startTimeMs: number;
  durationMinutes: number;
  randomSeed: string;
  status: 'active' | 'cancelled';
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ContestSubmissionRecord {
  id: string;
  contestId: string;
  userId: string;
  userName: string;
  userEmail: string;
  status: 'registered' | 'in_progress' | 'completed';
  totalWords: number;
  correctCount: number;
  accuracy: number;
  timeTakenMs: number;
  results?: SessionWordResult[];
  createdAtMs: number;
  updatedAtMs: number;
}

const CONTESTS_PATH = 'contests';
const SUBMISSIONS_PATH = 'contestSubmissions';
const LOCAL_CONTESTS_KEY = 'lw_contests_cache_v1';
const LOCAL_SUBMISSIONS_KEY = 'lw_contest_submissions_cache_v1';

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'user';
}

function generateRandomSeed(): string {
  const arr = new Uint32Array(4);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < 4; i++) {
      arr[i] = Math.floor(Math.random() * 0xffffffff);
    }
  }
  return Array.from(arr, (n) => n.toString(16).padStart(8, '0')).join('');
}

/**
 * Deterministic 128-bit string hash -> 32-bit PRNG (mulberry32)
 * Ensures every logged-in participant gets the exact same words in the exact same order
 * at contest start time without anyone (including the setter) seeing the words beforehand.
 */
function createSeededPrng(seedString: string): () => number {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seedString.length; i++) {
    const k = seedString.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  let a = (h1 ^ h2 ^ h3 ^ h4) >>> 0;

  return function mulberry32() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns the candidate pool size for a given pageFilter and categories list.
 */
export function getContestCandidatePool(
  pageFilter: 'page1' | 'page2' | 'all',
  categories: string[]
): WordItem[] {
  return WORDS_CATALOG.filter((w) => {
    if (pageFilter === 'page1' && w.page !== 1) return false;
    if (pageFilter === 'page2' && w.page !== 2) return false;
    if (categories.length > 0 && !categories.includes(w.category)) return false;
    return true;
  });
}

export interface ContestWordSlot {
  index: number;
  word: WordItem;
  startMs: number;
  endMs: number;
  durationMs: number;
  play1AtMs: number;
  play2AtMs: number;
  play3AtMs: number;
}

export interface ContestAttemptLockedWord {
  userAnswer: string;
  lockedAfterMs: number;
  lockedAtWallMs: number;
  autoLockedByTabSwitch?: boolean;
  missedWhileAway?: boolean;
}

export interface ContestAttemptCheckpoint {
  contestId: string;
  userId: string;
  userName: string;
  status: 'in_progress' | 'completed';
  lockedWords: Record<number, ContestAttemptLockedWord>;
  tabSwitchCount: number;
  startedAtMs: number;
  updatedAtMs: number;
}

const LOCAL_ATTEMPT_LOCKS_KEY = 'lw_contest_attempt_locks_v2';

export function computeDeterministicWordTiming(
  word: WordItem,
  baseWritingSec = 12
) {
  const singlePlayDurationMs = Math.max(
    950,
    Math.min(3200, word.word.length * 105)
  );
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
    durationMs: totalWindowSec * 1000,
  };
}

function deriveDeckUnconditionalInternal(contest: ContestRecord): WordItem[] {
  const pool = [
    ...getContestCandidatePool(contest.pageFilter, contest.categories),
  ];
  if (pool.length === 0) return [];
  pool.sort((a, b) => a.id.localeCompare(b.id));

  const seedMaterial = `${contest.id}::${contest.randomSeed}::${contest.startTimeMs}::${contest.wordCount}`;
  const rand = createSeededPrng(seedMaterial);

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const targetCount = Math.max(1, Math.min(pool.length, contest.wordCount));
  return pool.slice(0, targetCount);
}

/**
 * Deterministically derives the exact contest word deck ONLY once the contest start time has arrived.
 * Before `contest.startTimeMs`, this returns `[]` so even the contest setter cannot see the words.
 */
export function deriveContestWordDeck(
  contest: ContestRecord,
  currentNowMs: number = Date.now()
): WordItem[] {
  if (currentNowMs < contest.startTimeMs) {
    // Strictly blind before exam start time — nobody (not even the setter) can see the words
    return [];
  }
  return deriveDeckUnconditionalInternal(contest);
}

/**
 * Computes the exact synchronized broadcast timeline for a contest.
 * Every participant hears Word #1 at `contest.startTimeMs` and finishes the last word at the exact same `endTimeMs`.
 */
export function getContestSynchronizedSummary(contest: ContestRecord): {
  totalDurationMs: number;
  startTimeMs: number;
  endTimeMs: number;
} {
  const deck = deriveDeckUnconditionalInternal(contest);
  let totalDurationMs = 0;
  for (const w of deck) {
    totalDurationMs += computeDeterministicWordTiming(
      w,
      contest.baseSeconds
    ).durationMs;
  }
  if (totalDurationMs <= 0) {
    totalDurationMs = Math.max(60000, contest.wordCount * 15000);
  }
  return {
    totalDurationMs,
    startTimeMs: contest.startTimeMs,
    endTimeMs: contest.startTimeMs + totalDurationMs,
  };
}

/**
 * Returns the exact simultaneous end timestamp (ms) when the final word finishes for all participants.
 */
export function getContestEndTimeMs(contest: ContestRecord): number {
  return getContestSynchronizedSummary(contest).endTimeMs;
}

/**
 * Returns the live word slots ONLY once `nowMs >= contest.startTimeMs`.
 */
export function getLiveContestTimeline(
  contest: ContestRecord,
  nowMs: number = Date.now()
): {
  slots: ContestWordSlot[];
  activeSlotIndex: number;
  startTimeMs: number;
  endTimeMs: number;
  isFinished: boolean;
} {
  const deck = deriveContestWordDeck(contest, nowMs);
  const slots: ContestWordSlot[] = [];
  let cursorMs = contest.startTimeMs;

  for (let i = 0; i < deck.length; i++) {
    const w = deck[i];
    const t = computeDeterministicWordTiming(w, contest.baseSeconds);
    slots.push({
      index: i,
      word: w,
      startMs: cursorMs,
      endMs: cursorMs + t.durationMs,
      durationMs: t.durationMs,
      play1AtMs: t.play1AtMs,
      play2AtMs: t.play2AtMs,
      play3AtMs: t.play3AtMs,
    });
    cursorMs += t.durationMs;
  }

  const endTimeMs =
    slots.length > 0 ? slots[slots.length - 1].endMs : contest.startTimeMs;
  if (nowMs >= endTimeMs || slots.length === 0) {
    return {
      slots,
      activeSlotIndex: Math.max(0, slots.length - 1),
      startTimeMs: contest.startTimeMs,
      endTimeMs,
      isFinished: nowMs >= endTimeMs,
    };
  }

  let activeIdx = 0;
  for (let i = 0; i < slots.length; i++) {
    if (nowMs >= slots[i].startMs && nowMs < slots[i].endMs) {
      activeIdx = i;
      break;
    }
    if (nowMs >= slots[i].endMs) {
      activeIdx = i;
    }
  }

  return {
    slots,
    activeSlotIndex: activeIdx,
    startTimeMs: contest.startTimeMs,
    endTimeMs,
    isFinished: false,
  };
}

export function getContestPhase(
  contest: ContestRecord,
  nowMs: number = Date.now()
): 'upcoming' | 'live' | 'ended' | 'cancelled' {
  if (contest.status === 'cancelled') return 'cancelled';
  const endTimeMs = getContestEndTimeMs(contest);
  if (nowMs < contest.startTimeMs) return 'upcoming';
  if (nowMs < endTimeMs) return 'live';
  return 'ended';
}

function readAllAttemptLocks(): Record<string, ContestAttemptCheckpoint> {
  try {
    const raw = localStorage.getItem(LOCAL_ATTEMPT_LOCKS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getDeviceContestLock(
  contestId: string
): ContestAttemptCheckpoint | null {
  const all = readAllAttemptLocks();
  return all[contestId] || null;
}

export function saveDeviceContestCheckpoint(
  checkpoint: ContestAttemptCheckpoint
): void {
  try {
    const all = readAllAttemptLocks();
    all[checkpoint.contestId] = checkpoint;
    localStorage.setItem(LOCAL_ATTEMPT_LOCKS_KEY, JSON.stringify(all));
  } catch {
    // Ignore storage quota warnings
  }
}

function readLocalContests(): ContestRecord[] {
  try {
    const raw = localStorage.getItem(LOCAL_CONTESTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const CONTEST_BROADCAST_CHANNEL = 'lw_contest_realtime_sync_v1';

function notifyContestSyncListeners(): void {
  if (typeof window === 'undefined') return;
  try {
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel(CONTEST_BROADCAST_CHANNEL);
      bc.postMessage({ type: 'CONTEST_DATA_UPDATED', ts: Date.now() });
      bc.close();
    }
    window.dispatchEvent(new CustomEvent('lw-contest-local-update'));
  } catch {
    // Ignore BroadcastChannel errors
  }
}

function writeLocalContests(list: ContestRecord[]): void {
  try {
    localStorage.setItem(LOCAL_CONTESTS_KEY, JSON.stringify(list.slice(0, 80)));
    notifyContestSyncListeners();
  } catch {
    // Ignore storage quota warnings
  }
}

function readLocalSubmissions(): ContestSubmissionRecord[] {
  try {
    const raw = localStorage.getItem(LOCAL_SUBMISSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalSubmissions(list: ContestSubmissionRecord[]): void {
  try {
    localStorage.setItem(
      LOCAL_SUBMISSIONS_KEY,
      JSON.stringify(list.slice(0, 200))
    );
    notifyContestSyncListeners();
  } catch {
    // Ignore storage quota warnings
  }
}

/**
 * Creates a new scheduled blind contest.
 * The word list is NOT chosen by the setter; a cryptographic randomSeed is stored so words
 * are deterministically generated only when the scheduled startTimeMs arrives.
 */
export async function createScheduledContest(params: {
  title: string;
  pageFilter: 'page1' | 'page2' | 'all';
  categories: string[];
  wordCount: number;
  baseSeconds: number;
  showBangla: boolean;
  startTimeMs: number;
  durationMinutes: number;
}): Promise<ContestRecord> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Please sign in to create or schedule a contest.');
  }

  const nowMs = Date.now();
  const contestId = `contest_${nowMs}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const creatorId = sanitizeId(user.uid);
  const creatorName = (
    user.displayName ||
    user.email?.split('@')[0] ||
    'Contest Setter'
  )
    .trim()
    .slice(0, 120);

  const safeTitle =
    params.title.trim().slice(0, 140) || 'IELTS Live Spelling Contest';
  const safeCategories = params.categories
    .map((c) => c.trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, 50);

  const poolSize = Math.max(
    1,
    getContestCandidatePool(params.pageFilter, safeCategories).length
  );
  const safeWordCount = Math.max(
    1,
    Math.min(200, Math.min(poolSize, Math.round(params.wordCount)))
  );
  const safeBaseSeconds = Math.max(
    5,
    Math.min(60, Math.round(params.baseSeconds))
  );
  const safeDurationMinutes = Math.max(
    5,
    Math.min(1440, Math.round(params.durationMinutes))
  );
  const safeStartTimeMs = Math.max(1700000000000, Math.round(params.startTimeMs));
  const randomSeed = generateRandomSeed();

  const record: ContestRecord = {
    id: contestId,
    title: safeTitle,
    creatorId,
    creatorName,
    pageFilter: params.pageFilter,
    categories: safeCategories,
    wordCount: safeWordCount,
    baseSeconds: safeBaseSeconds,
    showBangla: Boolean(params.showBangla),
    startTimeMs: safeStartTimeMs,
    durationMinutes: safeDurationMinutes,
    randomSeed,
    status: 'active',
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };

  const existingLocal = readLocalContests().filter((c) => c.id !== contestId);
  writeLocalContests([record, ...existingLocal]);

  try {
    const docRef = doc(db, CONTESTS_PATH, contestId);
    await setDoc(docRef, {
      id: record.id,
      title: record.title,
      creatorId: record.creatorId,
      creatorName: record.creatorName,
      pageFilter: record.pageFilter,
      categories: record.categories,
      wordCount: record.wordCount,
      baseSeconds: record.baseSeconds,
      showBangla: record.showBangla,
      startTimeMs: record.startTimeMs,
      durationMinutes: record.durationMinutes,
      randomSeed: record.randomSeed,
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Contest saved locally (cloud quota/offline fallback):', err);
  }

  return record;
}

export async function deleteOrCancelContest(contestId: string): Promise<void> {
  const existingLocal = readLocalContests().filter((c) => c.id !== contestId);
  writeLocalContests(existingLocal);
  try {
    await deleteDoc(doc(db, CONTESTS_PATH, contestId));
  } catch {
    try {
      await updateDoc(doc(db, CONTESTS_PATH, contestId), {
        status: 'cancelled',
        updatedAt: serverTimestamp(),
      });
    } catch {
      // Ignore if offline or quota reached
    }
  }
}

export function getSubmissionDocId(contestId: string, userId: string): string {
  return `${sanitizeId(contestId)}_${sanitizeId(userId)}`.slice(0, 128);
}

/**
 * Registers a logged-in user into the contest lobby before or during the contest.
 */
export async function registerForContest(
  contest: ContestRecord
): Promise<ContestSubmissionRecord> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Please sign in to register for this contest.');
  }

  const userId = sanitizeId(user.uid);
  const subId = getSubmissionDocId(contest.id, userId);
  const userName = (
    user.displayName ||
    user.email?.split('@')[0] ||
    'Participant'
  )
    .trim()
    .slice(0, 120);
  const userEmail = (user.email || '').trim().slice(0, 160);
  const nowMs = Date.now();

  const record: ContestSubmissionRecord = {
    id: subId,
    contestId: contest.id,
    userId,
    userName,
    userEmail,
    status: 'registered',
    totalWords: contest.wordCount,
    correctCount: 0,
    accuracy: 0,
    timeTakenMs: 0,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };

  const localList = readLocalSubmissions().filter((s) => s.id !== subId);
  writeLocalSubmissions([record, ...localList]);

  try {
    await setDoc(doc(db, SUBMISSIONS_PATH, subId), {
      id: record.id,
      contestId: record.contestId,
      userId: record.userId,
      userName: record.userName,
      userEmail: record.userEmail,
      status: 'registered',
      totalWords: record.totalWords,
      correctCount: 0,
      accuracy: 0,
      timeTakenMs: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Contest registration saved locally (cloud quota/offline fallback):', err);
  }

  return record;
}

/**
 * Marks a user's contest attempt as 'in_progress' in both local cache and Cloud Firestore
 * so leaving or refreshing the page can never reset their attempt back to 'registered' or Word 1.
 */
export async function markContestAttemptInProgress(params: {
  contest: ContestRecord;
  existingSubmission?: ContestSubmissionRecord;
  correctCountSoFar?: number;
  timeTakenMsSoFar?: number;
}): Promise<ContestSubmissionRecord> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Please sign in to enter this contest.');
  }

  const userId = sanitizeId(user.uid);
  const subId = getSubmissionDocId(params.contest.id, userId);
  const userName = (
    user.displayName ||
    user.email?.split('@')[0] ||
    'Participant'
  )
    .trim()
    .slice(0, 120);
  const userEmail = (user.email || '').trim().slice(0, 160);
  const nowMs = Date.now();
  const totalWords = Math.max(1, Math.min(200, params.contest.wordCount));
  const correctCount = Math.max(
    0,
    Math.min(totalWords, Math.round(params.correctCountSoFar || 0))
  );
  const accuracy = Math.round((correctCount / totalWords) * 100);
  const timeTakenMs = Math.max(
    0,
    Math.min(7200000, Math.round(params.timeTakenMsSoFar || 0))
  );

  const record: ContestSubmissionRecord = {
    id: subId,
    contestId: params.contest.id,
    userId,
    userName,
    userEmail,
    status: 'in_progress',
    totalWords,
    correctCount,
    accuracy,
    timeTakenMs,
    createdAtMs: params.existingSubmission?.createdAtMs || nowMs,
    updatedAtMs: nowMs,
  };

  const localList = readLocalSubmissions().filter((s) => s.id !== subId);
  writeLocalSubmissions([record, ...localList]);

  const docRef = doc(db, SUBMISSIONS_PATH, subId);
  try {
    if (params.existingSubmission) {
      await updateDoc(docRef, {
        userName: record.userName,
        userEmail: record.userEmail,
        status: 'in_progress',
        totalWords: record.totalWords,
        correctCount: record.correctCount,
        accuracy: record.accuracy,
        timeTakenMs: record.timeTakenMs,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(docRef, {
        id: record.id,
        contestId: record.contestId,
        userId: record.userId,
        userName: record.userName,
        userEmail: record.userEmail,
        status: 'in_progress',
        totalWords: record.totalWords,
        correctCount: record.correctCount,
        accuracy: record.accuracy,
        timeTakenMs: record.timeTakenMs,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch {
    // Ignore transient cloud sync error; local checkpoint is already saved
  }

  return record;
}

/**
 * Submits a user's completed strict contest exam to the live leaderboard.
 */
export async function submitContestExamResult(params: {
  contest: ContestRecord;
  totalWords: number;
  correctCount: number;
  timeTakenMs: number;
  results: SessionWordResult[];
  existingSubmission?: ContestSubmissionRecord;
}): Promise<ContestSubmissionRecord> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Please sign in to submit your contest exam.');
  }

  const userId = sanitizeId(user.uid);
  const subId = getSubmissionDocId(params.contest.id, userId);
  const userName = (
    user.displayName ||
    user.email?.split('@')[0] ||
    'Participant'
  )
    .trim()
    .slice(0, 120);
  const userEmail = (user.email || '').trim().slice(0, 160);

  const totalWords = Math.max(1, Math.min(200, Math.round(params.totalWords)));
  const correctCount = Math.max(
    0,
    Math.min(totalWords, Math.round(params.correctCount))
  );
  const accuracy = Math.round((correctCount / totalWords) * 100);
  const timeTakenMs = Math.max(
    0,
    Math.min(7200000, Math.round(params.timeTakenMs))
  );

  const sanitizedResults: SessionWordResult[] = params.results
    .slice(0, 200)
    .map((r) => ({
      wordId: String(r.wordId || '').slice(0, 128),
      word: String(r.word || '').slice(0, 120),
      userAnswer: String(r.userAnswer || '').slice(0, 160),
      isCorrect: Boolean(r.isCorrect),
      bangla: String(r.bangla || '').slice(0, 200),
      category: String(r.category || '').slice(0, 100),
      page: r.page === 2 ? 2 : 1,
    }));

  const nowMs = Date.now();
  const record: ContestSubmissionRecord = {
    id: subId,
    contestId: params.contest.id,
    userId,
    userName,
    userEmail,
    status: 'completed',
    totalWords,
    correctCount,
    accuracy,
    timeTakenMs,
    results: sanitizedResults,
    createdAtMs: params.existingSubmission?.createdAtMs || nowMs,
    updatedAtMs: nowMs,
  };

  const localList = readLocalSubmissions().filter((s) => s.id !== subId);
  writeLocalSubmissions([record, ...localList]);

  const docRef = doc(db, SUBMISSIONS_PATH, subId);
  try {
    if (params.existingSubmission) {
      await updateDoc(docRef, {
        userName: record.userName,
        userEmail: record.userEmail,
        status: 'completed',
        totalWords: record.totalWords,
        correctCount: record.correctCount,
        accuracy: record.accuracy,
        timeTakenMs: record.timeTakenMs,
        results: sanitizedResults,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(docRef, {
        id: record.id,
        contestId: record.contestId,
        userId: record.userId,
        userName: record.userName,
        userEmail: record.userEmail,
        status: 'completed',
        totalWords: record.totalWords,
        correctCount: record.correctCount,
        accuracy: record.accuracy,
        timeTakenMs: record.timeTakenMs,
        results: sanitizedResults,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch {
    try {
      await setDoc(docRef, {
        id: record.id,
        contestId: record.contestId,
        userId: record.userId,
        userName: record.userName,
        userEmail: record.userEmail,
        status: 'completed',
        totalWords: record.totalWords,
        correctCount: record.correctCount,
        accuracy: record.accuracy,
        timeTakenMs: record.timeTakenMs,
        results: sanitizedResults,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('Contest submission saved locally (cloud quota/offline fallback):', err);
    }
  }

  // Also save to the user's personal Practice/Exam history so their per-word accuracy bars update!
  await savePracticeSession({
    category: `Contest: ${params.contest.title}`,
    totalWords,
    correctCount,
    results: sanitizedResults,
  });

  return record;
}

function sortContestsLiveFirst(list: ContestRecord[]): ContestRecord[] {
  const now = Date.now();
  const phaseRank = (c: ContestRecord) => {
    const p = getContestPhase(c, now);
    if (p === 'live') return 0;
    if (p === 'upcoming') return 1;
    if (p === 'ended') return 2;
    return 3;
  };
  return [...list].sort((a, b) => {
    const rA = phaseRank(a);
    const rB = phaseRank(b);
    if (rA !== rB) return rA - rB;
    if (rA === 1) {
      // Upcoming: soonest start time first
      return a.startTimeMs - b.startTimeMs;
    }
    // Live or Ended: newest start time first
    return b.startTimeMs - a.startTimeMs;
  });
}

/**
 * Actively fetches all contests & submissions from Cloud Firestore and merges any unsynced local contests.
 */
export async function syncContestsNow(): Promise<{
  contests: ContestRecord[];
  submissions: ContestSubmissionRecord[];
}> {
  try {
    const qContests = query(
      collection(db, CONTESTS_PATH),
      where('status', 'in', ['active', 'cancelled']),
      limit(60)
    );
    const qSubs = query(
      collection(db, SUBMISSIONS_PATH),
      where('status', 'in', ['registered', 'in_progress', 'completed']),
      limit(200)
    );

    const [contestSnap, subSnap] = await Promise.all([
      getDocs(qContests),
      getDocs(qSubs),
    ]);

    const cloudIds = new Set<string>();
    const cancelledIds = new Set<string>();
    const list: ContestRecord[] = [];

    contestSnap.forEach((docSnap) => {
      const d = docSnap.data();
      const cid = d.id || docSnap.id;
      cloudIds.add(cid);
      if (d.status === 'cancelled') {
        cancelledIds.add(cid);
        return;
      }
      list.push({
        id: cid,
        title: d.title || 'IELTS Spelling Contest',
        creatorId: d.creatorId || 'user',
        creatorName: d.creatorName || 'Setter',
        pageFilter:
          d.pageFilter === 'page1' || d.pageFilter === 'page2'
            ? d.pageFilter
            : 'all',
        categories: Array.isArray(d.categories) ? d.categories : [],
        wordCount: Number(d.wordCount) || 10,
        baseSeconds: Number(d.baseSeconds) || 12,
        showBangla: Boolean(d.showBangla),
        startTimeMs: Number(d.startTimeMs) || Date.now(),
        durationMinutes: Number(d.durationMinutes) || 30,
        randomSeed: String(d.randomSeed || 'default_seed_12345'),
        status: 'active',
        createdAtMs: d.createdAt?.toMillis?.() || Date.now(),
        updatedAtMs: d.updatedAt?.toMillis?.() || Date.now(),
      });
    });

    const localContests = readLocalContests();
    for (const loc of localContests) {
      if (
        loc.status === 'active' &&
        !cloudIds.has(loc.id) &&
        !cancelledIds.has(loc.id)
      ) {
        list.push(loc);
      }
    }

    const sortedContests = sortContestsLiveFirst(list);
    writeLocalContests(sortedContests);

    const cloudSubIds = new Set<string>();
    const subList: ContestSubmissionRecord[] = [];
    subSnap.forEach((docSnap) => {
      const d = docSnap.data();
      const sid = d.id || docSnap.id;
      cloudSubIds.add(sid);
      subList.push({
        id: sid,
        contestId: d.contestId || '',
        userId: d.userId || '',
        userName: d.userName || 'Participant',
        userEmail: d.userEmail || '',
        status:
          d.status === 'completed' || d.status === 'in_progress'
            ? d.status
            : 'registered',
        totalWords: Number(d.totalWords) || 10,
        correctCount: Number(d.correctCount) || 0,
        accuracy: Number(d.accuracy) || 0,
        timeTakenMs: Number(d.timeTakenMs) || 0,
        results: Array.isArray(d.results) ? d.results : undefined,
        createdAtMs: d.createdAt?.toMillis?.() || Date.now(),
        updatedAtMs: d.updatedAt?.toMillis?.() || Date.now(),
      });
    });

    for (const locSub of readLocalSubmissions()) {
      if (!cloudSubIds.has(locSub.id)) {
        subList.push(locSub);
      }
    }
    writeLocalSubmissions(subList);

    return { contests: sortedContests, submissions: subList };
  } catch (err) {
    console.warn('Contest sync using local cache (quota/offline fallback):', err);
    return {
      contests: sortContestsLiveFirst(readLocalContests()),
      submissions: readLocalSubmissions(),
    };
  }
}

/**
 * Subscribes to all active contests in real time (with local storage & BroadcastChannel sync).
 */
export function subscribeToContests(
  onUpdate: (contests: ContestRecord[]) => void
): Unsubscribe {
  const emitLocal = () => {
    onUpdate(sortContestsLiveFirst(readLocalContests()));
  };
  emitLocal();

  const q = query(
    collection(db, CONTESTS_PATH),
    where('status', 'in', ['active', 'cancelled']),
    limit(60)
  );

  const processDocs = (
    docs: Array<{ id: string; data: () => Record<string, any> }>
  ) => {
    const cloudIds = new Set<string>();
    const cancelledIds = new Set<string>();
    const list: ContestRecord[] = [];

    docs.forEach((docSnap) => {
      const d = docSnap.data();
      const cid = d.id || docSnap.id;
      cloudIds.add(cid);
      if (d.status === 'cancelled') {
        cancelledIds.add(cid);
        return;
      }
      list.push({
        id: cid,
        title: d.title || 'IELTS Spelling Contest',
        creatorId: d.creatorId || 'user',
        creatorName: d.creatorName || 'Setter',
        pageFilter:
          d.pageFilter === 'page1' || d.pageFilter === 'page2'
            ? d.pageFilter
            : 'all',
        categories: Array.isArray(d.categories) ? d.categories : [],
        wordCount: Number(d.wordCount) || 10,
        baseSeconds: Number(d.baseSeconds) || 12,
        showBangla: Boolean(d.showBangla),
        startTimeMs: Number(d.startTimeMs) || Date.now(),
        durationMinutes: Number(d.durationMinutes) || 30,
        randomSeed: String(d.randomSeed || 'default_seed_12345'),
        status: 'active',
        createdAtMs: d.createdAt?.toMillis?.() || Date.now(),
        updatedAtMs: d.updatedAt?.toMillis?.() || Date.now(),
      });
    });

    const localContests = readLocalContests();
    for (const loc of localContests) {
      if (
        loc.status === 'active' &&
        !cloudIds.has(loc.id) &&
        !cancelledIds.has(loc.id)
      ) {
        list.push(loc);
      }
    }

    const sorted = sortContestsLiveFirst(list);
    try {
      localStorage.setItem(LOCAL_CONTESTS_KEY, JSON.stringify(sorted.slice(0, 80)));
    } catch {
      // ignore
    }
    onUpdate(sorted);
  };

  const unsubSnapshot = onSnapshot(
    q,
    (snapshot) => {
      const docs: Array<{ id: string; data: () => Record<string, any> }> = [];
      snapshot.forEach((docSnap) => docs.push(docSnap));
      processDocs(docs);
    },
    (err) => {
      console.warn('Contest subscription operating from local cache:', err);
      emitLocal();
    }
  );

  let bc: BroadcastChannel | null = null;
  const onStorageChange = (e: StorageEvent) => {
    if (!e.key || e.key === LOCAL_CONTESTS_KEY) {
      emitLocal();
    }
  };
  const onLocalCustomUpdate = () => emitLocal();

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorageChange);
    window.addEventListener('lw-contest-local-update', onLocalCustomUpdate);
    try {
      if ('BroadcastChannel' in window) {
        bc = new BroadcastChannel(CONTEST_BROADCAST_CHANNEL);
        bc.onmessage = () => emitLocal();
      }
    } catch {
      // ignore
    }
  }

  return () => {
    unsubSnapshot();
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorageChange);
      window.removeEventListener('lw-contest-local-update', onLocalCustomUpdate);
    }
    if (bc) {
      try {
        bc.close();
      } catch {
        // ignore
      }
    }
  };
}

/**
 * Subscribes to contest submissions for live leaderboard updates.
 */
export function subscribeToContestSubmissions(
  onUpdate: (submissions: ContestSubmissionRecord[]) => void
): Unsubscribe {
  const emitLocal = () => {
    onUpdate(readLocalSubmissions());
  };
  emitLocal();

  const q = query(
    collection(db, SUBMISSIONS_PATH),
    where('status', 'in', ['registered', 'in_progress', 'completed']),
    limit(200)
  );

  const processSubDocs = (
    docs: Array<{ id: string; data: () => Record<string, any> }>
  ) => {
    const cloudSubIds = new Set<string>();
    const list: ContestSubmissionRecord[] = [];
    docs.forEach((docSnap) => {
      const d = docSnap.data();
      const sid = d.id || docSnap.id;
      cloudSubIds.add(sid);
      list.push({
        id: sid,
        contestId: d.contestId || '',
        userId: d.userId || '',
        userName: d.userName || 'Participant',
        userEmail: d.userEmail || '',
        status:
          d.status === 'completed' || d.status === 'in_progress'
            ? d.status
            : 'registered',
        totalWords: Number(d.totalWords) || 10,
        correctCount: Number(d.correctCount) || 0,
        accuracy: Number(d.accuracy) || 0,
        timeTakenMs: Number(d.timeTakenMs) || 0,
        results: Array.isArray(d.results) ? d.results : undefined,
        createdAtMs: d.createdAt?.toMillis?.() || Date.now(),
        updatedAtMs: d.updatedAt?.toMillis?.() || Date.now(),
      });
    });

    for (const locSub of readLocalSubmissions()) {
      if (!cloudSubIds.has(locSub.id)) {
        list.push(locSub);
      }
    }

    try {
      localStorage.setItem(
        LOCAL_SUBMISSIONS_KEY,
        JSON.stringify(list.slice(0, 200))
      );
    } catch {
      // ignore
    }
    onUpdate(list);
  };

  const unsubSnapshot = onSnapshot(
    q,
    (snapshot) => {
      const docs: Array<{ id: string; data: () => Record<string, any> }> = [];
      snapshot.forEach((docSnap) => docs.push(docSnap));
      processSubDocs(docs);
    },
    (err) => {
      console.warn('Contest submissions operating from local cache:', err);
      emitLocal();
    }
  );

  let bc: BroadcastChannel | null = null;
  const onStorageChange = (e: StorageEvent) => {
    if (!e.key || e.key === LOCAL_SUBMISSIONS_KEY) {
      emitLocal();
    }
  };
  const onLocalCustomUpdate = () => emitLocal();

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorageChange);
    window.addEventListener('lw-contest-local-update', onLocalCustomUpdate);
    try {
      if ('BroadcastChannel' in window) {
        bc = new BroadcastChannel(CONTEST_BROADCAST_CHANNEL);
        bc.onmessage = () => emitLocal();
      }
    } catch {
      // ignore
    }
  }

  return () => {
    unsubSnapshot();
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorageChange);
      window.removeEventListener('lw-contest-local-update', onLocalCustomUpdate);
    }
    if (bc) {
      try {
        bc.close();
      } catch {
        // ignore
      }
    }
  };
}


