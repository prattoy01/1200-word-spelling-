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
 * Subscribes to all published pronunciation recordings in Firestore.
 * Automatically filters out and upgrades any legacy synthetic sine-wave records.
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

      for (const [wordId, item] of Object.entries(localMap)) {
        if (isSyntheticRestoredPlaceholder(item.word, item.audioDataUrl)) {
          void removeRecordingFromLocalCache(wordId);
          continue;
        }
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

      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const wordId = data.wordId || docSnap.id;
        const word = data.word || wordId;

        // Ignore legacy synthetic sine-wave records so they never mask real MP3 audio
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
          ownerId: data.ownerId || 'cloud_studio_user',
          ownerName: data.ownerName || 'Cloud User',
          status: 'published',
          updatedAtMs,
          source: 'cloud',
        };

        merged[wordId] = cloudRec;

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
 * Saves or updates a pronunciation recording directly to Firebase Cloud AND local IndexedDB
 * so it immediately appears across Web, Mobile App, and Incognito.
 */
export async function saveWordRecording(params: {
  wordId: string;
  word: string;
  banglaMeaning: string;
  audio: ProcessedAudio;
}): Promise<{ syncedToCloud: boolean }> {
  const user = auth.currentUser;
  const ownerId = user?.uid || 'cloud_studio_shared';
  const ownerName =
    user?.displayName || user?.email?.split('@')[0] || 'Cloud Studio';

  const clean = sanitizeRecordingInput({
    ...params,
    ownerId,
    ownerName,
  });

  // 1. Save to local IndexedDB cache immediately
  await saveRecordingToLocalCache({
    ...clean,
    updatedAtMs: Date.now(),
    syncedToCloud: true,
  });

  // 2. Always persist to Firestore Cloud so Web <-> Mobile <-> Incognito stay in sync
  const docRef = doc(db, RECORDINGS_PATH, clean.wordId);
  const docPath = `${RECORDINGS_PATH}/${clean.wordId}`;

  try {
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
    return { syncedToCloud: true };
  } catch (error) {
    console.warn('Cloud save fallback to local cache:', error);
    await saveRecordingToLocalCache({
      ...clean,
      updatedAtMs: Date.now(),
      syncedToCloud: false,
    });
    return { syncedToCloud: false };
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

/**
 * Removes a recording from both Cloud Firestore and local cache.
 */
export async function deleteWordRecording(
  wordId: string,
  _ownerId?: string
): Promise<void> {
  await removeRecordingFromLocalCache(wordId);
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

/**
 * Pushes any local unsynced recordings to Firestore Cloud.
 */
export async function syncLocalRecordingsToCloud(): Promise<number> {
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
 * using REAL human pronunciation MP3 files from /public/audio-w*.mp3 into Cloud Firestore.
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
    await saveWordRecording({
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
    });
  }

  return count;
}

/**
 * Records a completed IELTS spelling practice or strict exam session.
 */
export async function savePracticeSession(params: {
  category: string;
  totalWords: number;
  correctCount: number;
}): Promise<void> {
  const user = auth.currentUser;
  const ownerId = (user?.uid || 'cloud_studio_shared').slice(0, 128);

  const totalWords = Math.max(1, Math.min(1000, Math.round(params.totalWords)));
  const correctCount = Math.max(
    0,
    Math.min(totalWords, Math.round(params.correctCount))
  );
  const accuracy = Math.round((correctCount / totalWords) * 100);

  try {
    await addDoc(collection(db, SESSIONS_PATH), {
      ownerId,
      category: params.category.trim().slice(0, 80) || 'General IELTS',
      totalWords,
      correctCount,
      accuracy,
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    console.warn('Could not save practice session:', error);
  }
}

export function subscribeToUserPracticeSessions(
  userId: string,
  onUpdate: (sessions: PracticeSessionRecord[]) => void
): Unsubscribe {
  const targetOwnerId = userId || 'cloud_studio_shared';
  const q = query(
    collection(db, SESSIONS_PATH),
    where('ownerId', '==', targetOwnerId),
    limit(40)
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
      list.sort((a, b) => b.createdAtMs - a.createdAtMs);
      onUpdate(list.slice(0, 15));
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, SESSIONS_PATH);
    }
  );
}
