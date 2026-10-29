import {
  collection,
  doc,
  getDoc,
  getDocs,
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
  emailToDeterministicUid,
  OperationType,
  handleFirestoreError,
} from '../firebase';
import {
  type ProcessedAudio,
  saveRecordingToLocalCache,
  removeRecordingFromLocalCache,
  getAllLocalCachedRecordings,
  isSyntheticRestoredPlaceholder,
} from '../utils/audioUtils';
import {
  toWordId,
  WORDS_CATALOG,
  type WordItem,
  type GlobalWordOverride,
  applyGlobalWordOverridesToCatalog,
  getOriginalCatalogWord,
} from '../data/words';
import { SCREENSHOT_14_REAL_AUDIO } from '../data/screenshot14Audio';

export const PERSONAL_STRUGGLING_CATEGORY = 'My Struggling Words';

export interface PersonalWordRecord {
  id: string;
  wordId: string;
  word: string;
  bangla: string;
  example: string;
  ownerId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

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

const LOCAL_CONTRIBUTIONS_CACHE_KEY = 'lw_audio_contributions_cache_v1';
const LOCAL_DELETED_CONTRIB_IDS_KEY = 'lw_deleted_contrib_ids_v1';
const CONTRIBUTIONS_BROADCAST_CHANNEL = 'lw_audio_contributions_sync_v1';
const LOCAL_DELETED_RECORDING_IDS_KEY = 'lw_deleted_recording_ids_v1';
const RECORDINGS_BROADCAST_CHANNEL = 'lw_recordings_sync_v1';

function readDeletedRecordingIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(LOCAL_DELETED_RECORDING_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function markRecordingDeletedLocally(wordId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const set = readDeletedRecordingIds();
    set.add(wordId);
    window.localStorage.setItem(
      LOCAL_DELETED_RECORDING_IDS_KEY,
      JSON.stringify(Array.from(set).slice(-300))
    );
  } catch {
    // ignore
  }
}

function unmarkRecordingDeletedLocally(wordId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const set = readDeletedRecordingIds();
    if (set.has(wordId)) {
      set.delete(wordId);
      window.localStorage.setItem(
        LOCAL_DELETED_RECORDING_IDS_KEY,
        JSON.stringify(Array.from(set))
      );
    }
  } catch {
    // ignore
  }
}

function notifyRecordingsListeners(): void {
  if (typeof window === 'undefined') return;
  try {
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel(RECORDINGS_BROADCAST_CHANNEL);
      bc.postMessage({ type: 'RECORDINGS_UPDATED', ts: Date.now() });
      bc.close();
    }
    window.dispatchEvent(new CustomEvent('lw-recordings-local-update'));
  } catch {
    // ignore
  }
}

function readDeletedContributionIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(LOCAL_DELETED_CONTRIB_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function markContributionDeletedLocally(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    const set = readDeletedContributionIds();
    set.add(id);
    window.localStorage.setItem(
      LOCAL_DELETED_CONTRIB_IDS_KEY,
      JSON.stringify(Array.from(set).slice(-300))
    );
  } catch {
    // ignore
  }
}

function unmarkContributionDeletedLocally(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    const set = readDeletedContributionIds();
    if (set.has(id)) {
      set.delete(id);
      window.localStorage.setItem(
        LOCAL_DELETED_CONTRIB_IDS_KEY,
        JSON.stringify(Array.from(set))
      );
    }
  } catch {
    // ignore
  }
}

function readLocalContributionsCache(): AudioContributionRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_CONTRIBUTIONS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const deletedSet = readDeletedContributionIds();
    return parsed.filter((c: AudioContributionRecord) => c && c.id && !deletedSet.has(c.id));
  } catch {
    return [];
  }
}

function notifyContributionsListeners(): void {
  if (typeof window === 'undefined') return;
  try {
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel(CONTRIBUTIONS_BROADCAST_CHANNEL);
      bc.postMessage({ type: 'CONTRIBUTIONS_UPDATED', ts: Date.now() });
      bc.close();
    }
    window.dispatchEvent(new CustomEvent('lw-contributions-local-update'));
  } catch {
    // ignore
  }
}

function writeLocalContributionsCache(
  list: AudioContributionRecord[],
  notify = true
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      LOCAL_CONTRIBUTIONS_CACHE_KEY,
      JSON.stringify(list.slice(0, 60))
    );
  } catch {
    // If localStorage is near capacity due to base64 audio, store top 20
    try {
      window.localStorage.setItem(
        LOCAL_CONTRIBUTIONS_CACHE_KEY,
        JSON.stringify(list.slice(0, 20))
      );
    } catch {
      // ignore
    }
  }
  if (notify) {
    notifyContributionsListeners();
  }
}

async function fetchSharedServerAudioState(includeAudio = true): Promise<{
  contributions: AudioContributionRecord[];
  deletedContributionIds: string[];
  recordings: Record<string, CloudRecording>;
  deletedRecordingIds: string[];
  wordOverrides: Record<string, GlobalWordOverride>;
  deletedWordOverrideIds: string[];
} | null> {
  if (typeof window === 'undefined') return null;
  try {
    const res = await fetch(
      `/api/sync/state?includeAudio=${includeAudio ? 'true' : 'false'}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      contributions: Array.isArray(data?.contributions) ? data.contributions : [],
      deletedContributionIds: Array.isArray(data?.deletedContributionIds)
        ? data.deletedContributionIds
        : [],
      recordings:
        data?.recordings && typeof data.recordings === 'object'
          ? data.recordings
          : {},
      deletedRecordingIds: Array.isArray(data?.deletedRecordingIds)
        ? data.deletedRecordingIds
        : [],
      wordOverrides:
        data?.wordOverrides && typeof data.wordOverrides === 'object'
          ? data.wordOverrides
          : {},
      deletedWordOverrideIds: Array.isArray(data?.deletedWordOverrideIds)
        ? data.deletedWordOverrideIds
        : [],
    };
  } catch {
    return null;
  }
}

async function pushContributionToSharedServer(
  contribution: AudioContributionRecord & { forcePending?: boolean }
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const res = await fetch('/api/sync/audio-contributions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contribution }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function pushGeneralRecordingToSharedServer(
  recording: CloudRecording
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const res = await fetch('/api/sync/recordings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recording }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Subscribes to all published General Recordings in Shared Server + Firestore AND merges with User's Personal Audio Overrides.
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

  let latestFirestoreGeneral: Record<string, CloudRecording> = {};
  let latestServerGeneral: Record<string, CloudRecording> = {};
  let lastEmittedGeneralSig = '';
  let lastEmittedMergedSig = '';

  const buildAndEmitMerged = async () => {
    try {
      const deletedRecSet = readDeletedRecordingIds();
      const localMap = await getAllLocalCachedRecordings();
      const merged: Record<string, CloudRecording> = {};
      const generalOnly: Record<string, CloudRecording> = {};
      const activeUserId = auth.currentUser?.uid;

      // 1. Merge Local General cache + Shared Server General + Firestore General
      for (const [wordId, item] of Object.entries(localMap)) {
        if (isSyntheticRestoredPlaceholder(item.word, item.audioDataUrl)) {
          continue;
        }
        if (!item.isPersonalOverride && !deletedRecSet.has(wordId)) {
          const rec: CloudRecording = {
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
            source: item.syncedToCloud ? 'cloud' : 'local-unsynced',
            isPersonalOverride: false,
            contributedToAdmin: Boolean(item.contributedToAdmin),
          };
          generalOnly[wordId] = rec;
          merged[wordId] = rec;
        }
      }

      for (const [wordId, sRec] of Object.entries(latestServerGeneral)) {
        if (deletedRecSet.has(wordId)) continue;
        if (
          sRec &&
          sRec.audioDataUrl &&
          !isSyntheticRestoredPlaceholder(sRec.word || wordId, sRec.audioDataUrl)
        ) {
          const rec: CloudRecording = {
            ...sRec,
            status: 'published',
            source: 'cloud',
            isPersonalOverride: false,
          };
          generalOnly[wordId] = rec;
          merged[wordId] = rec;

          if (!localMap[wordId]?.isPersonalOverride) {
            void saveRecordingToLocalCache({
              wordId: rec.wordId,
              word: rec.word,
              banglaMeaning: rec.banglaMeaning,
              audioDataUrl: rec.audioDataUrl,
              mimeType: rec.mimeType,
              fileName: rec.fileName,
              fileSize: rec.fileSize,
              durationMs: rec.durationMs,
              ownerId: rec.ownerId,
              ownerName: rec.ownerName,
              updatedAtMs: rec.updatedAtMs,
              syncedToCloud: true,
              isPersonalOverride: false,
            });
          }
        }
      }

      for (const [wordId, fRec] of Object.entries(latestFirestoreGeneral)) {
        if (deletedRecSet.has(wordId)) continue;
        const existingServer = generalOnly[wordId];
        if (!existingServer || (fRec.updatedAtMs || 0) >= (existingServer.updatedAtMs || 0)) {
          generalOnly[wordId] = fRec;
          merged[wordId] = fRec;
        }
      }

      // 2. Overlay User's Personal Audio Overrides so personal audio NEVER changes when General Audio updates!
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

        if ((item.isPersonalOverride && belongsToCurrentUser) || (!item.syncedToCloud && !deletedRecSet.has(wordId))) {
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

      const generalSig = JSON.stringify(
        Object.values(generalOnly)
          .sort((a, b) => a.wordId.localeCompare(b.wordId))
          .map((r) => `${r.wordId}:${r.word}:${r.updatedAtMs}:${r.banglaMeaning}`)
      );
      if (generalSig !== lastEmittedGeneralSig) {
        lastEmittedGeneralSig = generalSig;
        onGeneralCloudUpdate?.(generalOnly);
      }

      const mergedSig = JSON.stringify(
        Object.values(merged)
          .sort((a, b) => a.wordId.localeCompare(b.wordId))
          .map(
            (r) =>
              `${r.wordId}:${r.word}:${r.updatedAtMs}:${r.banglaMeaning}:${r.source}:${r.contributedToAdmin}`
          )
      );
      if (mergedSig !== lastEmittedMergedSig) {
        lastEmittedMergedSig = mergedSig;
        onUpdate(merged);
      }
    } catch {
      // Ignore local IndexedDB read error
    }
  };

  const pullServerRecordings = async () => {
    const state = await fetchSharedServerAudioState(true);
    if (state) {
      const serverDelSet = new Set(state.deletedRecordingIds || []);
      for (const delWordId of serverDelSet) {
        markRecordingDeletedLocally(delWordId);
        delete latestFirestoreGeneral[delWordId];
      }
      for (const wordId of Object.keys(state.recordings || {})) {
        if (!serverDelSet.has(wordId)) {
          unmarkRecordingDeletedLocally(wordId);
        }
      }
      latestServerGeneral = state.recordings || {};
      await buildAndEmitMerged();
    }
  };

  void buildAndEmitMerged();
  void pullServerRecordings();

  const pollId =
    typeof window !== 'undefined'
      ? window.setInterval(() => {
          void pullServerRecordings();
        }, 5000)
      : null;

  let bc: BroadcastChannel | null = null;
  const onLocalRecordingsEvent = () => {
    void buildAndEmitMerged();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('lw-recordings-local-update', onLocalRecordingsEvent);
    try {
      if ('BroadcastChannel' in window) {
        bc = new BroadcastChannel(RECORDINGS_BROADCAST_CHANNEL);
        bc.onmessage = () => void buildAndEmitMerged();
      }
    } catch {
      // ignore
    }
  }

  const unsubSnapshot = onSnapshot(
    q,
    async (snapshot) => {
      const deletedRecSet = readDeletedRecordingIds();
      const localMap = await getAllLocalCachedRecordings();
      const nextFirestoreGeneral: Record<string, CloudRecording> = {};

      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const wordId = data.wordId || docSnap.id;
        if (deletedRecSet.has(wordId)) return;
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

        nextFirestoreGeneral[wordId] = cloudRec;

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

      latestFirestoreGeneral = nextFirestoreGeneral;
      await buildAndEmitMerged();
    },
    () => {
      void buildAndEmitMerged();
    }
  );

  return () => {
    unsubSnapshot();
    if (pollId !== null && typeof window !== 'undefined') {
      window.clearInterval(pollId);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('lw-recordings-local-update', onLocalRecordingsEvent);
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
 * Publishes a recording directly to the General App Audio collection (`/recordings/{wordId}` & Shared Server).
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

  const nowMs = Date.now();
  const generalRec: CloudRecording = {
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
    updatedAtMs: nowMs,
    source: 'cloud',
    isPersonalOverride: false,
  };

  unmarkRecordingDeletedLocally(clean.wordId);

  // 1. Push to shared backend server so all users receive the General Audio immediately
  await pushGeneralRecordingToSharedServer(generalRec);

  // 2. Also cache locally if Admin doesn't have a personal override
  const localMap = await getAllLocalCachedRecordings();
  if (!localMap[clean.wordId]?.isPersonalOverride) {
    await saveRecordingToLocalCache({
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
      updatedAtMs: nowMs,
      syncedToCloud: true,
      isPersonalOverride: false,
    });
  }

  notifyRecordingsListeners();

  // 3. Also write to Cloud Firestore
  try {
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
    notifyRecordingsListeners();
  } catch (err) {
    console.warn('General recording published via shared server (Firestore fallback):', err);
  }
}

/**
 * Submits a user's recording to the Admin Panel (`/audioContributions` + Shared Server) for review.
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

  // Use a deterministic document ID per wordId for pending contributions so concurrent calls never duplicate
  const contributionDocId = `pending_${clean.wordId}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);

  unmarkContributionDeletedLocally(contributionDocId);

  const nowMs = Date.now();
  const contributionRecord: AudioContributionRecord = {
    id: contributionDocId,
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
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };

  // 1. Save immediately in local contributions cache so UI & same-device Admin Panel update instantaneously
  const existingLocalList = readLocalContributionsCache().filter(
    (c) => c.id !== contributionDocId && !(c.wordId === clean.wordId && c.status === 'pending')
  );
  writeLocalContributionsCache([contributionRecord, ...existingLocalList], true);

  // 2. Mark local personal recording in IndexedDB as `contributedToAdmin: true`
  const localMap = await getAllLocalCachedRecordings();
  const existingPersonal = localMap[clean.wordId];
  if (existingPersonal) {
    await saveRecordingToLocalCache({
      ...existingPersonal,
      contributedToAdmin: true,
    });
  }

  // 3. Push immediately to Shared Backend Server so Admin on any browser/device receives it in real time!
  await pushContributionToSharedServer({
    ...contributionRecord,
    forcePending: true,
  });

  // 4. Also write to Cloud Firestore if quota is available
  try {
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
  } catch (err) {
    console.warn(
      'Audio contribution delivered via shared server & local queue (Firestore quota/offline fallback):',
      err
    );
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
  contributionError?: string;
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
  let contributionError: string | undefined;

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
      console.error('Could not submit contribution to Admin Panel:', err);
      contributionError =
        err instanceof Error
          ? err.message
          : 'Could not send recording to Admin Panel.';
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
    contributionError,
  };
}

let hasAutoSyncedPendingContributions = false;

function deduplicateContributions(
  rawList: AudioContributionRecord[],
  deletedIds: Set<string>
): AudioContributionRecord[] {
  const filtered = rawList.filter(
    (item) =>
      item &&
      item.id &&
      item.wordId &&
      item.audioDataUrl &&
      !deletedIds.has(item.id) &&
      !isSyntheticRestoredPlaceholder(item.word || item.wordId, item.audioDataUrl)
  );
  filtered.sort(
    (a, b) => (b.updatedAtMs || b.createdAtMs || 0) - (a.updatedAtMs || a.createdAtMs || 0)
  );

  const seenPendingWords = new Set<string>();
  const seenReviewedWords = new Set<string>();
  const dedupedList: AudioContributionRecord[] = [];

  for (const item of filtered) {
    if (item.status === 'pending') {
      if (seenPendingWords.has(item.wordId)) {
        continue;
      }
      seenPendingWords.add(item.wordId);
      dedupedList.push(item);
    } else {
      const revKey = `${item.wordId}_${item.status}`;
      if (seenReviewedWords.has(revKey)) {
        continue;
      }
      seenReviewedWords.add(revKey);
      dedupedList.push(item);
    }
  }
  return dedupedList;
}

/**
 * Subscribes to all user-submitted audio contributions for the Admin Panel
 * across Shared Server + Cloud Firestore + Local Cache.
 */
export function subscribeToAudioContributions(
  onUpdate: (contributions: AudioContributionRecord[]) => void
): Unsubscribe {
  let firestoreList: AudioContributionRecord[] = [];
  let serverList: AudioContributionRecord[] = [];
  let lastEmittedContribSig = '';

  const emitMerged = () => {
    const deletedSet = readDeletedContributionIds();
    const localList = readLocalContributionsCache();
    const byId = new Map<string, AudioContributionRecord>();

    for (const item of localList) {
      if (item && item.id && !deletedSet.has(item.id)) {
        byId.set(item.id, item);
      }
    }
    for (const item of firestoreList) {
      if (item && item.id && !deletedSet.has(item.id)) {
        const existing = byId.get(item.id);
        if (!existing || (item.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
          byId.set(item.id, item);
        }
      }
    }
    for (const item of serverList) {
      if (item && item.id && !deletedSet.has(item.id)) {
        const existing = byId.get(item.id);
        if (!existing || (item.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
          byId.set(item.id, item);
        }
      }
    }

    const deduped = deduplicateContributions(Array.from(byId.values()), deletedSet);
    writeLocalContributionsCache(deduped, false);

    const sig = JSON.stringify(
      deduped.map((c) => `${c.id}:${c.status}:${c.updatedAtMs}:${c.banglaMeaning}`)
    );
    if (sig !== lastEmittedContribSig) {
      lastEmittedContribSig = sig;
      onUpdate(deduped);
    }
  };

  const syncWithSharedServerAndRecoverLocal = async () => {
    const state = await fetchSharedServerAudioState(true);
    const serverWordIds = new Set<string>();
    const deletedSet = readDeletedContributionIds();
    if (state) {
      const serverDelContribSet = new Set(state.deletedContributionIds || []);
      for (const delId of serverDelContribSet) {
        markContributionDeletedLocally(delId);
        deletedSet.add(delId);
      }
      serverList = state.contributions || [];
      for (const c of serverList) {
        if (c?.id && !serverDelContribSet.has(c.id)) {
          unmarkContributionDeletedLocally(c.id);
          deletedSet.delete(c.id);
        }
        if (c?.wordId) serverWordIds.add(c.wordId);
      }
    }

    // Push any local cached contributions that haven't reached the shared server yet (unless deleted by Admin)
    const localContribs = readLocalContributionsCache();
    for (const loc of localContribs) {
      if (!serverWordIds.has(loc.wordId) && !deletedSet.has(loc.id)) {
        await pushContributionToSharedServer(loc);
        serverWordIds.add(loc.wordId);
      }
    }

    if (!hasAutoSyncedPendingContributions) {
      hasAutoSyncedPendingContributions = true;
      try {
        const localMap = await getAllLocalCachedRecordings();
        for (const item of Object.values(localMap)) {
          const pendingId = `pending_${item.wordId}`
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 120);
          if (
            item.isPersonalOverride &&
            item.contributedToAdmin !== false &&
            !serverWordIds.has(item.wordId) &&
            !deletedSet.has(pendingId) &&
            !isSyntheticRestoredPlaceholder(item.word, item.audioDataUrl)
          ) {
            await submitAudioContribution({
              wordId: item.wordId,
              word: item.word,
              banglaMeaning: item.banglaMeaning,
              audio: {
                audioDataUrl: item.audioDataUrl,
                mimeType: item.mimeType,
                fileName: item.fileName,
                fileSize: item.fileSize,
                durationMs: item.durationMs,
              },
              contributorNameOverride: item.ownerName,
            });
          }
        }
      } catch {
        // ignore
      }
    }

    emitMerged();
  };

  // Emit immediately from local cache, then pull from shared server
  emitMerged();
  void syncWithSharedServerAndRecoverLocal();

  // Poll shared server every 3s so Admin Panel receives new user contributions in real time
  const pollId =
    typeof window !== 'undefined'
      ? window.setInterval(() => {
          void syncWithSharedServerAndRecoverLocal();
        }, 3000)
      : null;

  const q = query(
    collection(db, CONTRIBUTIONS_PATH),
    where('status', 'in', ['pending', 'approved', 'rejected'])
  );

  const unsubSnapshot = onSnapshot(
    q,
    (snapshot) => {
      const nextFirestore: AudioContributionRecord[] = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        if (isSyntheticRestoredPlaceholder(d.word || docSnap.id, d.audioDataUrl)) {
          return;
        }
        nextFirestore.push({
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

      firestoreList = nextFirestore;
      emitMerged();
    },
    () => {
      // Never wipe contributions to [] when Firestore hits daily read quota!
      emitMerged();
    }
  );

  let bc: BroadcastChannel | null = null;
  const onStorageChange = (e: StorageEvent) => {
    if (!e.key || e.key === LOCAL_CONTRIBUTIONS_CACHE_KEY) {
      emitMerged();
    }
  };
  const onLocalUpdate = () => emitMerged();

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorageChange);
    window.addEventListener('lw-contributions-local-update', onLocalUpdate);
    try {
      if ('BroadcastChannel' in window) {
        bc = new BroadcastChannel(CONTRIBUTIONS_BROADCAST_CHANNEL);
        bc.onmessage = () => emitMerged();
      }
    } catch {
      // ignore
    }
  }

  return () => {
    unsubSnapshot();
    if (pollId !== null && typeof window !== 'undefined') {
      window.clearInterval(pollId);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorageChange);
      window.removeEventListener('lw-contributions-local-update', onLocalUpdate);
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
 * Admin Action: Accepts a user's contributed audio.
 * 1. Publishes the audio to `/recordings/{wordId}` (General Audio for all users who don't have a personal override).
 * 2. Marks `/audioContributions/{id}` as `'approved'`.
 */
export async function approveAudioContribution(
  contribution: AudioContributionRecord,
  customBanglaMeaning?: string,
  customWordSpelling?: string
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
  const finalWord =
    customWordSpelling !== undefined && customWordSpelling.trim()
      ? customWordSpelling.trim().slice(0, 120)
      : contribution.word;

  // 1. Update General Cloud Audio in /recordings/{wordId} + Shared Server
  await publishGeneralCloudRecording({
    wordId: contribution.wordId,
    word: finalWord,
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

  // If the Admin also changed the word spelling or Bangla meaning from the original catalog, save it as a global word override for all users
  const orig = getOriginalCatalogWord(contribution.wordId);
  if (
    orig &&
    (finalWord !== orig.word || (finalBangla && finalBangla !== orig.bangla))
  ) {
    await saveGlobalWordSpellingOverride({
      wordId: contribution.wordId,
      word: finalWord,
      bangla: finalBangla || orig.bangla,
    });
  }

  // 2. Update local contributions cache
  const nowMs = Date.now();
  const updatedList = readLocalContributionsCache().map((c) =>
    c.id === contribution.id
      ? {
          ...c,
          word: finalWord,
          status: 'approved' as const,
          banglaMeaning: finalBangla,
          updatedAtMs: nowMs,
        }
      : c
  );
  writeLocalContributionsCache(updatedList, true);

  // 3. Update Shared Backend Server
  try {
    await fetch(
      `/api/sync/audio-contributions/${encodeURIComponent(contribution.id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'approved',
          word: finalWord,
          banglaMeaning: finalBangla,
        }),
      }
    );
  } catch {
    // ignore
  }

  // 4. Mark contribution as 'approved' in Cloud Firestore
  try {
    const contribRef = doc(db, CONTRIBUTIONS_PATH, contribution.id);
    await updateDoc(contribRef, {
      status: 'approved',
      word: finalWord,
      banglaMeaning: finalBangla,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Contribution approval synced via shared server (Firestore fallback):', err);
  }
  notifyRecordingsListeners();
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

  const nowMs = Date.now();
  const updatedList = readLocalContributionsCache().map((c) =>
    c.id === contributionId
      ? { ...c, status: 'rejected' as const, updatedAtMs: nowMs }
      : c
  );
  writeLocalContributionsCache(updatedList, true);

  try {
    await fetch(
      `/api/sync/audio-contributions/${encodeURIComponent(contributionId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected' }),
      }
    );
  } catch {
    // ignore
  }

  try {
    const contribRef = doc(db, CONTRIBUTIONS_PATH, contributionId);
    await updateDoc(contribRef, {
      status: 'rejected',
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Contribution rejection synced via shared server (Firestore fallback):', err);
  }
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

  markContributionDeletedLocally(contributionId);
  const remaining = readLocalContributionsCache().filter(
    (c) => c.id !== contributionId
  );
  writeLocalContributionsCache(remaining, true);

  try {
    await fetch(
      `/api/sync/audio-contributions/${encodeURIComponent(contributionId)}`,
      { method: 'DELETE' }
    );
  } catch {
    // ignore
  }

  try {
    await deleteDoc(doc(db, CONTRIBUTIONS_PATH, contributionId));
  } catch {
    // ignore
  }
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
    await pushGeneralRecordingToSharedServer({
      ...recording,
      banglaMeaning: safeBangla,
      updatedAtMs: Date.now(),
    });

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
 * Admin Action: Removes a General Audio recording from Cloud Firestore, Shared Server, and local cache.
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
  if (alsoDeleteFromGeneralCloud) {
    markRecordingDeletedLocally(wordId);
  }
  await removeRecordingFromLocalCache(wordId);
  notifyRecordingsListeners();

  if (alsoDeleteFromGeneralCloud) {
    try {
      await fetch(`/api/sync/recordings/${encodeURIComponent(wordId)}`, {
        method: 'DELETE',
      });
    } catch {
      // ignore
    }

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
    notifyRecordingsListeners();
  }
}

/**
 * Pushes any local unsynced recordings to Shared Server & Firestore Cloud without overwriting
 * contributions that have already been approved, rejected, or deleted by the Admin.
 */
export async function syncLocalRecordingsToCloud(): Promise<number> {
  try {
    const state = await fetchSharedServerAudioState(false);
    const deletedSet = readDeletedContributionIds();
    const existingServerWordIds = new Set<string>();
    if (state) {
      for (const delId of state.deletedContributionIds) {
        deletedSet.add(delId);
      }
      for (const c of state.contributions) {
        if (c?.wordId) existingServerWordIds.add(c.wordId);
      }
    }

    const localMap = await getAllLocalCachedRecordings();
    let count = 0;
    for (const item of Object.values(localMap)) {
      const pendingId = `pending_${item.wordId}`
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 120);
      if (
        item.isPersonalOverride &&
        item.contributedToAdmin !== false &&
        !existingServerWordIds.has(item.wordId) &&
        !deletedSet.has(pendingId) &&
        !isSyntheticRestoredPlaceholder(item.word, item.audioDataUrl)
      ) {
        await submitAudioContribution({
          wordId: item.wordId,
          word: item.word,
          banglaMeaning: item.banglaMeaning,
          audio: {
            audioDataUrl: item.audioDataUrl,
            mimeType: item.mimeType,
            fileName: item.fileName,
            fileSize: item.fileSize,
            durationMs: item.durationMs,
          },
          contributorNameOverride: item.ownerName,
        });
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
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

  const getLocalUserSessions = (): PracticeSessionRecord[] => {
    const localCached = readLocalSessionsCache();
    return localCached
      .filter((loc) => !loc.ownerId || loc.ownerId === targetOwnerId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, 20);
  };

  onUpdate(getLocalUserSessions());

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
      console.warn('Practice sessions operating from local cache:', error);
      onUpdate(getLocalUserSessions());
    }
  );
}

// ============================================================================
// PERSONAL STRUGGLING WORDS (SYNCED ACROSS ALL DEVICES FOR THE USER'S ACCOUNT)
// ============================================================================

const PERSONAL_WORDS_PATH = 'personalWords';
const DEVICE_PRIVATE_OWNER_KEY = 'lw_private_device_owner_id_v1';
const LOCAL_PERSONAL_WORDS_PREFIX = 'lw_personal_struggling_words_v1_';
const LOCAL_DELETED_PERSONAL_WORDS_PREFIX = 'lw_deleted_personal_words_v1_';
const PERSONAL_WORDS_BROADCAST_CHANNEL = 'lw_personal_words_sync_v1';

function notifyPersonalWordsListeners(ownerId: string): void {
  if (typeof window === 'undefined') return;
  try {
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel(PERSONAL_WORDS_BROADCAST_CHANNEL);
      bc.postMessage({ type: 'PERSONAL_WORDS_UPDATED', ownerId, ts: Date.now() });
      bc.close();
    }
    window.dispatchEvent(
      new CustomEvent('lw-personal-words-local-update', { detail: { ownerId } })
    );
  } catch {
    // Ignore BroadcastChannel errors
  }
}

function getAnonymousDeviceOwnerId(): string {
  if (typeof window === 'undefined') return 'local_private_user';
  try {
    let deviceId = window.localStorage.getItem(DEVICE_PRIVATE_OWNER_KEY);
    if (!deviceId || !/^[a-zA-Z0-9_-]+$/.test(deviceId)) {
      const rand = Math.random().toString(36).slice(2, 10);
      deviceId = `priv_${Date.now().toString(36)}_${rand}`;
      window.localStorage.setItem(DEVICE_PRIVATE_OWNER_KEY, deviceId);
    }
    return deviceId.slice(0, 80);
  } catch {
    return 'local_private_user';
  }
}

/**
 * Returns a deterministic account-bound `ownerId` for the current user:
 * - When signed in with an email account (Google OAuth, Email/Password, Quick Sign-In):
 *   uses `emailToDeterministicUid(email)` so the exact same `ownerId` is used on every device & browser!
 * - When signed in with a student ID: uses the user's `uid`.
 * - When not signed in: uses a device-local ID (`priv_...`), which is automatically migrated into
 *   the user's account as soon as they sign in.
 */
export function getPrivatePersonalOwnerId(explicitUserId?: string | null): string {
  const currentUser = auth.currentUser;
  const email = currentUser?.email?.trim().toLowerCase();
  if (email && !email.endsWith('@student.listenwrite.app')) {
    return emailToDeterministicUid(email)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80);
  }
  const uid = explicitUserId || currentUser?.uid;
  if (uid) {
    return uid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  }
  return getAnonymousDeviceOwnerId();
}

export function readLocalPersonalWordsCache(ownerId: string): PersonalWordRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(`${LOCAL_PERSONAL_WORDS_PREFIX}${ownerId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalPersonalWordsCache(
  ownerId: string,
  words: PersonalWordRecord[],
  notify = true
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      `${LOCAL_PERSONAL_WORDS_PREFIX}${ownerId}`,
      JSON.stringify(words)
    );
    if (notify) {
      notifyPersonalWordsListeners(ownerId);
    }
  } catch {
    // Ignore storage quota errors
  }
}

function readDeletedPersonalWordIds(ownerId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(
      `${LOCAL_DELETED_PERSONAL_WORDS_PREFIX}${ownerId}`
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeDeletedPersonalWordIds(ownerId: string, ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      `${LOCAL_DELETED_PERSONAL_WORDS_PREFIX}${ownerId}`,
      JSON.stringify(Array.from(ids).slice(-300))
    );
  } catch {
    // Ignore
  }
}

/**
 * If a user bookmarked struggling words on this device before signing in,
 * automatically merges those words into their signed-in account so they sync across devices.
 */
function migrateAnonymousDeviceWordsToAccount(accountOwnerId: string): void {
  if (typeof window === 'undefined') return;
  if (!accountOwnerId || accountOwnerId.startsWith('priv_')) return;

  try {
    const anonId = window.localStorage.getItem(DEVICE_PRIVATE_OWNER_KEY);
    if (!anonId || anonId === accountOwnerId) return;

    const anonWords = readLocalPersonalWordsCache(anonId);
    if (anonWords.length === 0) return;

    const existingAccountWords = readLocalPersonalWordsCache(accountOwnerId);
    const byWordId = new Map<string, PersonalWordRecord>();
    for (const w of existingAccountWords) {
      byWordId.set(w.wordId, w);
    }

    let addedAny = false;
    for (const aw of anonWords) {
      if (!byWordId.has(aw.wordId)) {
        const safeWordId = aw.wordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 44);
        const docId = `${accountOwnerId}_${safeWordId}`
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .slice(0, 128);
        byWordId.set(aw.wordId, {
          ...aw,
          id: docId,
          ownerId: accountOwnerId,
          updatedAtMs: Date.now(),
        });
        addedAny = true;
      }
    }

    if (addedAny) {
      const merged = Array.from(byWordId.values()).sort(
        (a, b) => b.updatedAtMs - a.updatedAtMs
      );
      writeLocalPersonalWordsCache(accountOwnerId, merged, false);
    }

    // Clear anonymous cache after migrating into the user's account
    window.localStorage.removeItem(`${LOCAL_PERSONAL_WORDS_PREFIX}${anonId}`);
  } catch {
    // Ignore migration errors
  }
}

export function personalWordToWordItem(rec: PersonalWordRecord): WordItem {
  const existingCatalogMatch = WORDS_CATALOG.find(
    (w) =>
      w.id === rec.wordId ||
      w.word.trim().toLowerCase() === rec.word.trim().toLowerCase()
  );

  return {
    id: rec.wordId,
    originalId: existingCatalogMatch?.originalId || `pw_${rec.wordId}`,
    word: rec.word,
    bangla: rec.bangla || existingCatalogMatch?.bangla || '',
    category: PERSONAL_STRUGGLING_CATEGORY,
    example:
      rec.example ||
      existingCatalogMatch?.example ||
      `Personal struggling word: ${rec.word}`,
    hasBundledAudio: Boolean(existingCatalogMatch?.hasBundledAudio),
    bundledAudioFile: existingCatalogMatch?.bundledAudioFile,
    page: existingCatalogMatch?.page || 1,
  };
}

/**
 * Adds or updates a personal struggling word and syncs it to the user's account in Shared Server + Cloud Firestore
 * so it appears on every device where the user signs in.
 */
export async function addOrUpdatePersonalWord(params: {
  word: string;
  bangla?: string;
  example?: string;
  audio?: ProcessedAudio | null;
  contributeToAdmin?: boolean;
}): Promise<PersonalWordRecord> {
  const cleanWord = params.word.trim().slice(0, 120);
  if (!cleanWord) {
    throw new Error('Please enter a word or phrase.');
  }

  const ownerId = getPrivatePersonalOwnerId();
  migrateAnonymousDeviceWordsToAccount(ownerId);

  const catalogMatch = WORDS_CATALOG.find(
    (w) => w.word.trim().toLowerCase() === cleanWord.toLowerCase()
  );
  const rawWordId = catalogMatch ? catalogMatch.id : toWordId(cleanWord);
  const safeWordId = rawWordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 44) || 'word';
  const docId = `${ownerId}_${safeWordId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);

  const safeBangla = (params.bangla ?? catalogMatch?.bangla ?? '').trim().slice(0, 200);
  const safeExample = (
    params.example ??
    catalogMatch?.example ??
    ''
  )
    .trim()
    .slice(0, 300);

  const nowMs = Date.now();
  const record: PersonalWordRecord = {
    id: docId,
    wordId: safeWordId,
    word: cleanWord,
    bangla: safeBangla,
    example: safeExample,
    ownerId,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };

  // Un-mark from deleted set if user re-adds this word
  const deletedSet = readDeletedPersonalWordIds(ownerId);
  if (deletedSet.has(safeWordId)) {
    deletedSet.delete(safeWordId);
    writeDeletedPersonalWordIds(ownerId, deletedSet);
  }

  // 1. Save immediately in user-scoped local cache
  const existingList = readLocalPersonalWordsCache(ownerId).filter(
    (w) => w.wordId !== safeWordId
  );
  writeLocalPersonalWordsCache(ownerId, [record, ...existingList], true);

  // 2. If user also provided custom pronunciation audio, save as Personal Audio AND send to Admin Panel
  if (params.audio) {
    await saveWordRecording({
      wordId: safeWordId,
      word: cleanWord,
      banglaMeaning: safeBangla,
      audio: params.audio,
      contributeToAdmin: params.contributeToAdmin ?? true,
    });
  }

  // 3. Push to Shared Backend Server so other devices signed into this account receive it immediately
  try {
    await fetch('/api/sync/personal-words', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: record }),
    });
  } catch {
    // ignore offline
  }

  // 4. Persist directly to Cloud Firestore scoped to this user's `ownerId`
  const docRef = doc(db, PERSONAL_WORDS_PATH, docId);
  try {
    await setDoc(docRef, {
      wordId: safeWordId,
      word: cleanWord,
      bangla: safeBangla,
      example: safeExample,
      ownerId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Saved personal word via shared server & local cache (Firestore fallback):', err);
  }

  return record;
}

/**
 * Removes a personal struggling word from the current user's list across local cache, Shared Server, & Cloud Firestore.
 */
export async function removePersonalWord(wordId: string): Promise<void> {
  const ownerId = getPrivatePersonalOwnerId();
  const safeWordId = wordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 44);
  const docId = `${ownerId}_${safeWordId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);

  const deletedSet = readDeletedPersonalWordIds(ownerId);
  deletedSet.add(safeWordId);
  deletedSet.add(wordId);
  writeDeletedPersonalWordIds(ownerId, deletedSet);

  const remaining = readLocalPersonalWordsCache(ownerId).filter(
    (w) => w.wordId !== safeWordId && w.wordId !== wordId
  );
  writeLocalPersonalWordsCache(ownerId, remaining, true);

  try {
    await fetch(
      `/api/sync/personal-words/${encodeURIComponent(ownerId)}/${encodeURIComponent(safeWordId)}`,
      { method: 'DELETE' }
    );
  } catch {
    // ignore
  }

  try {
    await deleteDoc(doc(db, PERSONAL_WORDS_PATH, docId));
  } catch (err) {
    console.warn('Removed personal word from local cache:', err);
  }
}

/**
 * Actively synchronizes the user's personal struggling words between local cache, Shared Server, and Cloud Firestore:
 * - Pulls all words saved on other devices for this user's `ownerId`.
 * - Pushes any locally saved struggling words that haven't been uploaded yet.
 */
export async function syncPersonalWordsNow(
  explicitUserId?: string | null
): Promise<PersonalWordRecord[]> {
  const ownerId = getPrivatePersonalOwnerId(explicitUserId);
  migrateAnonymousDeviceWordsToAccount(ownerId);

  const deletedSet = readDeletedPersonalWordIds(ownerId);
  const localList = readLocalPersonalWordsCache(ownerId).filter(
    (w) => !deletedSet.has(w.wordId)
  );
  const mergedByWordId = new Map<string, PersonalWordRecord>();
  const serverWordIds = new Set<string>();

  // Step 1: Pull from Shared Backend Server
  try {
    const res = await fetch(
      `/api/sync/personal-words/${encodeURIComponent(ownerId)}`,
      { cache: 'no-store' }
    );
    if (res.ok) {
      const data = await res.json();
      const serverWords: PersonalWordRecord[] = Array.isArray(data?.words)
        ? data.words
        : [];
      for (const sw of serverWords) {
        if (!sw || !sw.wordId || !sw.word) continue;
        if (deletedSet.has(sw.wordId)) continue;
        serverWordIds.add(sw.wordId);
        mergedByWordId.set(sw.wordId, sw);
      }
    }
  } catch {
    // ignore offline
  }

  // Step 2: Pull from Cloud Firestore if quota is available
  const cloudWordIds = new Set<string>();
  try {
    const q = query(
      collection(db, PERSONAL_WORDS_PATH),
      where('ownerId', '==', ownerId)
    );
    const snap = await getDocs(q);

    snap.forEach((docSnap) => {
      const d = docSnap.data();
      if (!d.wordId || !d.word) return;
      if (deletedSet.has(d.wordId)) {
        void deleteDoc(doc(db, PERSONAL_WORDS_PATH, docSnap.id)).catch(() => {});
        return;
      }
      cloudWordIds.add(d.wordId);
      const item: PersonalWordRecord = {
        id: docSnap.id,
        wordId: d.wordId,
        word: d.word,
        bangla: d.bangla || '',
        example: d.example || '',
        ownerId: d.ownerId || ownerId,
        createdAtMs: d.createdAt?.toMillis?.() || Date.now(),
        updatedAtMs: d.updatedAt?.toMillis?.() || Date.now(),
      };
      mergedByWordId.set(item.wordId, item);
    });
  } catch {
    // Firestore quota/offline fallback
  }

  // Step 3: Merge local words and push any missing words to Shared Server & Firestore
  const toPushToServer: PersonalWordRecord[] = [];
  for (const loc of localList) {
    if (!deletedSet.has(loc.wordId)) {
      const safeWordId = loc.wordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 44) || 'word';
      const docId = `${ownerId}_${safeWordId}`
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 128);
      const updatedLoc: PersonalWordRecord = {
        ...loc,
        id: docId,
        wordId: safeWordId,
        ownerId,
      };
      if (!mergedByWordId.has(safeWordId)) {
        mergedByWordId.set(safeWordId, updatedLoc);
      }
      if (!serverWordIds.has(safeWordId)) {
        toPushToServer.push(updatedLoc);
      }
      if (!cloudWordIds.has(safeWordId)) {
        void setDoc(doc(db, PERSONAL_WORDS_PATH, docId), {
          wordId: safeWordId,
          word: loc.word.trim().slice(0, 120),
          bangla: (loc.bangla || '').trim().slice(0, 200),
          example: (loc.example || '').trim().slice(0, 300),
          ownerId,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
    }
  }

  for (const w of mergedByWordId.values()) {
    if (!serverWordIds.has(w.wordId)) {
      toPushToServer.push(w);
    }
  }

  if (toPushToServer.length > 0) {
    try {
      await fetch('/api/sync/personal-words', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ words: toPushToServer }),
      });
    } catch {
      // ignore
    }
  }

  const finalWords = Array.from(mergedByWordId.values()).sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs
  );
  writeLocalPersonalWordsCache(ownerId, finalWords, false);
  return finalWords;
}

/**
 * Subscribes to the current user's private struggling words (`/personalWords` where `ownerId == currentOwnerId`)
 * and synchronizes across all devices logged into the same account.
 */
export function subscribeToPersonalWords(
  userId: string | undefined | null,
  onUpdate: (words: PersonalWordRecord[]) => void
): Unsubscribe {
  const ownerId = getPrivatePersonalOwnerId(userId);
  migrateAnonymousDeviceWordsToAccount(ownerId);

  const emitLocal = () => {
    const deletedSet = readDeletedPersonalWordIds(ownerId);
    const list = readLocalPersonalWordsCache(ownerId).filter(
      (w) => !deletedSet.has(w.wordId)
    );
    onUpdate(list);
  };

  // Immediately emit local cached personal words so UI is instant
  emitLocal();

  // Trigger an initial two-way sync to push any local unsynced words to Cloud Firestore
  void syncPersonalWordsNow(userId).then((synced) => {
    onUpdate(synced);
  });

  const q = query(
    collection(db, PERSONAL_WORDS_PATH),
    where('ownerId', '==', ownerId)
  );

  const unsubSnapshot = onSnapshot(
    q,
    (snapshot) => {
      const deletedSet = readDeletedPersonalWordIds(ownerId);
      const localList = readLocalPersonalWordsCache(ownerId).filter(
        (w) => !deletedSet.has(w.wordId)
      );
      const cloudWordIds = new Set<string>();
      const mergedByWordId = new Map<string, PersonalWordRecord>();

      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        if (!d.wordId || !d.word) return;
        if (deletedSet.has(d.wordId)) {
          void deleteDoc(doc(db, PERSONAL_WORDS_PATH, docSnap.id)).catch(() => {});
          return;
        }
        cloudWordIds.add(d.wordId);
        const item: PersonalWordRecord = {
          id: docSnap.id,
          wordId: d.wordId,
          word: d.word,
          bangla: d.bangla || '',
          example: d.example || '',
          ownerId: d.ownerId || ownerId,
          createdAtMs: d.createdAt?.toMillis?.() || Date.now(),
          updatedAtMs: d.updatedAt?.toMillis?.() || Date.now(),
        };
        mergedByWordId.set(item.wordId, item);
      });

      // Preserve & auto-upload any locally added personal words not yet in Cloud Firestore
      for (const loc of localList) {
        if (!cloudWordIds.has(loc.wordId) && !deletedSet.has(loc.wordId)) {
          const safeWordId =
            loc.wordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 44) || 'word';
          const docId = `${ownerId}_${safeWordId}`
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 128);
          mergedByWordId.set(safeWordId, {
            ...loc,
            id: docId,
            wordId: safeWordId,
            ownerId,
          });
          void setDoc(doc(db, PERSONAL_WORDS_PATH, docId), {
            wordId: safeWordId,
            word: loc.word.trim().slice(0, 120),
            bangla: (loc.bangla || '').trim().slice(0, 200),
            example: (loc.example || '').trim().slice(0, 300),
            ownerId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }).catch(() => {});
        }
      }

      const finalWords = Array.from(mergedByWordId.values()).sort(
        (a, b) => b.updatedAtMs - a.updatedAtMs
      );
      writeLocalPersonalWordsCache(ownerId, finalWords, false);
      onUpdate(finalWords);
    },
    (error) => {
      console.warn('Personal words operating from local private cache:', error);
      emitLocal();
    }
  );

  let bc: BroadcastChannel | null = null;
  const onStorageChange = (e: StorageEvent) => {
    if (!e.key || e.key.startsWith(LOCAL_PERSONAL_WORDS_PREFIX)) {
      emitLocal();
    }
  };
  const onLocalCustomUpdate = () => emitLocal();

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorageChange);
    window.addEventListener('lw-personal-words-local-update', onLocalCustomUpdate);
    try {
      if ('BroadcastChannel' in window) {
        bc = new BroadcastChannel(PERSONAL_WORDS_BROADCAST_CHANNEL);
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
      window.removeEventListener(
        'lw-personal-words-local-update',
        onLocalCustomUpdate
      );
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

// ============================================================================
// ADMIN GLOBAL WORD SPELLING OVERRIDES (APPLIES TO ALL USERS IN REAL TIME)
// ============================================================================

const WORD_OVERRIDES_PATH = 'wordOverrides';
const LOCAL_WORD_OVERRIDES_KEY = 'lw_global_word_overrides_v1';
const LOCAL_DELETED_WORD_OVERRIDES_KEY = 'lw_deleted_word_override_ids_v1';
const WORD_OVERRIDES_BROADCAST_CHANNEL = 'lw_global_word_overrides_sync_v1';

function readDeletedWordOverrideIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(LOCAL_DELETED_WORD_OVERRIDES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function markWordOverrideDeletedLocally(wordId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const set = readDeletedWordOverrideIds();
    set.add(wordId);
    window.localStorage.setItem(
      LOCAL_DELETED_WORD_OVERRIDES_KEY,
      JSON.stringify(Array.from(set).slice(-300))
    );
  } catch {
    // ignore
  }
}

function unmarkWordOverrideDeletedLocally(wordId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const set = readDeletedWordOverrideIds();
    if (set.has(wordId)) {
      set.delete(wordId);
      window.localStorage.setItem(
        LOCAL_DELETED_WORD_OVERRIDES_KEY,
        JSON.stringify(Array.from(set))
      );
    }
  } catch {
    // ignore
  }
}

export function readLocalWordOverridesCache(): Record<string, GlobalWordOverride> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(LOCAL_WORD_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const deletedSet = readDeletedWordOverrideIds();
    const clean: Record<string, GlobalWordOverride> = {};
    for (const [wid, val] of Object.entries(parsed)) {
      const ov = val as GlobalWordOverride;
      if (ov && ov.wordId && ov.word && !deletedSet.has(wid)) {
        clean[wid] = ov;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function writeLocalWordOverridesCache(
  map: Record<string, GlobalWordOverride>,
  notify = true
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_WORD_OVERRIDES_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
  applyGlobalWordOverridesToCatalog(map);
  if (notify) {
    try {
      if ('BroadcastChannel' in window) {
        const bc = new BroadcastChannel(WORD_OVERRIDES_BROADCAST_CHANNEL);
        bc.postMessage({ type: 'WORD_OVERRIDES_UPDATED', ts: Date.now() });
        bc.close();
      }
      window.dispatchEvent(new CustomEvent('lw-word-overrides-local-update'));
    } catch {
      // ignore
    }
  }
}

/**
 * Admin Action: Changes the official English spelling (and optionally Bangla meaning)
 * for a catalog word and applies it to all users across Practice, Categories, Strict Test,
 * Live Contests, and Audio Studio.
 */
export async function saveGlobalWordSpellingOverride(params: {
  wordId: string;
  word: string;
  bangla?: string;
}): Promise<GlobalWordOverride> {
  const user = auth.currentUser;
  if (!isAdminUser(user)) {
    throw new Error(
      `Access denied: Only the Admin (${ADMIN_EMAIL}) can change word spellings for all users.`
    );
  }

  const safeWordId = params.wordId
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  const safeWord = params.word.trim().slice(0, 120);
  if (!safeWord) {
    throw new Error('Spelling cannot be empty.');
  }
  const orig = getOriginalCatalogWord(safeWordId);
  const safeBangla =
    params.bangla !== undefined
      ? params.bangla.trim().slice(0, 200)
      : orig?.bangla || '';
  const safeUpdatedBy = (
    user?.displayName ||
    user?.email ||
    ADMIN_EMAIL
  )
    .trim()
    .slice(0, 120);
  const nowMs = Date.now();

  unmarkWordOverrideDeletedLocally(safeWordId);

  const overrideRecord: GlobalWordOverride = {
    wordId: safeWordId,
    word: safeWord,
    bangla: safeBangla,
    updatedBy: safeUpdatedBy,
    updatedAtMs: nowMs,
  };

  // 1. Update local cache & mutate WORDS_CATALOG in-place immediately
  const currentLocal = readLocalWordOverridesCache();
  currentLocal[safeWordId] = overrideRecord;
  writeLocalWordOverridesCache(currentLocal, true);

  // 2. Push to Shared Backend Server so all connected users receive the new spelling immediately
  try {
    await fetch('/api/sync/word-overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override: overrideRecord }),
    });
  } catch {
    // ignore
  }

  // 3. Also write to Cloud Firestore (/wordOverrides/{wordId})
  try {
    const docRef = doc(db, WORD_OVERRIDES_PATH, safeWordId);
    const snap = await getDoc(docRef);
    if (!snap.exists()) {
      await setDoc(docRef, {
        wordId: safeWordId,
        word: safeWord,
        bangla: safeBangla,
        updatedBy: safeUpdatedBy,
        status: 'published',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(docRef, {
        word: safeWord,
        bangla: safeBangla,
        updatedBy: safeUpdatedBy,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    console.warn('Global word override synced via shared server (Firestore fallback):', err);
  }

  // 4. If a General Recording (/recordings/{wordId}) exists in Firestore, also sync its `word` and `banglaMeaning`
  try {
    const recRef = doc(db, RECORDINGS_PATH, safeWordId);
    const recSnap = await getDoc(recRef);
    if (recSnap.exists()) {
      const rData = recSnap.data();
      await updateDoc(recRef, {
        word: safeWord,
        banglaMeaning: safeBangla || rData.banglaMeaning || '',
        audioDataUrl: rData.audioDataUrl,
        mimeType: rData.mimeType,
        fileName: rData.fileName,
        fileSize: rData.fileSize,
        durationMs: rData.durationMs,
        ownerId: rData.ownerId,
        ownerName: rData.ownerName,
        updatedAt: serverTimestamp(),
      });
    }
  } catch {
    // ignore
  }

  return overrideRecord;
}

/**
 * Admin Action: Resets a word's spelling back to its original default catalog spelling for all users.
 */
export async function resetGlobalWordSpellingOverride(
  wordId: string
): Promise<void> {
  const user = auth.currentUser;
  if (!isAdminUser(user)) {
    throw new Error(
      `Access denied: Only the Admin (${ADMIN_EMAIL}) can reset word spellings.`
    );
  }

  const safeWordId = wordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const orig = getOriginalCatalogWord(safeWordId);
  markWordOverrideDeletedLocally(safeWordId);

  const currentLocal = readLocalWordOverridesCache();
  delete currentLocal[safeWordId];
  writeLocalWordOverridesCache(currentLocal, true);

  try {
    const querySuffix = orig?.word
      ? `?originalWord=${encodeURIComponent(orig.word)}`
      : '';
    await fetch(
      `/api/sync/word-overrides/${encodeURIComponent(safeWordId)}${querySuffix}`,
      {
        method: 'DELETE',
      }
    );
  } catch {
    // ignore
  }

  try {
    await deleteDoc(doc(db, WORD_OVERRIDES_PATH, safeWordId));
  } catch {
    // ignore
  }

  // Also restore original word on /recordings/{wordId} if present
  if (orig) {
    try {
      const recRef = doc(db, RECORDINGS_PATH, safeWordId);
      const recSnap = await getDoc(recRef);
      if (recSnap.exists()) {
        const rData = recSnap.data();
        await updateDoc(recRef, {
          word: orig.word,
          banglaMeaning: rData.banglaMeaning || orig.bangla,
          audioDataUrl: rData.audioDataUrl,
          mimeType: rData.mimeType,
          fileName: rData.fileName,
          fileSize: rData.fileSize,
          durationMs: rData.durationMs,
          ownerId: rData.ownerId,
          ownerName: rData.ownerName,
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Subscribes to Admin-defined Global Word Spelling Overrides in real time across all users,
 * browsers, and devices, automatically mutating WORDS_CATALOG in-place and notifying React state.
 */
export function subscribeToGlobalWordOverrides(
  onUpdate: (overridesMap: Record<string, GlobalWordOverride>) => void
): Unsubscribe {
  let latestFirestoreOverrides: Record<string, GlobalWordOverride> = {};
  let latestServerOverrides: Record<string, GlobalWordOverride> = {};
  let lastEmittedSig = '';

  const emitMerged = () => {
    const deletedSet = readDeletedWordOverrideIds();
    const localMap = readLocalWordOverridesCache();
    const merged: Record<string, GlobalWordOverride> = {};

    for (const [wid, ov] of Object.entries(localMap)) {
      if (!deletedSet.has(wid)) merged[wid] = ov;
    }
    for (const [wid, ov] of Object.entries(latestServerOverrides)) {
      if (ov && ov.wordId && ov.word && !deletedSet.has(wid)) {
        const existing = merged[wid];
        if (!existing || (ov.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
          merged[wid] = ov;
        }
      }
    }
    for (const [wid, ov] of Object.entries(latestFirestoreOverrides)) {
      if (ov && ov.wordId && ov.word && !deletedSet.has(wid)) {
        const existing = merged[wid];
        if (!existing || (ov.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
          merged[wid] = ov;
        }
      }
    }

    writeLocalWordOverridesCache(merged, false);
    const sig = applyGlobalWordOverridesToCatalog(merged);
    if (sig !== lastEmittedSig) {
      lastEmittedSig = sig;
      onUpdate({ ...merged });
    }
  };

  const pullFromServer = async () => {
    const state = await fetchSharedServerAudioState(false);
    if (state) {
      const deletedServerSet = new Set(state.deletedWordOverrideIds || []);
      for (const delId of deletedServerSet) {
        markWordOverrideDeletedLocally(delId);
      }
      for (const wid of Object.keys(state.wordOverrides || {})) {
        if (!deletedServerSet.has(wid)) {
          unmarkWordOverrideDeletedLocally(wid);
        }
      }
      latestServerOverrides = state.wordOverrides || {};
      emitMerged();
    }
  };

  emitMerged();
  void pullFromServer();

  const pollId =
    typeof window !== 'undefined'
      ? window.setInterval(() => {
          void pullFromServer();
        }, 5000)
      : null;

  const q = query(
    collection(db, WORD_OVERRIDES_PATH),
    where('status', '==', 'published')
  );

  const unsubSnapshot = onSnapshot(
    q,
    (snapshot) => {
      const deletedSet = readDeletedWordOverrideIds();
      const nextFirestore: Record<string, GlobalWordOverride> = {};
      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        const wid = d.wordId || docSnap.id;
        if (!wid || !d.word || deletedSet.has(wid)) return;
        nextFirestore[wid] = {
          wordId: wid,
          word: d.word,
          bangla: d.bangla || '',
          updatedBy: d.updatedBy || 'Admin',
          updatedAtMs:
            d.updatedAt?.toMillis?.() ||
            d.createdAt?.toMillis?.() ||
            Date.now(),
        };
      });
      latestFirestoreOverrides = nextFirestore;
      emitMerged();
    },
    () => {
      emitMerged();
    }
  );

  let bc: BroadcastChannel | null = null;
  const onLocalEvent = () => emitMerged();
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key === LOCAL_WORD_OVERRIDES_KEY) {
      emitMerged();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
    window.addEventListener('lw-word-overrides-local-update', onLocalEvent);
    window.addEventListener('focus', () => void pullFromServer());
    try {
      if ('BroadcastChannel' in window) {
        bc = new BroadcastChannel(WORD_OVERRIDES_BROADCAST_CHANNEL);
        bc.onmessage = () => emitMerged();
      }
    } catch {
      // ignore
    }
  }

  return () => {
    unsubSnapshot();
    if (pollId !== null && typeof window !== 'undefined') {
      window.clearInterval(pollId);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('lw-word-overrides-local-update', onLocalEvent);
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



