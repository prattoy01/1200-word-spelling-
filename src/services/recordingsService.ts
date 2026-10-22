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
  orderBy,
  limit,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  db,
  auth,
  OperationType,
  handleFirestoreError,
} from '../firebase';
import {
  type ProcessedAudio,
  type CachedRecordingItem,
  saveRecordingToLocalCache,
  removeRecordingFromLocalCache,
  getAllLocalCachedRecordings,
  synthesizeWordAudioDataUrl,
} from '../utils/audioUtils';
import { SCREENSHOT_14_UPLOADS, toWordId } from '../data/words';

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
  source: 'cloud' | 'local-unsynced';
}

export interface PracticeSessionRecord {
  id: string;
  ownerId: string;
  category: string;
  totalWords: number;
  correctCount: number;
  accuracy: number;
  createdAtMs: number;
}

const RECORDINGS_PATH = 'recordings';
const SESSIONS_PATH = 'practiceSessions';

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
  const safeMimeType = (params.audio.mimeType || 'audio/wav').slice(0, 64);
  const safeFileName = (params.audio.fileName || `${safeWordId}.wav`).slice(0, 160);
  const safeFileSize = Math.max(0, Math.min(10485760, Math.round(params.audio.fileSize || 1024)));
  const safeDurationMs = Math.max(0, Math.min(120000, Math.round(params.audio.durationMs || 1200)));
  const safeOwnerId = params.ownerId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const safeOwnerName = (params.ownerName || 'IELTS Instructor').trim().slice(0, 120);

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
 * Subscribes to all published pronunciation recordings in Firestore.
 * Works across all browsers, Incognito tabs (even when logged out), and different accounts.
 */
export function subscribeToPublishedRecordings(
  onUpdate: (recordingsMap: Record<string, CloudRecording>) => void
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

      // Include any local-only unsynced recordings first
      for (const [wordId, item] of Object.entries(localMap)) {
        if (!item.syncedToCloud) {
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
            source: 'local-unsynced',
          };
        }
      }

      // Overlay cloud-synced published recordings (source of truth across browsers & Incognito)
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const wordId = data.wordId || docSnap.id;
        const updatedAtMs =
          data.updatedAt?.toMillis?.() ||
          data.createdAt?.toMillis?.() ||
          Date.now();

        const cloudRec: CloudRecording = {
          wordId,
          word: data.word || wordId,
          banglaMeaning: data.banglaMeaning || '',
          audioDataUrl: data.audioDataUrl,
          mimeType: data.mimeType || 'audio/wav',
          fileName: data.fileName || `${wordId}.wav`,
          fileSize: data.fileSize || 0,
          durationMs: data.durationMs || 1200,
          ownerId: data.ownerId || '',
          ownerName: data.ownerName || 'Cloud User',
          status: 'published',
          updatedAtMs,
          source: 'cloud',
        };

        merged[wordId] = cloudRec;

        // Mirror to local IndexedDB for instant offline access
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
        });
      });

      onUpdate(merged);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, RECORDINGS_PATH);
    }
  );
}

/**
 * Saves or updates a pronunciation recording.
 * If the user is signed in with a verified Google account, writes directly to Firestore
 * so it immediately appears in Incognito, other browsers, and other devices.
 * Also caches locally in IndexedDB for offline resiliency.
 */
export async function saveWordRecording(params: {
  wordId: string;
  word: string;
  banglaMeaning: string;
  audio: ProcessedAudio;
}): Promise<{ syncedToCloud: boolean }> {
  const user = auth.currentUser;
  const ownerId = user?.uid || 'local_browser_user';
  const ownerName = user?.displayName || user?.email?.split('@')[0] || 'Local User';

  const clean = sanitizeRecordingInput({
    ...params,
    ownerId,
    ownerName,
  });

  // 1. Always save to local IndexedDB cache immediately
  const cacheEntry: CachedRecordingItem = {
    ...clean,
    updatedAtMs: Date.now(),
    syncedToCloud: Boolean(user),
  };
  await saveRecordingToLocalCache(cacheEntry);

  // 2. If signed in, persist to Firestore Cloud
  if (user) {
    const docRef = doc(db, RECORDINGS_PATH, clean.wordId);
    const docPath = `${RECORDINGS_PATH}/${clean.wordId}`;

    let existingSnap;
    try {
      existingSnap = await getDoc(docRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, docPath);
    }

    if (!existingSnap.exists()) {
      try {
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
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, docPath);
      }
    } else {
      const existingData = existingSnap.data();
      if (existingData.status !== 'archived') {
        try {
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
        } catch (error) {
          handleFirestoreError(error, OperationType.UPDATE, docPath);
        }
      }
    }

    return { syncedToCloud: true };
  }

  return { syncedToCloud: false };
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
    syncedToCloud: Boolean(auth.currentUser),
  });

  if (auth.currentUser && recording.ownerId === auth.currentUser.uid) {
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
        ownerName: recording.ownerName,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `${RECORDINGS_PATH}/${recording.wordId}`);
    }
  }
}

/**
 * Removes/archives a recording from both Cloud Firestore and local cache.
 */
export async function deleteWordRecording(wordId: string, ownerId?: string): Promise<void> {
  await removeRecordingFromLocalCache(wordId);

  if (auth.currentUser && (!ownerId || ownerId === auth.currentUser.uid || auth.currentUser.email === 'prattoy.photos01@gmail.com')) {
    const docRef = doc(db, RECORDINGS_PATH, wordId);
    try {
      await deleteDoc(docRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `${RECORDINGS_PATH}/${wordId}`);
    }
  }
}

/**
 * Pushes any local unsynced recordings to Firestore Cloud once the user signs in.
 */
export async function syncLocalRecordingsToCloud(): Promise<number> {
  const user = auth.currentUser;
  if (!user) return 0;

  const localMap = await getAllLocalCachedRecordings();
  let syncedCount = 0;

  for (const item of Object.values(localMap)) {
    if (!item.syncedToCloud) {
      await saveWordRecording({
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
      });
      syncedCount++;
    }
  }

  return syncedCount;
}

/**
 * Seeds the 14 recordings from the user's screenshot ("orienteering", "caving", "scuba-diving", "snorkeling", etc.)
 * into Cloud Firestore so they are immediately available across all browsers and Incognito.
 */
export async function seedScreenshot14RecordingsToCloud(
  onProgress?: (current: number, total: number, word: string) => void
): Promise<number> {
  const total = SCREENSHOT_14_UPLOADS.length;
  let count = 0;

  for (const entry of SCREENSHOT_14_UPLOADS) {
    count++;
    onProgress?.(count, total, entry.word);
    const wordId = toWordId(entry.word);
    const audio = await synthesizeWordAudioDataUrl(entry.word);
    await saveWordRecording({
      wordId,
      word: entry.word,
      banglaMeaning: entry.bangla,
      audio,
    });
  }

  return count;
}

/**
 * Records a completed IELTS spelling practice session for the signed-in user.
 */
export async function savePracticeSession(params: {
  category: string;
  totalWords: number;
  correctCount: number;
}): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;

  const totalWords = Math.max(1, Math.min(1000, Math.round(params.totalWords)));
  const correctCount = Math.max(0, Math.min(totalWords, Math.round(params.correctCount)));
  const accuracy = Math.round((correctCount / totalWords) * 100);

  try {
    await addDoc(collection(db, SESSIONS_PATH), {
      ownerId: user.uid.slice(0, 128),
      category: params.category.trim().slice(0, 80) || 'General IELTS',
      totalWords,
      correctCount,
      accuracy,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, SESSIONS_PATH);
  }
}

export function subscribeToUserPracticeSessions(
  userId: string,
  onUpdate: (sessions: PracticeSessionRecord[]) => void
): Unsubscribe {
  const q = query(
    collection(db, SESSIONS_PATH),
    where('ownerId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(15)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const list: PracticeSessionRecord[] = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        list.push({
          id: docSnap.id,
          ownerId: d.ownerId,
          category: d.category,
          totalWords: d.totalWords,
          correctCount: d.correctCount,
          accuracy: d.accuracy,
          createdAtMs: d.createdAt?.toMillis?.() || Date.now(),
        });
      });
      onUpdate(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, SESSIONS_PATH);
    }
  );
}
