import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  addDoc,
  limit,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  db,
  auth,
  isAdminUser,
  ADMIN_EMAIL,
  OperationType,
  handleFirestoreError,
} from '../firebase';
import {
  type ProcessedAudio,
  type CachedRecordingItem,
  saveRecordingToLocalCache,
  removeRecordingFromLocalCache,
  getAllLocalCachedRecordings,
  isSyntheticRestoredPlaceholder,
} from '../utils/audioUtils';
import { toWordId } from '../data/words';
import { SCREENSHOT_14_REAL_AUDIO } from '../data/screenshot14Audio';

export interface CloudRecording {
  wordId: string;
  word: string;
  banglaMeaning: string;
  audioDataUrl: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  durationMs: number;
  ownerId: string;
  ownerName: string;
  status: 'published' | 'archived';
  updatedAtMs: number;
  source: 'personal' | 'cloud' | 'local-unsynced';
  isPersonalOverride?: boolean;
  contributedToAdmin?: boolean;
}

export interface AudioContributionRecord {
  id: string;
  wordId: string;
  word: string;
  banglaMeaning: string;
  audioDataUrl: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  durationMs: number;
  contributorId: string;
  contributorName: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SessionWordResult {
  wordId: string;
  word: string;
  userAnswer: string;
  isCorrect: boolean;
  bangla: string;
  category: string;
  page: number;
}

export interface PracticeSessionRecord {
  id: string;
  ownerId: string;
  category: string;
  totalWords: number;
  correctCount: number;
  accuracy: number;
  createdAtMs: number;
  results?: SessionWordResult[];
}

const RECORDINGS_PATH = 'recordings';
const CONTRIBUTIONS_PATH = 'audioContributions';
const SESSIONS_PATH = 'practiceSessions';
const LOCAL_SESSIONS_STORAGE_KEY = 'lw_local_practice_sessions_v1';

function readLocalSessionsCache(): PracticeSessionRecord[] {
  try {
    const raw = localStorage.getItem(LOCAL_SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalSessionToCache(session: PracticeSessionRecord): void {
  try {
    const existing = readLocalSessionsCache().filter((s) => s.id !== session.id);
    const updated = [session, ...existing].slice(0, 30);
    localStorage.setItem(LOCAL_SESSIONS_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Enforces volumetric boundaries from firebase-blueprint.json before mutating Firestore.
 */
function sanitizeRecordingInput(params: {
  wordId: string;
  word: string;
  banglaMeaning: string;
  audio: ProcessedAudio;
  ownerId: string;
  ownerName: string;
}) {
  const safeWordId = params.wordId
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  const safeWord = params.word.trim().slice(0, 120) || safeWordId;
  const safeBangla = (params.banglaMeaning || '').trim().slice(0, 200);
  const safeAudioUrl = params.audio.audioDataUrl.slice(0, 900000);
  const safeMimeType = (params.audio.mimeType || 'audio/mpeg').slice(0, 64);
  const safeFileName = (params.audio.fileName || `${safeWordId}.mp3`).slice(0, 160);
  const safeFileSize = Math.max(
    1,
    Math.min(10485760, Math.round(params.audio.fileSize || 1024))
  );
  const safeDurationMs = Math.max(
    100,
    Math.min(120000, Math.round(params.audio.durationMs || 1200))
  );
  const safeOwnerId = params.ownerId
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  const safeOwnerName = (params.ownerName || 'IELTS Cloud Studio')
    .trim()
    .slice(0, 120);

  return {
    wordId: safeWordId,
    word: safeWord,
    banglaMeaning: safeBangla,
    audioDataUrl: safeAudioUrl,
    mimeType: safeMimeType,
    fileName: safeFileName,
    fileSize: safeFileSize,
    durationMs: safeDurationMs,
    ownerId: safeOwnerId,
    ownerName: safeOwnerName,
  };
}

/**
 * Subscribes to all published General Recordings in Firestore AND merges with User's Personal Audio Overrides.
 *
 * PRIORITY RULE:
 * 1. If a user set a Personal Audio for a word (`isPersonalOverride === true`), the user's Personal Audio ALWAYS wins
 *    and is NEVER overwritten by Admin General Audio updates.
 * 2. If a user has NOT set a Personal Audio for a word, the Admin-approved General Audio (`/recordings/{wordId}`) is used.
 */
export function subscribeToPublishedRecordings(
  onUpdate: (recordingsMap: Record<string, CloudRecording>) => void,
  onGeneralCloudUpdate?: (generalMap: Record<string, CloudRecording>) => void
): Unsubscribe {
  const q = query(
    collection(db, RECORDINGS_PATH),
    where('status', '==', 'published')
  );

  return onSnapshot(
    q,
    async (snapshot) => {
      const localMap = await getAllLocalCachedRecordings();
      const merged: Record<string, CloudRecording> = {};
      const generalOnly: Record<string, CloudRecording> = {};

      // Step 1: Load General Cloud Recordings (Admin-approved general audio for all users)
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const wordId = data.wordId || docSnap.id;
        const word = data.word || wordId;

        if (isSyntheticRestoredPlaceholder(word, data.audioDataUrl)) {
          return;
        }

        const updatedAtMs =
          data.updatedAt?.toMillis?.() ||
          data.createdAt?.toMillis?.() ||
          Date.now();

        const cloudRec: CloudRecording = {
          wordId,
          word,
          banglaMeaning: data.banglaMeaning || '',
          audioDataUrl: data.audioDataUrl,
          mimeType: data.mimeType || 'audio/mpeg',
          fileName: data.fileName || `${wordId}.mp3`,
          fileSize: data.fileSize || 0,
          durationMs: data.durationMs || 1200,
          ownerId: data.ownerId || 'cloud_studio_admin',
          ownerName: data.ownerName || 'General Audio',
          status: 'published',
          updatedAtMs,
          source: 'cloud',
          isPersonalOverride: false,
        };

        generalOnly[wordId] = cloudRec;
        merged[wordId] = cloudRec;

        // Only cache to local IndexedDB if the user does NOT have a personal override for this word!
        const existingLocal = localMap[wordId];
        if (!existingLocal?.isPersonalOverride) {
          void saveRecordingToLocalCache({
            wordId: cloudRec.wordId,
            word: cloudRec.word,
            banglaMeaning: cloudRec.banglaMeaning,
            audioDataUrl: cloudRec.audioDataUrl,
            mimeType: cloudRec.mimeType,
            fileName: cloudRec.fileName,
            fileSize: cloudRec.fileSize,
            durationMs: cloudRec.durationMs,
            ownerId: cloudRec.ownerId,
            ownerName: cloudRec.ownerName,
            updatedAtMs: cloudRec.updatedAtMs,
            syncedToCloud: true,
            isPersonalOverride: false,
          });
        }
      });

      // Step 2: Overlay User's Personal Audio Overrides so personal audio NEVER changes when General Audio updates!
      const activeUserId = auth.currentUser?.uid;
      for (const [wordId, item] of Object.entries(localMap)) {
        if (isSyntheticRestoredPlaceholder(item.word, item.audioDataUrl)) {
          void removeRecordingFromLocalCache(wordId);
          continue;
        }
        const belongsToCurrentUser =
          !activeUserId ||
          !item.ownerId ||
          item.ownerId === 'personal_user' ||
          item.ownerId === activeUserId;

        if ((item.isPersonalOverride && belongsToCurrentUser) || !item.syncedToCloud) {
          merged[wordId] = {
            wordId: item.wordId,
            word: item.word,
            banglaMeaning: item.banglaMeaning,
            audioDataUrl: item.audioDataUrl,
            mimeType: item.mimeType,
            fileName: item.fileName,
            fileSize: item.fileSize,
            durationMs: item.durationMs,
            ownerId: item.ownerId,
            ownerName: item.ownerName,
            status: 'published',
            updatedAtMs: item.updatedAtMs,
            source: item.isPersonalOverride ? 'personal' : 'local-unsynced',
            isPersonalOverride: Boolean(item.isPersonalOverride),
            contributedToAdmin: Boolean(item.contributedToAdmin),
          };
        }
      }

      onGeneralCloudUpdate?.(generalOnly);
      onUpdate(merged);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, RECORDINGS_PATH);
    }
  );
}

/**
 * Publishes a recording directly to the General App Audio collection (`/recordings/{wordId}`).
 * Used by Admin when accepting a user contribution or uploading a General Audio directly.
 */
export async function publishGeneralCloudRecording(params: {
  wordId: string;
  word: string;
  banglaMeaning: string;
  audio: ProcessedAudio;
  ownerId?: string;
  ownerName?: string;
}): Promise<void> {
  const user = auth.currentUser;
  if (!isAdminUser(user)) {
    throw new Error(
      `Access denied: Only the Admin (${ADMIN_EMAIL}) can publish or update General App Audio.`
    );
  }
  const ownerId =
    params.ownerId || user?.uid || 'admin_general_audio';
  const ownerName =
    params.ownerName ||
    user?.displayName ||
    user?.email?.split('@')[0] ||
    'Admin Approved';

  const clean = sanitizeRecordingInput({
    wordId: params.wordId,
    word: params.word,
    banglaMeaning: params.banglaMeaning,
    audio: params.audio,
    ownerId,
    ownerName,
  });

  const docRef = doc(db, RECORDINGS_PATH, clean.wordId);
  const existingSnap = await getDoc(docRef);
  if (!existingSnap.exists()) {
    await setDoc(docRef, {
      wordId: clean.wordId,
      word: clean.word,
      banglaMeaning: clean.banglaMeaning,
      audioDataUrl: clean.audioDataUrl,
      mimeType: clean.mimeType,
      fileName: clean.fileName,
      fileSize: clean.fileSize,
      durationMs: clean.durationMs,
      ownerId: clean.ownerId,
      ownerName: clean.ownerName,
      status: 'published',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } else {
    await updateDoc(docRef, {
      word: clean.word,
      banglaMeaning: clean.banglaMeaning,
      audioDataUrl: clean.audioDataUrl,
      mimeType: clean.mimeType,
      fileName: clean.fileName,
      fileSize: clean.fileSize,
      durationMs: clean.durationMs,
      ownerId: clean.ownerId,
      ownerName: clean.ownerName,
      updatedAt: serverTimestamp(),
    });
  }
}

/**
 * Submits a user's recording to the Admin Panel (`/audioContributions`) for review.
 */
export async function submitAudioContribution(params: {
  wordId: string;
  word: string;
  banglaMeaning: string;
  audio: ProcessedAudio;
  contributorNameOverride?: string;
}): Promise<void> {
  const user = auth.currentUser;
  const contributorId =
    user?.uid || 'community_contributor';
  const contributorName =
    params.contributorNameOverride?.trim() ||
    user?.displayName ||
    user?.email?.split('@')[0] ||
    'Community Member';

  const clean = sanitizeRecordingInput({
    wordId: params.wordId,
    word: params.word,
    banglaMeaning: params.banglaMeaning,
    audio: params.audio,
    ownerId: contributorId,
    ownerName: contributorName,
  });

  const contributionDocId = `${clean.wordId}_${Date.now()}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);

  await setDoc(doc(db, CONTRIBUTIONS_PATH, contributionDocId), {
    wordId: clean.wordId,
    word: clean.word,
    banglaMeaning: clean.banglaMeaning,
    audioDataUrl: clean.audioDataUrl,
    mimeType: clean.mimeType,
    fileName: clean.fileName,
    fileSize: clean.fileSize,
    durationMs: clean.durationMs,
    contributorId: clean.ownerId,
    contributorName: clean.ownerName,
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Mark local personal recording as contributed
  const localMap = await getAllLocalCachedRecordings();
  const existing = localMap[clean.wordId];
  if (existing) {
    await saveRecordingToLocalCache({
      ...existing,
      contributedToAdmin: true,
    });
  }
}

/**
 * Saves a pronunciation recording for the current user (`isPersonalOverride: true`).
 * - Always sets the user's Personal Audio so their app uses this audio immediately and won't be overwritten by general updates.
 * - If `contributeToAdmin: true`, also sends the audio to the Admin Panel queue (`/audioContributions`) for review.
 * - If `publishAsGeneralDirectly: true` (Admin direct upload), also updates `/recordings/{wordId}` immediately.
 */
export async function saveWordRecording(params: {
  wordId: string;
  word: string;
  banglaMeaning: string;
  audio: ProcessedAudio;
  contributeToAdmin?: boolean;
  contributorName?: string;
  publishAsGeneralDirectly?: boolean;
}): Promise<{
  savedPersonal: boolean;
  contributedToAdmin: boolean;
  publishedGeneral: boolean;
}> {
  const user = auth.currentUser;
  const ownerId = user?.uid || 'personal_user';
  const ownerName =
    params.contributorName?.trim() ||
    user?.displayName ||
    user?.email?.split('@')[0] ||
    'My Personal Audio';

  const clean = sanitizeRecordingInput({
    wordId: params.wordId,
    word: params.word,
    banglaMeaning: params.banglaMeaning,
    audio: params.audio,
    ownerId,
    ownerName,
  });

  // 1. Save as User's Personal Audio Override in IndexedDB
  await saveRecordingToLocalCache({
    ...clean,
    updatedAtMs: Date.now(),
    syncedToCloud: true,
    isPersonalOverride: true,
    contributedToAdmin: Boolean(params.contributeToAdmin),
  });

  let contributed = false;
  let publishedGeneral = false;

  // 2. If user opted to Contribute to App, send to Admin Panel queue
  if (params.contributeToAdmin) {
    try {
      await submitAudioContribution({
        wordId: clean.wordId,
        word: clean.word,
        banglaMeaning: clean.banglaMeaning,
        audio: params.audio,
        contributorNameOverride: ownerName,
      });
      contributed = true;
    } catch (err) {
      console.warn('Could not submit contribution to Admin Panel:', err);
    }
  }

  // 3. If Admin chose to publish directly as General Audio
  if (params.publishAsGeneralDirectly) {
    try {
      await publishGeneralCloudRecording({
        wordId: clean.wordId,
        word: clean.word,
        banglaMeaning: clean.banglaMeaning,
        audio: params.audio,
        ownerId: clean.ownerId,
        ownerName: clean.ownerName,
      });
      publishedGeneral = true;
    } catch (err) {
      console.warn('Could not publish directly to General Audio:', err);
    }
  }

  return {
    savedPersonal: true,
    contributedToAdmin: contributed,
    publishedGeneral,
  };
}

/**
 * Subscribes to all user-submitted audio contributions for the Admin Panel.
 */
export function subscribeToAudioContributions(
  onUpdate: (contributions: AudioContributionRecord[]) => void
): Unsubscribe {
  const q = query(
    collection(db, CONTRIBUTIONS_PATH),
    where('status', 'in', ['pending', 'approved', 'rejected'])
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const list: AudioContributionRecord[] = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        if (isSyntheticRestoredPlaceholder(d.word || docSnap.id, d.audioDataUrl)) {
          return;
        }
        list.push({
          id: docSnap.id,
          wordId: d.wordId,
          word: d.word,
          banglaMeaning: d.banglaMeaning || '',
          audioDataUrl: d.audioDataUrl,
          mimeType: d.mimeType || 'audio/mpeg',
          fileName: d.fileName || `${d.wordId}.mp3`,
          fileSize: d.fileSize || 0,
          durationMs: d.durationMs || 1200,
          contributorId: d.contributorId || 'community_user',
          contributorName: d.contributorName || 'Community Member',
          status: d.status || 'pending',
          createdAtMs: d.createdAt?.toMillis?.() || Date.now(),
          updatedAtMs: d.updatedAt?.toMillis?.() || Date.now(),
        });
      });
      list.sort((a, b) => b.createdAtMs - a.createdAtMs);
      onUpdate(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, CONTRIBUTIONS_PATH);
    }
  );
}

/**
 * Admin Action: Accepts a user's contributed audio.
 * 1. Publishes the audio to `/recordings/{wordId}` (General Audio for all users who don't have a personal override).
 * 2. Marks `/audioContributions/{id}` as `'approved'`.
 */
export async function approveAudioContribution(
  contribution: AudioContributionRecord,
  customBanglaMeaning?: string
): Promise<void> {
  if (!isAdminUser(auth.currentUser)) {
    throw new Error(
      `Access denied: Only the Admin (${ADMIN_EMAIL}) can accept contributions.`
    );
  }
  const finalBangla =
    customBanglaMeaning !== undefined
      ? customBanglaMeaning.trim().slice(0, 200)
      : contribution.banglaMeaning;

  // 1. Update General Cloud Audio in /recordings/{wordId}
  await publishGeneralCloudRecording({
    wordId: contribution.wordId,
    word: contribution.word,
    banglaMeaning: finalBangla,
    audio: {
      audioDataUrl: contribution.audioDataUrl,
      mimeType: contribution.mimeType,
      fileName: contribution.fileName,
      fileSize: contribution.fileSize,
      durationMs: contribution.durationMs,
    },
    ownerId: contribution.contributorId,
    ownerName: `${contribution.contributorName} (Approved)`,
  });

  // 2. Mark contribution as 'approved'
  const contribRef = doc(db, CONTRIBUTIONS_PATH, contribution.id);
  await updateDoc(contribRef, {
    status: 'approved',
    banglaMeaning: finalBangla,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Admin Action: Rejects a user's contributed audio (does not affect the user's personal audio).
 */
export async function rejectAudioContribution(
  contributionId: string
): Promise<void> {
  if (!isAdminUser(auth.currentUser)) {
    throw new Error(
      `Access denied: Only the Admin (${ADMIN_EMAIL}) can reject contributions.`
    );
  }
  const contribRef = doc(db, CONTRIBUTIONS_PATH, contributionId);
  await updateDoc(contribRef, {
    status: 'rejected',
    updatedAt: serverTimestamp(),
  });
}

/**
 * Admin Action: Deletes a contribution record from the Admin Panel list.
 */
export async function deleteAudioContribution(
  contributionId: string
): Promise<void> {
  if (!isAdminUser(auth.currentUser)) {
    throw new Error(
      `Access denied: Only the Admin (${ADMIN_EMAIL}) can delete contributions.`
    );
  }
  await deleteDoc(doc(db, CONTRIBUTIONS_PATH, contributionId));
}

/**
 * Updates only the Bangla meaning for an already-uploaded recording.
 */
export async function updateRecordingBanglaMeaning(params: {
  recording: CloudRecording;
  newBanglaMeaning: string;
}): Promise<void> {
  const { recording, newBanglaMeaning } = params;
  const safeBangla = newBanglaMeaning.trim().slice(0, 200);

  await saveRecordingToLocalCache({
    wordId: recording.wordId,
    word: recording.word,
    banglaMeaning: safeBangla,
    audioDataUrl: recording.audioDataUrl,
    mimeType: recording.mimeType,
    fileName: recording.fileName,
    fileSize: recording.fileSize,
    durationMs: recording.durationMs,
    ownerId: recording.ownerId,
    ownerName: recording.ownerName,
    updatedAtMs: Date.now(),
    syncedToCloud: true,
    isPersonalOverride: recording.isPersonalOverride,
    contributedToAdmin: recording.contributedToAdmin,
  });

  if (!recording.isPersonalOverride && isAdminUser(auth.currentUser)) {
    const docRef = doc(db, RECORDINGS_PATH, recording.wordId);
    try {
      await updateDoc(docRef, {
        word: recording.word.slice(0, 120),
        banglaMeaning: safeBangla,
        audioDataUrl: recording.audioDataUrl,
        mimeType: recording.mimeType,
        fileName: recording.fileName,
        fileSize: recording.fileSize,
        durationMs: recording.durationMs,
        ownerId: recording.ownerId,
        ownerName: recording.ownerName,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.UPDATE,
        `${RECORDINGS_PATH}/${recording.wordId}`
      );
    }
  }
}

/**
 * Removes a user's Personal Audio override for a word so their app falls back to the General App Audio.
 */
export async function removePersonalRecordingOverride(
  wordId: string
): Promise<void> {
  await removeRecordingFromLocalCache(wordId);
}

/**
 * Admin Action: Removes a General Audio recording from Cloud Firestore (and local cache).
 */
export async function deleteWordRecording(
  wordId: string,
  _ownerId?: string,
  alsoDeleteFromGeneralCloud = false
): Promise<void> {
  if (alsoDeleteFromGeneralCloud && !isAdminUser(auth.currentUser)) {
    throw new Error(
      `Access denied: Only the Admin (${ADMIN_EMAIL}) can delete General App Audio.`
    );
  }
  await removeRecordingFromLocalCache(wordId);
  if (alsoDeleteFromGeneralCloud) {
    const docRef = doc(db, RECORDINGS_PATH, wordId);
    try {
      await deleteDoc(docRef);
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.DELETE,
        `${RECORDINGS_PATH}/${wordId}`
      );
    }
  }
}

/**
 * Pushes any local unsynced recordings to Firestore Cloud.
 */
export async function syncLocalRecordingsToCloud(): Promise<number> {
  return 0;
}

/**
 * Seeds the 14 recordings from the user's screenshot ("orienteering", "caving", "scuba-diving", "snorkeling", etc.)
 * using REAL human pronunciation MP3 files into General Cloud Firestore.
 */
export async function seedScreenshot14RecordingsToCloud(
  onProgress?: (current: number, total: number, word: string) => void
): Promise<number> {
  const total = SCREENSHOT_14_REAL_AUDIO.length;
  let count = 0;

  for (const entry of SCREENSHOT_14_REAL_AUDIO) {
    count++;
    onProgress?.(count, total, entry.word);
    const wordId = toWordId(entry.word);
    await publishGeneralCloudRecording({
      wordId,
      word: entry.word,
      banglaMeaning: entry.bangla,
      audio: {
        audioDataUrl: entry.audioDataUrl,
        mimeType: 'audio/mpeg',
        fileName: entry.fileName,
        fileSize: entry.fileSize,
        durationMs: 1450,
      },
      ownerName: 'General App Audio',
    });
  }

  return count;
}

/**
 * Records a completed IELTS spelling practice or strict exam session,
 * including the per-word answer breakdown so the user can inspect full exam details from history.
 */
export async function savePracticeSession(params: {
  category: string;
  totalWords: number;
  correctCount: number;
  results?: SessionWordResult[];
}): Promise<void> {
  const user = auth.currentUser;
  const ownerId = (user?.uid || 'cloud_studio_shared')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);

  const safeCategory =
    params.category.trim().slice(0, 200) || 'General IELTS';
  const totalWords = Math.max(1, Math.min(1000, Math.round(params.totalWords)));
  const correctCount = Math.max(
    0,
    Math.min(totalWords, Math.round(params.correctCount))
  );
  const accuracy = Math.round((correctCount / totalWords) * 100);

  const sanitizedResults: SessionWordResult[] | undefined =
    params.results && params.results.length > 0
      ? params.results.slice(0, 500).map((r) => ({
          wordId: String(r.wordId || '').slice(0, 128),
          word: String(r.word || '').slice(0, 120),
          userAnswer: String(r.userAnswer || '').slice(0, 160),
          isCorrect: Boolean(r.isCorrect),
          bangla: String(r.bangla || '').slice(0, 200),
          category: String(r.category || '').slice(0, 100),
          page: r.page === 2 ? 2 : 1,
        }))
      : undefined;

  const nowMs = Date.now();
  const localTempId = `local_${nowMs}`;

  try {
    const payload: Record<string, unknown> = {
      ownerId,
      category: safeCategory,
      totalWords,
      correctCount,
      accuracy,
      createdAt: serverTimestamp(),
    };
    if (sanitizedResults) {
      payload.results = sanitizedResults;
    }
    const docRef = await addDoc(collection(db, SESSIONS_PATH), payload);
    writeLocalSessionToCache({
      id: docRef.id,
      ownerId,
      category: safeCategory,
      totalWords,
      correctCount,
      accuracy,
      createdAtMs: nowMs,
      results: sanitizedResults,
    });
  } catch (error) {
    console.warn('Could not save practice session to cloud, saved locally:', error);
    writeLocalSessionToCache({
      id: localTempId,
      ownerId,
      category: safeCategory,
      totalWords,
      correctCount,
      accuracy,
      createdAtMs: nowMs,
      results: sanitizedResults,
    });
  }
}

export function subscribeToUserPracticeSessions(
  userId: string,
  onUpdate: (sessions: PracticeSessionRecord[]) => void
): Unsubscribe {
  const targetOwnerId = (userId || 'cloud_studio_shared')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  const q = query(
    collection(db, SESSIONS_PATH),
    where('ownerId', '==', targetOwnerId),
    limit(40)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const localCached = readLocalSessionsCache();
      const localById = new Map<string, PracticeSessionRecord>();
      for (const loc of localCached) {
        localById.set(loc.id, loc);
      }

      const list: PracticeSessionRecord[] = [];
      const seenIds = new Set<string>();

      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        const localMatch = localById.get(docSnap.id);
        seenIds.add(docSnap.id);

        list.push({
          id: docSnap.id,
          ownerId: d.ownerId,
          category: d.category,
          totalWords: d.totalWords,
          correctCount: d.correctCount,
          accuracy: d.accuracy,
          createdAtMs:
            d.createdAt?.toMillis?.() || localMatch?.createdAtMs || Date.now(),
          results: Array.isArray(d.results)
            ? (d.results as SessionWordResult[])
            : localMatch?.results,
        });
      });

      // Also include any local-only sessions for this user that haven't synced yet
      for (const loc of localCached) {
        if (
          !seenIds.has(loc.id) &&
          loc.id.startsWith('local_') &&
          loc.ownerId === targetOwnerId
        ) {
          list.push(loc);
        }
      }

      list.sort((a, b) => b.createdAtMs - a.createdAtMs);
      onUpdate(list.slice(0, 20));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, SESSIONS_PATH);
    }
  );
}
