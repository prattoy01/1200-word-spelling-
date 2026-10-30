/**
 * Mobile & Cross-Browser Audio Engine for Listen & Write.
 * - Plays the 782 original bundled MP3/OGG recordings from the user's Google Drive (/audio-w1.mp3 .. /audio-w926.mp3).
 * - Plays real user-uploaded / microphone-recorded audio synced via Firebase Cloud.
 * - Plays real Google Dictionary MP3 fallbacks (/dict-fallback/audio-w*.mp3) for unrecorded words.
 * - Transcodes microphone recordings and uploads into universal 16-bit PCM WAV or preserves MP3
 *   so recordings made on PC Web play on iPhone/Android and vice versa.
 */

import { WORDS_CATALOG, toWordId, type WordItem } from '../data/words';
import { SCREENSHOT_14_REAL_AUDIO } from '../data/screenshot14Audio';

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
 * Ensures an audioDataUrl sent over the real-time inline relay fits in <= 10 inline chunks
 * (3,500 chars each, < 4KB per message) so it never triggers public relay file-attachment rate limits.
 * Standard MP3s (< 24 KB, e.g. 7 KB word clips) are returned 100% untouched.
 */
export async function compactAudioDataUrlForRelay(
  audioDataUrl: string
): Promise<string> {
  if (!audioDataUrl || audioDataUrl.length <= 32000) {
    return audioDataUrl;
  }
  if (typeof window === 'undefined') {
    return audioDataUrl;
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return audioDataUrl;

  const audioCtx = new AudioCtx();
  try {
    const blob = dataUrlToBlob(audioDataUrl);
    const arrayBuffer = await blob.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const maxSec = Math.min(decoded.duration, 3.0);
    const rate = 8000;
    const len = Math.max(1, Math.floor(maxSec * rate));
    const offlineCtx = new OfflineAudioContext(1, len, rate);
    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
    const channelData = rendered.getChannelData(0);
    const wavBlob = encodeMonoWav(channelData, rate, 8);
    return await blobToDataUrl(wavBlob);
  } catch {
    return audioDataUrl;
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

export const OFFLINE_ORIGINAL_AUDIO_CACHE_NAME = 'lw-offline-original-audio-v1';
const attemptedOriginalSaveWordIds = new Set<string>();


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
 * Embedded real human pronunciation MP3s from SCREENSHOT_14_REAL_AUDIO (always available offline).
 */
const embeddedOriginalAudioMap = new Map<string, string>();
for (const entry of SCREENSHOT_14_REAL_AUDIO) {
  const wid = toWordId(entry.word);
  embeddedOriginalAudioMap.set(wid, entry.audioDataUrl);
  embeddedOriginalAudioMap.set(entry.word.toLowerCase().trim(), entry.audioDataUrl);
}

/**
 * Resolves the primary original audio URLs for any word in the catalog.
 */
export function getCandidateOriginalAudioUrls(
  word: string,
  bundledAudioFile?: string | null
): string[] {
  const urls: string[] = [];
  const norm = word.toLowerCase().trim();
  const catalogEntry =
    wordLookupMap.get(norm) ||
    wordLookupMap.get(toWordId(word)) ||
    WORDS_CATALOG.find((w) => w.word.toLowerCase().trim() === norm);
  const primaryBundled = bundledAudioFile || catalogEntry?.bundledAudioFile;

  if (primaryBundled) {
    urls.push(primaryBundled);
  }

  const dictToken = word
    .toLowerCase()
    .replace(/\s*\/\s*.*/, '')
    .trim()
    .replace(/\s+/g, '_');
  if (/^[a-z_]+$/.test(dictToken)) {
    const gbUrl = `https://ssl.gstatic.com/dictionary/static/sounds/20200429/${dictToken}--_gb_1.mp3`;
    const usUrl = `https://ssl.gstatic.com/dictionary/static/sounds/20200429/${dictToken}--_us_1.mp3`;
    if (!urls.includes(gbUrl)) urls.push(gbUrl);
    if (!urls.includes(usUrl)) urls.push(usUrl);
  }

  return urls;
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

async function playBlobOrDataUrlWithSharedAudio(
  audioDataUrlOrBlob: string | Blob,
  playbackRate: number
): Promise<boolean> {
  try {
    const audioEl = getSharedAudioElement();
    audioEl.pause();
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
    const blob =
      typeof audioDataUrlOrBlob === 'string'
        ? dataUrlToBlob(audioDataUrlOrBlob)
        : audioDataUrlOrBlob;
    currentBlobUrl = URL.createObjectURL(blob);
    audioEl.src = currentBlobUrl;
    audioEl.playbackRate = playbackRate;
    audioEl.currentTime = 0;
    await audioEl.play();
    return true;
  } catch (err) {
    if (typeof audioDataUrlOrBlob === 'string') {
      return playUrlWithSharedAudio(audioDataUrlOrBlob, playbackRate);
    }
    console.warn('Blob audio playback failed:', err);
    return false;
  }
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
 * Local IndexedDB cache so both custom recordings AND original spelling recordings
 * work 100% offline and load instantaneously from the local system.
 */
const DB_NAME = 'listen_write_cloud_cache_v1';
const DB_VERSION = 2;
const STORE_NAME = 'recordings';
const ORIGINAL_AUDIO_STORE = 'original_audio_v1';

export interface LocalOriginalAudioItem {
  wordId: string;
  word: string;
  audioDataUrl?: string;
  sourceUrl: string;
  savedAtMs: number;
}

// In-memory index of wordIds whose original spelling audio is confirmed saved on the local system
const locallySavedOriginalWordIds = new Set<string>(
  Array.from(embeddedOriginalAudioMap.keys())
);
let localOriginalIndexLoaded = false;

function openLocalCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'wordId' });
      }
      if (!db.objectStoreNames.contains(ORIGINAL_AUDIO_STORE)) {
        db.createObjectStore(ORIGINAL_AUDIO_STORE, { keyPath: 'wordId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getLocalOriginalAudioItem(
  wordId: string
): Promise<LocalOriginalAudioItem | null> {
  try {
    const db = await openLocalCacheDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(ORIGINAL_AUDIO_STORE, 'readonly');
      const req = tx.objectStore(ORIGINAL_AUDIO_STORE).get(wordId);
      req.onsuccess = () =>
        resolve((req.result as LocalOriginalAudioItem) || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function putLocalOriginalAudioItem(
  item: LocalOriginalAudioItem
): Promise<void> {
  try {
    locallySavedOriginalWordIds.add(item.wordId);
    const db = await openLocalCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ORIGINAL_AUDIO_STORE, 'readwrite');
      tx.objectStore(ORIGINAL_AUDIO_STORE).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore storage quota warning
  }
}

/**
 * Loads the set of wordIds saved in the local system's `original_audio_v1` IndexedDB store.
 */
export async function refreshOfflineOriginalAudioIndex(): Promise<Set<string>> {
  try {
    const db = await openLocalCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(ORIGINAL_AUDIO_STORE, 'readonly');
      const req = tx.objectStore(ORIGINAL_AUDIO_STORE).getAllKeys();
      req.onsuccess = () => {
        const keys = (req.result || []) as string[];
        for (const k of keys) {
          locallySavedOriginalWordIds.add(String(k));
        }
        localOriginalIndexLoaded = true;
        resolve();
      };
      req.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
  return locallySavedOriginalWordIds;
}

export function isWordOriginalAudioSavedLocally(wordOrId: string): boolean {
  const wid = toWordId(wordOrId);
  return (
    locallySavedOriginalWordIds.has(wid) ||
    locallySavedOriginalWordIds.has(wordOrId.toLowerCase().trim()) ||
    embeddedOriginalAudioMap.has(wid)
  );
}

export async function getLocalOfflineAudioCount(): Promise<number> {
  if (!localOriginalIndexLoaded) {
    await refreshOfflineOriginalAudioIndex();
  }
  const catalogWordIds = new Set(WORDS_CATALOG.map((w) => w.id));
  let count = 0;
  for (const wid of catalogWordIds) {
    if (
      locallySavedOriginalWordIds.has(wid) ||
      embeddedOriginalAudioMap.has(wid)
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Downloads and saves a word's original spelling recording to the local system:
 * 1. If CORS fetch succeeds (e.g. Wikimedia OGG/MP3 or same-origin audio), converts to base64 DataURL and saves directly in IndexedDB (`original_audio_v1`) + CacheStorage.
 * 2. If cross-origin opaque response (e.g. `ssl.gstatic.com`), caches the binary audio response in `CacheStorage` (`lw-offline-original-audio-v1`) AND records the cached URL in IndexedDB (`original_audio_v1`) so the Service Worker & browser cache serve it offline.
 */
export async function saveOriginalWordAudioLocally(
  word: string,
  bundledAudioFile?: string | null
): Promise<boolean> {
  const wordId = toWordId(word);
  if (embeddedOriginalAudioMap.has(wordId)) {
    locallySavedOriginalWordIds.add(wordId);
    return true;
  }

  const existingItem = await getLocalOriginalAudioItem(wordId);
  if (existingItem?.audioDataUrl || existingItem?.sourceUrl) {
    locallySavedOriginalWordIds.add(wordId);
    return true;
  }

  if (attemptedOriginalSaveWordIds.has(wordId)) {
    return false;
  }
  attemptedOriginalSaveWordIds.add(wordId);

  const candidateUrls = getCandidateOriginalAudioUrls(word, bundledAudioFile);
  if (candidateUrls.length === 0) return false;

  for (const url of candidateUrls) {
    if (!url) continue;

    // 1. Try CORS fetch first so we can store full base64 audioDataUrl directly inside IndexedDB
    try {
      const corsResp = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (corsResp.ok) {
        const blob = await corsResp.blob();
        if (blob.size > 200) {
          const dataUrl = await blobToDataUrl(blob);
          await putLocalOriginalAudioItem({
            wordId,
            word,
            audioDataUrl: dataUrl,
            sourceUrl: url,
            savedAtMs: Date.now(),
          });
          if (typeof caches !== 'undefined') {
            const cache = await caches.open(OFFLINE_ORIGINAL_AUDIO_CACHE_NAME);
            await cache.put(url, new Response(blob, { status: 200 }));
          }
          return true;
        }
      }
    } catch {
      // Fall through to CacheStorage no-cors fetch
    }

    // 2. Fallback: CacheStorage + Service Worker no-cors fetch (for ssl.gstatic.com)
    try {
      if (typeof caches !== 'undefined') {
        const cache = await caches.open(OFFLINE_ORIGINAL_AUDIO_CACHE_NAME);
        let cachedResp = await cache.match(url, { ignoreVary: true });
        if (!cachedResp) {
          const noCorsResp = await fetch(url, {
            mode: 'no-cors',
            credentials: 'omit',
          });
          if (
            noCorsResp &&
            (noCorsResp.status === 200 || noCorsResp.status === 0)
          ) {
            await cache.put(url, noCorsResp.clone());
            cachedResp = noCorsResp;
          }
        }
        if (cachedResp) {
          await putLocalOriginalAudioItem({
            wordId,
            word,
            sourceUrl: url,
            savedAtMs: Date.now(),
          });
          return true;
        }
      }
    } catch {
      // Try next candidate URL
    }
  }

  return false;
}

/**
 * Batch-preloads and saves original spelling recordings to the local system for offline playback.
 */
export async function preloadOriginalAudioForWords(
  words: WordItem[],
  onProgress?: (savedCount: number, totalCount: number) => void
): Promise<number> {
  if (!localOriginalIndexLoaded) {
    await refreshOfflineOriginalAudioIndex();
  }
  const total = words.length;
  let savedCount = 0;

  const concurrency = 6;
  let index = 0;

  const worker = async () => {
    while (index < words.length) {
      const currentIdx = index++;
      const item = words[currentIdx];
      if (!item) continue;

      if (isWordOriginalAudioSavedLocally(item.id)) {
        savedCount++;
        onProgress?.(savedCount, total);
        continue;
      }

      const ok = await saveOriginalWordAudioLocally(
        item.word,
        item.bundledAudioFile
      );
      if (ok) {
        savedCount++;
      }
      onProgress?.(savedCount, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, words.length) }, () => worker())
  );

  return savedCount;
}

/**
 * Plays pronunciation for a word across Desktop and Mobile (Android/iOS), both Online and Offline:
 * 1. Priority 1 (User Cloud/Local Upload): Real user-uploaded or mic-recorded audioDataUrl.
 * 2. Priority 2 (Local System Saved Original Recording): Embedded MP3 or IndexedDB/CacheStorage saved original recording (works 100% offline!).
 * 3. Priority 3 (Original Bundled Audio & Dictionary MP3): Plays and automatically saves to the local system for offline use.
 * 4. Priority 4 (Browser British English TTS): Only if no recorded audio file exists at all.
 */
export async function playWordAudio(options: {
  word: string;
  audioDataUrl?: string | null;
  bundledAudioFile?: string | null;
  playbackRate?: number;
}): Promise<void> {
  const { word, audioDataUrl, bundledAudioFile, playbackRate = 1.0 } = options;
  const wordId = toWordId(word);

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
    const playedCustom = await playBlobOrDataUrlWithSharedAudio(
      audioDataUrl,
      playbackRate
    );
    if (playedCustom) return;
  }

  // 2. Check Embedded 14 Real MP3 Recordings (100% offline)
  const normWord = word.toLowerCase().trim();
  const catalogMatch =
    wordLookupMap.get(normWord) ||
    wordLookupMap.get(wordId) ||
    WORDS_CATALOG.find((w) => w.word.toLowerCase().trim() === normWord);
  const canonicalId = catalogMatch?.id || wordId;

  const embeddedDataUrl =
    embeddedOriginalAudioMap.get(canonicalId) ||
    embeddedOriginalAudioMap.get(wordId) ||
    embeddedOriginalAudioMap.get(normWord);
  if (embeddedDataUrl) {
    const playedEmbedded = await playBlobOrDataUrlWithSharedAudio(
      embeddedDataUrl,
      playbackRate
    );
    if (playedEmbedded) return;
  }

  // 3. Check Local System IndexedDB `original_audio_v1` Store (100% offline)
  const localOriginal =
    (await getLocalOriginalAudioItem(canonicalId)) ||
    (canonicalId !== wordId ? await getLocalOriginalAudioItem(wordId) : null);
  if (localOriginal?.audioDataUrl) {
    const playedLocalIdb = await playBlobOrDataUrlWithSharedAudio(
      localOriginal.audioDataUrl,
      playbackRate
    );
    if (playedLocalIdb) return;
  }

  // 4. Play from Local CacheStorage / Bundled Original Audio URLs & Save Locally for Offline
  const candidateUrls = getCandidateOriginalAudioUrls(word, bundledAudioFile);
  if (
    localOriginal?.sourceUrl &&
    !candidateUrls.includes(localOriginal.sourceUrl)
  ) {
    candidateUrls.unshift(localOriginal.sourceUrl);
  }

  for (const url of candidateUrls) {
    if (!url) continue;

    // If stored in CacheStorage as a readable status-200 response, play directly from Blob (works offline even without SW)
    if (typeof caches !== 'undefined') {
      try {
        const cache = await caches.open(OFFLINE_ORIGINAL_AUDIO_CACHE_NAME);
        const cachedResp = await cache.match(url, { ignoreVary: true });
        if (cachedResp && cachedResp.status === 200) {
          const blob = await cachedResp.blob();
          if (blob.size > 200) {
            const playedBlob = await playBlobOrDataUrlWithSharedAudio(
              blob,
              playbackRate
            );
            if (playedBlob) return;
          }
        }
      } catch {
        // Continue to standard audio element playback
      }
    }

    const isFileProtocol =
      typeof window !== 'undefined' && window.location?.protocol === 'file:';
    if (isFileProtocol && url.startsWith('/')) {
      continue;
    }

    const playedUrl = await playUrlWithSharedAudio(url, playbackRate);
    if (playedUrl) {
      // Save this original spelling recording to the local system in the background so it works offline next time!
      void saveOriginalWordAudioLocally(word, url);
      return;
    }
  }

  // 5. Native Android APK TTS Bridge (if running inside our native Android APK and no recording exists)
  const androidBridge = (
    window as unknown as {
      AndroidNative?: { speak?: (text: string, rate: number) => void };
    }
  ).AndroidNative;
  if (androidBridge && typeof androidBridge.speak === 'function') {
    try {
      androidBridge.speak(word, playbackRate);
      return;
    } catch (err) {
      console.warn('AndroidNative TTS bridge error:', err);
    }
  }

  // 6. Last-resort British English Web Speech API
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

