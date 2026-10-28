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

  const pool = [...getContestCandidatePool(contest.pageFilter, contest.categories)];
  if (pool.length === 0) return [];

  // Sort by deterministic ID first so catalog order is 100% identical across all devices
  pool.sort((a, b) => a.id.localeCompare(b.id));

  const seedMaterial = `${contest.id}::${contest.randomSeed}::${contest.startTimeMs}::${contest.wordCount}`;
  const rand = createSeededPrng(seedMaterial);

  // Deterministic Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const targetCount = Math.max(1, Math.min(pool.length, contest.wordCount));
  return pool.slice(0, targetCount);
}

export function getContestPhase(
  contest: ContestRecord,
  nowMs: number = Date.now()
): 'upcoming' | 'live' | 'ended' | 'cancelled' {
  if (contest.status === 'cancelled') return 'cancelled';
  const endTimeMs = contest.startTimeMs + contest.durationMinutes * 60 * 1000;
  if (nowMs < contest.startTimeMs) return 'upcoming';
  if (nowMs <= endTimeMs) return 'live';
  return 'ended';
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

function writeLocalContests(list: ContestRecord[]): void {
  try {
    localStorage.setItem(LOCAL_CONTESTS_KEY, JSON.stringify(list.slice(0, 80)));
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

  return record;
}

export async function deleteOrCancelContest(contestId: string): Promise<void> {
  const existingLocal = readLocalContests().filter((c) => c.id !== contestId);
  writeLocalContests(existingLocal);
  try {
    await deleteDoc(doc(db, CONTESTS_PATH, contestId));
  } catch {
    await updateDoc(doc(db, CONTESTS_PATH, contestId), {
      status: 'cancelled',
      updatedAt: serverTimestamp(),
    });
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
    // Fallback if document didn't exist in cloud yet
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

  // If this device has any local active contests that haven't synced to Firestore yet, push them to Cloud now
  const localContests = readLocalContests();
  for (const loc of localContests) {
    if (
      loc.status === 'active' &&
      !cloudIds.has(loc.id) &&
      !cancelledIds.has(loc.id)
    ) {
      list.push(loc);
      void setDoc(doc(db, CONTESTS_PATH, loc.id), {
        id: loc.id,
        title: loc.title.slice(0, 140),
        creatorId: sanitizeId(loc.creatorId),
        creatorName: (loc.creatorName || 'Setter').slice(0, 120),
        pageFilter:
          loc.pageFilter === 'page1' || loc.pageFilter === 'page2'
            ? loc.pageFilter
            : 'all',
        categories: Array.isArray(loc.categories)
          ? loc.categories.slice(0, 50)
          : [],
        wordCount: Math.max(1, Math.min(200, Number(loc.wordCount) || 15)),
        baseSeconds: Math.max(5, Math.min(60, Number(loc.baseSeconds) || 12)),
        showBangla: Boolean(loc.showBangla),
        startTimeMs: Math.max(
          1700000000000,
          Number(loc.startTimeMs) || Date.now()
        ),
        durationMinutes: Math.max(
          5,
          Math.min(1440, Number(loc.durationMinutes) || 30)
        ),
        randomSeed: String(loc.randomSeed || generateRandomSeed()),
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }).catch(() => {});
    }
  }

  const sortedContests = sortContestsLiveFirst(list);
  writeLocalContests(sortedContests);

  const subList: ContestSubmissionRecord[] = [];
  subSnap.forEach((docSnap) => {
    const d = docSnap.data();
    subList.push({
      id: d.id || docSnap.id,
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
  writeLocalSubmissions(subList);

  return { contests: sortedContests, submissions: subList };
}

/**
 * Subscribes to all active contests in real time (with active polling fallback for mobile & APK WebViews).
 */
export function subscribeToContests(
  onUpdate: (contests: ContestRecord[]) => void
): Unsubscribe {
  onUpdate(sortContestsLiveFirst(readLocalContests()));

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

    // Also preserve & auto-upload any locally created active contests not yet in cloud
    const localContests = readLocalContests();
    for (const loc of localContests) {
      if (
        loc.status === 'active' &&
        !cloudIds.has(loc.id) &&
        !cancelledIds.has(loc.id)
      ) {
        list.push(loc);
        void setDoc(doc(db, CONTESTS_PATH, loc.id), {
          id: loc.id,
          title: loc.title.slice(0, 140),
          creatorId: sanitizeId(loc.creatorId),
          creatorName: (loc.creatorName || 'Setter').slice(0, 120),
          pageFilter:
            loc.pageFilter === 'page1' || loc.pageFilter === 'page2'
              ? loc.pageFilter
              : 'all',
          categories: Array.isArray(loc.categories)
            ? loc.categories.slice(0, 50)
            : [],
          wordCount: Math.max(1, Math.min(200, Number(loc.wordCount) || 15)),
          baseSeconds: Math.max(5, Math.min(60, Number(loc.baseSeconds) || 12)),
          showBangla: Boolean(loc.showBangla),
          startTimeMs: Math.max(
            1700000000000,
            Number(loc.startTimeMs) || Date.now()
          ),
          durationMinutes: Math.max(
            5,
            Math.min(1440, Number(loc.durationMinutes) || 30)
          ),
          randomSeed: String(loc.randomSeed || generateRandomSeed()),
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
    }

    const sorted = sortContestsLiveFirst(list);
    writeLocalContests(sorted);
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
      console.warn('Contest subscription fallback to local cache:', err);
      onUpdate(sortContestsLiveFirst(readLocalContests()));
    }
  );

  // Active background poll every 6s so Android APK WebView & mobile carrier networks stay 100% synced
  const pollNow = () => {
    void getDocs(q)
      .then((snap) => {
        const docs: Array<{ id: string; data: () => Record<string, any> }> = [];
        snap.forEach((docSnap) => docs.push(docSnap));
        processDocs(docs);
      })
      .catch(() => {});
  };
  pollNow();
  const pollIntervalId =
    typeof window !== 'undefined' ? window.setInterval(pollNow, 6000) : null;

  return () => {
    unsubSnapshot();
    if (pollIntervalId !== null && typeof window !== 'undefined') {
      window.clearInterval(pollIntervalId);
    }
  };
}

/**
 * Subscribes to contest submissions for live leaderboard updates.
 */
export function subscribeToContestSubmissions(
  onUpdate: (submissions: ContestSubmissionRecord[]) => void
): Unsubscribe {
  onUpdate(readLocalSubmissions());

  const q = query(
    collection(db, SUBMISSIONS_PATH),
    where('status', 'in', ['registered', 'in_progress', 'completed']),
    limit(200)
  );

  const processSubDocs = (
    docs: Array<{ id: string; data: () => Record<string, any> }>
  ) => {
    const list: ContestSubmissionRecord[] = [];
    docs.forEach((docSnap) => {
      const d = docSnap.data();
      list.push({
        id: d.id || docSnap.id,
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

    writeLocalSubmissions(list);
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
      console.warn('Contest submissions fallback to local cache:', err);
      onUpdate(readLocalSubmissions());
    }
  );

  const pollNow = () => {
    void getDocs(q)
      .then((snap) => {
        const docs: Array<{ id: string; data: () => Record<string, any> }> = [];
        snap.forEach((docSnap) => docs.push(docSnap));
        processSubDocs(docs);
      })
      .catch(() => {});
  };
  pollNow();
  const pollIntervalId =
    typeof window !== 'undefined' ? window.setInterval(pollNow, 6000) : null;

  return () => {
    unsubSnapshot();
    if (pollIntervalId !== null && typeof window !== 'undefined') {
      window.clearInterval(pollIntervalId);
    }
  };
}

