/**
 * Mobile & Cross-Browser Audio Engine for Listen & Write.
 * - Plays the 782 original bundled MP3/OGG recordings from the user's Google Drive (/audio-w1.mp3 .. /audio-w926.mp3).
 * - Plays real user-uploaded / microphone-recorded audio synced via Firebase Cloud.
 * - Plays real Google Dictionary MP3 fallbacks (/dict-fallback/audio-w*.mp3) for unrecorded words.
 * - Transcodes microphone recordings and uploads into universal 16-bit PCM WAV or preserves MP3
 *   so recordings made on PC Web play on iPhone/Android and vice versa.
 */

import { WORDS_CATALOG, toWordId } from '../data/words';

export interface ProcessedAudio {
  audioDataUrl: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  durationMs: number;
}

const MAX_RAW_BASE64_LENGTH = 820000;

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to encode audio file as data URL.'));
      }
    };
    reader.onerror = () => reject(new Error('Error reading audio file.'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(',');
  const header = parts[0] || '';
  const base64 = parts[1] || '';
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'audio/mpeg';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Encodes a mono Float32Array PCM buffer into a standard 16-bit or 8-bit WAV Blob.
 * WAV is supported on 100% of Android, iOS Safari, Chrome, Brave, and Desktop browsers.
 */
function encodeMonoWav(
  samples: Float32Array,
  sampleRate: number,
  bitsPerSample: 8 | 16 = 16
): Blob {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    if (bitsPerSample === 16) {
      const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += 2;
    } else {
      const uint8 = Math.round((clamped + 1) * 127.5);
      view.setUint8(offset, uint8);
      offset += 1;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Normalizes and converts any decoded audio buffer into a universal mono WAV
 * that plays identically across Android, iOS, and Desktop browsers and fits in Firestore.
 */
async function transcodeToCompactWav(
  arrayBuffer: ArrayBuffer,
  originalName: string
): Promise<ProcessedAudio> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const audioCtx = new AudioCtx();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const maxDurationSec = Math.min(decoded.duration, 12);
    const targetRate = maxDurationSec <= 4.5 ? 22050 : 16000;
    const targetLength = Math.max(1, Math.floor(maxDurationSec * targetRate));

    const offlineCtx = new OfflineAudioContext(1, targetLength, targetRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start(0);

    const rendered = await offlineCtx.startRendering();
    const channelData = rendered.getChannelData(0);

    // Peak normalize so quiet phone or laptop mic recordings sound crisp and loud
    let peak = 0;
    for (let i = 0; i < channelData.length; i++) {
      const abs = Math.abs(channelData[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 0.005 && peak < 0.95) {
      const gain = Math.min(8, 0.92 / peak);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = Math.max(-1, Math.min(1, channelData[i] * gain));
      }
    }

    let wavBlob = encodeMonoWav(channelData, targetRate, 16);
    let dataUrl = await blobToDataUrl(wavBlob);

    if (dataUrl.length > MAX_RAW_BASE64_LENGTH) {
      wavBlob = encodeMonoWav(channelData, 12000, 8);
      dataUrl = await blobToDataUrl(wavBlob);
    }

    const cleanName = originalName.replace(/\.[^/.]+$/, '') + '.wav';
    return {
      audioDataUrl: dataUrl,
      mimeType: 'audio/wav',
      fileName: cleanName.slice(0, 150),
      fileSize: wavBlob.size,
      durationMs: Math.round(maxDurationSec * 1000),
    };
  } finally {
    await audioCtx.close().catch(() => {});
  }
}

/**
 * Processes an uploaded audio file (MP3, M4A, OGG, WAV, WebM) or microphone recording.
 */
export async function processAudioBlob(
  blob: Blob,
  fileName: string
): Promise<ProcessedAudio> {
  if (blob.size > 10 * 1024 * 1024) {
    throw new Error('File exceeds the 10 MB maximum size limit.');
  }

  // If it's already a compact MP3 file (< 450 KB), keep original high-clarity MP3 directly!
  const isMp3 =
    blob.type === 'audio/mpeg' ||
    blob.type === 'audio/mp3' ||
    fileName.toLowerCase().endsWith('.mp3');

  if (isMp3 && blob.size > 400 && blob.size <= 450 * 1024) {
    const mp3Blob =
      blob.type === 'audio/mpeg' ? blob : new Blob([blob], { type: 'audio/mpeg' });
    const directDataUrl = await blobToDataUrl(mp3Blob);
    if (directDataUrl.length <= MAX_RAW_BASE64_LENGTH) {
      const durationMs = await measureAudioDuration(directDataUrl);
      return {
        audioDataUrl: directDataUrl,
        mimeType: 'audio/mpeg',
        fileName: fileName.slice(0, 150),
        fileSize: mp3Blob.size,
        durationMs,
      };
    }
  }

  try {
    const arrayBuffer = await blob.arrayBuffer();
    return await transcodeToCompactWav(arrayBuffer, fileName);
  } catch {
    const directDataUrl = await blobToDataUrl(blob);
    if (directDataUrl.length > MAX_RAW_BASE64_LENGTH) {
      throw new Error(
        'Audio file is too large for Cloud Sync. Please upload a shorter clip (under 10 seconds).'
      );
    }
    const durationMs = await measureAudioDuration(directDataUrl);
    return {
      audioDataUrl: directDataUrl,
      mimeType: blob.type || 'audio/mpeg',
      fileName: fileName.slice(0, 150),
      fileSize: blob.size,
      durationMs,
    };
  }
}

export function measureAudioDuration(srcUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const timeout = window.setTimeout(() => resolve(1400), 2500);
    audio.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        resolve(Math.min(120000, Math.round(audio.duration * 1000)));
      } else {
        resolve(1400);
      }
    };
    audio.onerror = () => {
      window.clearTimeout(timeout);
      resolve(1400);
    };
    audio.src = srcUrl;
  });
}

/**
 * Detects legacy synthetic sine-wave placeholders so they are ignored and never override real audio.
 */
export function isSyntheticRestoredPlaceholder(
  word: string,
  audioDataUrl?: string | null
): boolean {
  if (!audioDataUrl || !audioDataUrl.startsWith('data:audio/wav')) {
    return false;
  }
  const durationSec = Math.min(2.2, Math.max(0.9, word.length * 0.11));
  const expectedSamples = Math.floor(16000 * durationSec);
  const expectedByteSize = 44 + expectedSamples * 2;
  const base64Part = audioDataUrl.split(',')[1] || '';
  const approxByteSize = Math.floor((base64Part.length * 3) / 4);
  return Math.abs(approxByteSize - expectedByteSize) <= 12;
}

/**
 * Fetches a real bundled or dictionary MP3 file from /public/ and packages it as a ProcessedAudio
 * object suitable for saving to Firebase Cloud and local IndexedDB.
 */
export async function loadRealAudioFileAsProcessed(
  word: string,
  audioFileUrl: string
): Promise<ProcessedAudio> {
  const response = await fetch(audioFileUrl);
  if (!response.ok) {
    throw new Error(`Could not load audio file: ${audioFileUrl}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const isOgg = audioFileUrl.toLowerCase().endsWith('.ogg');
  const mimeType = isOgg ? 'audio/ogg' : 'audio/mpeg';
  const blob = new Blob([arrayBuffer], { type: mimeType });
  const audioDataUrl = await blobToDataUrl(blob);
  const durationMs = await measureAudioDuration(audioFileUrl);
  const ext = isOgg ? 'ogg' : 'mp3';

  return {
    audioDataUrl,
    mimeType,
    fileName: `${toWordId(word)}.${ext}`,
    fileSize: blob.size,
    durationMs,
  };
}

/**
 * Fast lookup index for words in WORDS_CATALOG by lowercase word and by slug id.
 */
const wordLookupMap = new Map<
  string,
  (typeof WORDS_CATALOG)[number]
>();
for (const item of WORDS_CATALOG) {
  wordLookupMap.set(item.word.toLowerCase().trim(), item);
  wordLookupMap.set(item.id.toLowerCase().trim(), item);
}

/**
 * Singleton HTMLAudioElement + Blob URL cache for reliable playback on Android, iOS & Desktop.
 */
let sharedAudioElement: HTMLAudioElement | null = null;
let currentBlobUrl: string | null = null;

function getSharedAudioElement(): HTMLAudioElement {
  if (!sharedAudioElement) {
    sharedAudioElement = new Audio();
    sharedAudioElement.preload = 'auto';
  }
  return sharedAudioElement;
}

async function playUrlWithSharedAudio(
  url: string,
  playbackRate: number
): Promise<boolean> {
  try {
    const audioEl = getSharedAudioElement();
    audioEl.pause();
    audioEl.src = url;
    audioEl.playbackRate = playbackRate;
    audioEl.currentTime = 0;
    await audioEl.play();
    return true;
  } catch (err) {
    console.warn(`Audio playback failed for ${url}:`, err);
    return false;
  }
}

/**
 * Plays pronunciation for a word across Desktop and Mobile (Android/iOS):
 * 1. Priority 1 (User Cloud/Local Upload): Real user-uploaded or mic-recorded audioDataUrl.
 * 2. Priority 2 (Original Bundled Audio): The 782 original /audio-w*.mp3 & /audio-w2.ogg files from Google Drive.
 * 3. Priority 3 (Real Dictionary MP3 Fallback): /dict-fallback/audio-w*.mp3 or /audio-w555.mp3 / /audio-w560.mp3.
 * 4. Priority 4 (Browser British English TTS): Only if no recorded audio file exists at all.
 */
export async function playWordAudio(options: {
  word: string;
  audioDataUrl?: string | null;
  bundledAudioFile?: string | null;
  playbackRate?: number;
}): Promise<void> {
  const { word, audioDataUrl, bundledAudioFile, playbackRate = 1.0 } = options;

  const audioEl = getSharedAudioElement();
  audioEl.pause();
  if ('speechSynthesis' in window) {
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
      window.speechSynthesis.cancel();
    }
  }

  // 1. Real user-uploaded / recorded audio (ignoring any legacy synthetic sine-wave data)
  const isRealCustomAudio =
    Boolean(audioDataUrl) &&
    audioDataUrl!.startsWith('data:') &&
    !isSyntheticRestoredPlaceholder(word, audioDataUrl);

  if (isRealCustomAudio && audioDataUrl) {
    try {
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
      }
      const blob = dataUrlToBlob(audioDataUrl);
      currentBlobUrl = URL.createObjectURL(blob);
      audioEl.src = currentBlobUrl;
      audioEl.playbackRate = playbackRate;
      audioEl.currentTime = 0;
      await audioEl.play();
      return;
    } catch (err) {
      console.warn('Blob audio playback failed, trying direct Data URL:', err);
      const playedDirect = await playUrlWithSharedAudio(
        audioDataUrl,
        playbackRate
      );
      if (playedDirect) return;
    }
  }

  // 2. Original Bundled MP3/OGG from Google Drive (782 words)
  const catalogEntry =
    wordLookupMap.get(word.toLowerCase().trim()) ||
    wordLookupMap.get(toWordId(word));

  const bundledUrl = bundledAudioFile || catalogEntry?.bundledAudioFile;
  if (bundledUrl) {
    const playedBundled = await playUrlWithSharedAudio(
      bundledUrl,
      playbackRate
    );
    if (playedBundled) return;
  }

  // 3. Real Google Dictionary MP3 Fallback for Missing words
  const dictToken = word
    .toLowerCase()
    .replace(/\s*\/\s*.*/, '')
    .trim()
    .replace(/\s+/g, '_');
  if (/^[a-z_]+$/.test(dictToken)) {
    const gbUrl = `https://ssl.gstatic.com/dictionary/static/sounds/20200429/${dictToken}--_gb_1.mp3`;
    if (await playUrlWithSharedAudio(gbUrl, playbackRate)) return;
    const usUrl = `https://ssl.gstatic.com/dictionary/static/sounds/20200429/${dictToken}--_us_1.mp3`;
    if (await playUrlWithSharedAudio(usUrl, playbackRate)) return;
  }

  // 4. Last-resort British English Web Speech API
  if ('speechSynthesis' in window) {
    try {
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = 'en-GB';
      utterance.rate = Math.max(0.5, Math.min(1.5, playbackRate * 0.9));
      utterance.pitch = 1.0;

      const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
      if (!isMobile) {
        const voices = window.speechSynthesis.getVoices();
        const preferredVoice =
          voices.find(
            (v) =>
              v.lang.replace('_', '-').toLowerCase() === 'en-gb' &&
              v.localService
          ) ||
          voices.find(
            (v) => v.lang.replace('_', '-').toLowerCase() === 'en-gb'
          ) ||
          voices.find((v) => v.lang.toLowerCase().startsWith('en'));
        if (preferredVoice) {
          utterance.voice = preferredVoice;
        }
      }

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.warn('speechSynthesis error:', err);
    }
  }
}

/**
 * Local IndexedDB cache so recordings work offline and load instantaneously.
 */
const DB_NAME = 'listen_write_cloud_cache_v1';
const STORE_NAME = 'recordings';

function openLocalCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'wordId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface CachedRecordingItem {
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
  updatedAtMs: number;
  syncedToCloud: boolean;
  isPersonalOverride?: boolean;
  contributedToAdmin?: boolean;
}

export async function saveRecordingToLocalCache(
  item: CachedRecordingItem
): Promise<void> {
  try {
    const db = await openLocalCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('IndexedDB cache write skipped:', err);
  }
}

export async function removeRecordingFromLocalCache(
  wordId: string
): Promise<void> {
  try {
    const db = await openLocalCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(wordId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('IndexedDB cache delete skipped:', err);
  }
}

export async function getAllLocalCachedRecordings(): Promise<
  Record<string, CachedRecordingItem>
> {
  try {
    const db = await openLocalCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const map: Record<string, CachedRecordingItem> = {};
        for (const item of req.result as CachedRecordingItem[]) {
          if (isSyntheticRestoredPlaceholder(item.word, item.audioDataUrl)) {
            void removeRecordingFromLocalCache(item.wordId);
            continue;
          }
          map[item.wordId] = item;
        }
        resolve(map);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return {};
  }
}
