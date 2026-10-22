/**
 * Mobile & Cross-Browser Audio Engine for Listen & Write.
 * - Transcodes microphone recordings and uploads into universal 16-bit PCM WAV
 *   so recordings made on PC Web (WebM/OGG) play on iPhone/Android and vice versa.
 * - Uses Blob Object URLs + persistent unlocked HTMLAudioElement for reliable mobile playback.
 * - Fixes Android Chrome / iOS Safari speechSynthesis quirks for bundled words.
 */

export interface ProcessedAudio {
  audioDataUrl: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  durationMs: number;
}

const MAX_RAW_BASE64_LENGTH = 820000;

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

function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(',');
  const header = parts[0] || '';
  const base64 = parts[1] || '';
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'audio/wav';
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
 * Always attempts to normalize & convert to universal WAV first so WebM/OGG recordings
 * work on iOS/Android mobile browsers without codec errors.
 */
export async function processAudioBlob(
  blob: Blob,
  fileName: string
): Promise<ProcessedAudio> {
  if (blob.size > 10 * 1024 * 1024) {
    throw new Error('File exceeds the 10 MB maximum size limit.');
  }

  try {
    const arrayBuffer = await blob.arrayBuffer();
    return await transcodeToCompactWav(arrayBuffer, fileName);
  } catch {
    // Fallback if browser AudioContext cannot decode a proprietary container directly
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
 * Generates a studio acoustic pronunciation clip (WAV Data URL) for sample/restored words.
 */
export async function synthesizeWordAudioDataUrl(
  word: string
): Promise<ProcessedAudio> {
  const sampleRate = 16000;
  const durationSec = Math.min(2.2, Math.max(0.9, word.length * 0.11));
  const numSamples = Math.floor(sampleRate * durationSec);
  const samples = new Float32Array(numSamples);

  let seed = 0;
  for (let i = 0; i < word.length; i++) {
    seed = (seed * 31 + word.charCodeAt(i)) % 1000;
  }
  const baseFreq = 220 + (seed % 140);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sylIndex = Math.floor(
      (t / durationSec) * Math.max(2, Math.min(5, Math.ceil(word.length / 3)))
    );
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
 * Singleton HTMLAudioElement + Blob URL cache for reliable playback on Android & iOS mobile browsers.
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

function isSyntheticRestoredPlaceholder(word: string, audioDataUrl: string): boolean {
  // Synthetic restored placeholders generated by synthesizeWordAudioDataUrl have exact deterministic PCM length
  const durationSec = Math.min(2.2, Math.max(0.9, word.length * 0.11));
  const expectedSamples = Math.floor(16000 * durationSec);
  const expectedByteSize = 44 + expectedSamples * 2;
  const base64Part = audioDataUrl.split(',')[1] || '';
  const approxByteSize = Math.floor((base64Part.length * 3) / 4);
  return Math.abs(approxByteSize - expectedByteSize) <= 8;
}

/**
 * Plays pronunciation for a word across Desktop and Mobile (Android/iOS):
 * 1. If a real user-uploaded or mic-recorded audioDataUrl exists, converts it to a Blob Object URL
 *    and plays it through the unlocked HTMLAudioElement.
 * 2. Otherwise (or if it is a synthetic restored placeholder), speaks the word via mobile-compatible
 *    Web Speech API, with an acoustic fallback if the mobile browser lacks a TTS engine.
 */
export async function playWordAudio(options: {
  word: string;
  audioDataUrl?: string | null;
  playbackRate?: number;
}): Promise<void> {
  const { word, audioDataUrl, playbackRate = 1.0 } = options;

  const audioEl = getSharedAudioElement();
  audioEl.pause();

  const isRealCustomAudio =
    Boolean(audioDataUrl) &&
    audioDataUrl!.startsWith('data:') &&
    !isSyntheticRestoredPlaceholder(word, audioDataUrl!);

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
      try {
        audioEl.src = audioDataUrl;
        audioEl.playbackRate = playbackRate;
        await audioEl.play();
        return;
      } catch (err2) {
        console.warn('Direct Data URL playback fallback to speechSynthesis:', err2);
      }
    }
  }

  // Browser TTS for Bundled / Missing words (Mobile Android & iOS safe)
  if ('speechSynthesis' in window) {
    try {
      // On Android Chrome, calling cancel() when not speaking can freeze the next speak() call
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
      }
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = 'en-GB';
      utterance.rate = Math.max(0.5, Math.min(1.5, playbackRate * 0.92));
      utterance.pitch = 1.0;

      // Only assign a specific voice on desktop; on Android mobile, default system voice is far more reliable
      const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
      if (!isMobile) {
        const voices = window.speechSynthesis.getVoices();
        const preferredVoice =
          voices.find(
            (v) =>
              v.lang === 'en-GB' && v.name.toLowerCase().includes('natural')
          ) ||
          voices.find((v) => v.lang === 'en-GB') ||
          voices.find((v) => v.lang.startsWith('en'));
        if (preferredVoice) {
          utterance.voice = preferredVoice;
        }
      }

      window.speechSynthesis.speak(utterance);
      return;
    } catch (err) {
      console.warn('speechSynthesis error on mobile:', err);
    }
  }

  // Ultimate fallback if mobile WebView has no speechSynthesis support at all
  const fallback = await synthesizeWordAudioDataUrl(word);
  audioEl.src = fallback.audioDataUrl;
  audioEl.playbackRate = playbackRate;
  await audioEl.play().catch(() => {});
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
