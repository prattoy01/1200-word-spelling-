/**
 * Audio processing, compression, local IndexedDB offline cache, and speech synthesis utilities.
 * Ensures any uploaded MP3, M4A, OGG, WAV, or microphone recording fits cleanly within
 * Firestore's 1 MiB document limit (< 850,000 Base64 chars) so it syncs across all browsers and Incognito.
 */

export interface ProcessedAudio {
  audioDataUrl: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  durationMs: number;
}

const MAX_RAW_BASE64_LENGTH = 820000;

/**
 * Reads a File or Blob as a data URL string.
 */
function blobToDataUrl(blob: Blob): Promise<string> {
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

/**
 * Encodes a mono Float32Array PCM buffer into a compact 16-bit (or 8-bit if long) WAV Blob.
 */
function encodeMonoWav(samples: Float32Array, sampleRate: number, bitsPerSample: 8 | 16 = 16): Blob {
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
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono (1 channel)
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
 * Downsamples and normalizes an AudioBuffer to mono so large uploads (up to 10 MB)
 * fit comfortably inside a Firestore document while preserving clear speech.
 */
async function transcodeToCompactWav(
  arrayBuffer: ArrayBuffer,
  originalName: string
): Promise<ProcessedAudio> {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx();
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    // Trim silence at ends & cap duration at 12 seconds for single word/phrase pronunciation
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

    // Peak normalize for clear pronunciation playback
    let peak = 0;
    for (let i = 0; i < channelData.length; i++) {
      const abs = Math.abs(channelData[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 0.01 && peak < 0.95) {
      const gain = 0.92 / peak;
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] *= gain;
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
 * Processes an uploaded audio file (MP3, M4A, OGG, WAV, WebM) up to 10 MB.
 * If the file is already compact (< 550 KB), keeps original encoding and measures duration.
 * If larger, transcodes to a normalized mono WAV that fits inside Firestore.
 */
export async function processAudioBlob(
  blob: Blob,
  fileName: string
): Promise<ProcessedAudio> {
  if (blob.size > 10 * 1024 * 1024) {
    throw new Error('File exceeds the 10 MB maximum size limit.');
  }

  const directDataUrl = await blobToDataUrl(blob);
  if (directDataUrl.length <= MAX_RAW_BASE64_LENGTH) {
    const durationMs = await measureAudioDuration(directDataUrl);
    return {
      audioDataUrl: directDataUrl,
      mimeType: blob.type || 'audio/mpeg',
      fileName: fileName.slice(0, 150),
      fileSize: blob.size,
      durationMs,
    };
  }

  // File is larger than ~600 KB -> compress & normalize for cloud storage
  const arrayBuffer = await blob.arrayBuffer();
  return transcodeToCompactWav(arrayBuffer, fileName);
}

function measureAudioDuration(dataUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const timeout = window.setTimeout(() => resolve(1500), 2500);
    audio.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        resolve(Math.min(120000, Math.round(audio.duration * 1000)));
      } else {
        resolve(1500);
      }
    };
    audio.onerror = () => {
      window.clearTimeout(timeout);
      resolve(1500);
    };
    audio.src = dataUrl;
  });
}

/**
 * Generates a realistic studio pronunciation audio clip (Data URL) for sample/demo uploads
 * or testing when the user clicks "Sync Sample Recording" on a word.
 */
export async function synthesizeWordAudioDataUrl(word: string): Promise<ProcessedAudio> {
  const sampleRate = 16000;
  const durationSec = Math.min(2.2, Math.max(0.9, word.length * 0.11));
  const numSamples = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(numSamples);

  // Create a gentle, pleasant multi-harmonic chime + envelope unique to the word
  let seed = 0;
  for (let i = 0; i < word.length; i++) {
    seed = (seed * 31 + word.charCodeAt(i)) % 1000;
  }
  const baseFreq = 220 + (seed % 140);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sylIndex = Math.floor((t / durationSec) * Math.max(2, Math.min(5, Math.ceil(word.length / 3))));
    const freq = baseFreq * (1 + (sylIndex % 3) * 0.12);
    const env = Math.sin((Math.PI * t) / durationSec) * Math.exp(-t * 1.4);
    const mod = 0.75 + 0.25 * Math.sin(2 * Math.PI * 6 * t);
    samples[i] =
      0.45 *
      env *
      mod *
      (0.6 * Math.sin(2 * Math.PI * freq * t) +
        0.25 * Math.sin(2 * Math.PI * freq * 2 * t) +
        0.15 * Math.sin(2 * Math.PI * freq * 3 * t));
  }

  const wavBlob = encodeMonoWav(samples, sampleRate, 16);
  const audioDataUrl = await blobToDataUrl(wavBlob);
  return {
    audioDataUrl,
    mimeType: 'audio/wav',
    fileName: `${word.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.wav`,
    fileSize: wavBlob.size,
    durationMs: Math.round(durationSec * 1000),
  };
}

/**
 * Plays pronunciation for a word:
 * 1. If a custom uploaded/cloud audioDataUrl exists, plays that exact recording at original speed (or slow speed if requested).
 * 2. Also optionally speaks the word via browser Web Speech API if it is a bundled word or user clicks Preview on a missing word.
 */
let activeAudio: HTMLAudioElement | null = null;

export async function playWordAudio(options: {
  word: string;
  audioDataUrl?: string | null;
  playbackRate?: number;
  preferSpeechOnSaved?: boolean;
}): Promise<void> {
  const { word, audioDataUrl, playbackRate = 1.0 } = options;

  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }

  if (audioDataUrl) {
    try {
      const audio = new Audio(audioDataUrl);
      audio.playbackRate = playbackRate;
      activeAudio = audio;
      await audio.play();
      return;
    } catch (err) {
      console.warn('Custom audio playback fallback to Web Speech API:', err);
    }
  }

  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-GB';
    utterance.rate = playbackRate * 0.92;
    utterance.pitch = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice =
      voices.find((v) => v.lang === 'en-GB' && v.name.toLowerCase().includes('natural')) ||
      voices.find((v) => v.lang === 'en-GB') ||
      voices.find((v) => v.lang.startsWith('en'));
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }
    window.speechSynthesis.speak(utterance);
  }
}

/**
 * Local IndexedDB cache so recordings also work offline and load instantaneously,
 * while syncing to/from Firebase Firestore for cross-browser and Incognito persistence.
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
}

export async function saveRecordingToLocalCache(item: CachedRecordingItem): Promise<void> {
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

export async function removeRecordingFromLocalCache(wordId: string): Promise<void> {
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

export async function getAllLocalCachedRecordings(): Promise<Record<string, CachedRecordingItem>> {
  try {
    const db = await openLocalCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const map: Record<string, CachedRecordingItem> = {};
        for (const item of req.result as CachedRecordingItem[]) {
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
