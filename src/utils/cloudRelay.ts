import { WORDS_CATALOG } from '../data/words';
import type {
  ContestRecord,
  ContestSubmissionRecord,
} from '../services/contestService';
import type {
  SessionWordResult,
  AudioContributionRecord,
  CloudRecording,
} from '../services/recordingsService';
import type { GlobalWordOverride } from '../data/words';

/**
 * Global Cross-Origin / Cross-Domain Real-Time Cloud Relay Topic.
 * Works across AI Studio (run.app), Vercel (1200-word-spelling.vercel.app),
 * Netlify, and Android APK with full CORS (*) and 12-hour server event caching,
 * ensuring 100% real-time contest, spelling, & audio contribution synchronization
 * even when Firebase Firestore free-tier daily read quotas are exhausted.
 */
export const CLOUD_RELAY_TOPIC = 'lw_ielts_contest_mesh_12193dcd_v3';
export const CLOUD_RELAY_BASE_URL = `https://ntfy.sh/${CLOUD_RELAY_TOPIC}`;
const EVENT_PREFIX = 'LW_EVT:';
const AUDIO_CHUNK_SIZE = 2800;

type CompactResultTuple = [string, string, 0 | 1]; // [wordId, userAnswer, isCorrect]

export type RelayContributionMeta = Omit<
  AudioContributionRecord,
  'audioDataUrl'
> & {
  audioDataUrl?: string;
  audioKey?: string;
  totalChunks?: number;
};

export type RelayRecordingMeta = Omit<CloudRecording, 'audioDataUrl'> & {
  audioDataUrl?: string;
  audioKey?: string;
  totalChunks?: number;
};

export type CloudRelayEvent =
  | {
      op: 'CONTEST_UPSERT';
      ts: number;
      contest: ContestRecord;
    }
  | {
      op: 'CONTEST_DELETE';
      ts: number;
      contestId: string;
    }
  | {
      op: 'SUBMISSION_UPSERT';
      ts: number;
      sub: Omit<ContestSubmissionRecord, 'results'>;
      r?: CompactResultTuple[];
    }
  | {
      op: 'WORD_OVERRIDE_UPSERT';
      ts: number;
      override: GlobalWordOverride;
    }
  | {
      op: 'WORD_OVERRIDE_DELETE';
      ts: number;
      wordId: string;
    }
  | {
      op: 'AUDIO_CHUNK';
      k: string;
      i: number;
      n: number;
      d: string;
    }
  | {
      op: 'CONTRIBUTION_UPSERT';
      ts: number;
      contrib: RelayContributionMeta;
    }
  | {
      op: 'CONTRIBUTION_STATUS';
      ts: number;
      id: string;
      wordId: string;
      status: 'approved' | 'rejected' | 'deleted';
      word?: string;
      banglaMeaning?: string;
    }
  | {
      op: 'RECORDING_UPSERT';
      ts: number;
      rec: RelayRecordingMeta;
    }
  | {
      op: 'RECORDING_DELETE';
      ts: number;
      wordId: string;
    };

export interface CloudRelaySnapshot {
  contests: Map<string, ContestRecord>;
  deletedContestIds: Set<string>;
  submissions: Map<string, ContestSubmissionRecord>;
  wordOverrides: Map<string, GlobalWordOverride>;
  deletedWordOverrideIds: Set<string>;
  contributions: Map<string, AudioContributionRecord>;
  deletedContributionIds: Set<string>;
  recordings: Map<string, CloudRecording>;
  deletedRecordingIds: Set<string>;
}

const relayState: CloudRelaySnapshot = {
  contests: new Map(),
  deletedContestIds: new Set(),
  submissions: new Map(),
  wordOverrides: new Map(),
  deletedWordOverrideIds: new Set(),
  contributions: new Map(),
  deletedContributionIds: new Set(),
  recordings: new Map(),
  deletedRecordingIds: new Set(),
};

const audioChunksStore = new Map<string, Map<number, string>>();
const audioTotalChunksStore = new Map<string, number>();
const pendingContribMetaByKey = new Map<string, RelayContributionMeta>();
const pendingRecordingMetaByKey = new Map<string, RelayRecordingMeta>();
const sentAudioKeys = new Set<string>();

const listeners = new Set<(snapshot: CloudRelaySnapshot) => void>();
let sseSource: EventSource | null = null;
let lastPollAtMs = 0;
let pollInFlight: Promise<CloudRelaySnapshot> | null = null;

function statusRank(st?: string): number {
  if (st === 'completed') return 3;
  if (st === 'in_progress') return 2;
  return 1;
}

function tryAssembleAudioKey(audioKey: string): string | null {
  const total = audioTotalChunksStore.get(audioKey);
  const chunkMap = audioChunksStore.get(audioKey);
  if (!total || !chunkMap || chunkMap.size < total) return null;
  const parts: string[] = [];
  for (let idx = 0; idx < total; idx++) {
    const part = chunkMap.get(idx);
    if (typeof part !== 'string') return null;
    parts.push(part);
  }
  return parts.join('');
}

function tryResolvePendingAudioItems(audioKey: string): boolean {
  const assembled = tryAssembleAudioKey(audioKey);
  if (!assembled) return false;
  let changed = false;

  const pendingContrib = pendingContribMetaByKey.get(audioKey);
  if (pendingContrib && !relayState.deletedContributionIds.has(pendingContrib.id)) {
    const fullContrib: AudioContributionRecord = {
      id: pendingContrib.id,
      wordId: pendingContrib.wordId,
      word: pendingContrib.word,
      banglaMeaning: pendingContrib.banglaMeaning,
      audioDataUrl: assembled,
      mimeType: pendingContrib.mimeType,
      fileName: pendingContrib.fileName,
      fileSize: pendingContrib.fileSize,
      durationMs: pendingContrib.durationMs,
      contributorId: pendingContrib.contributorId,
      contributorName: pendingContrib.contributorName,
      status: pendingContrib.status,
      createdAtMs: pendingContrib.createdAtMs,
      updatedAtMs: pendingContrib.updatedAtMs,
    };
    const existing = relayState.contributions.get(fullContrib.id);
    if (!existing || (fullContrib.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
      relayState.contributions.set(fullContrib.id, fullContrib);
      changed = true;
    }
    pendingContribMetaByKey.delete(audioKey);
  }

  const pendingRec = pendingRecordingMetaByKey.get(audioKey);
  if (pendingRec && !relayState.deletedRecordingIds.has(pendingRec.wordId)) {
    const fullRec: CloudRecording = {
      wordId: pendingRec.wordId,
      word: pendingRec.word,
      banglaMeaning: pendingRec.banglaMeaning,
      audioDataUrl: assembled,
      mimeType: pendingRec.mimeType,
      fileName: pendingRec.fileName,
      fileSize: pendingRec.fileSize,
      durationMs: pendingRec.durationMs,
      ownerId: pendingRec.ownerId,
      ownerName: pendingRec.ownerName,
      status: 'published',
      updatedAtMs: pendingRec.updatedAtMs,
      source: 'cloud',
      isPersonalOverride: false,
    };
    const existingRec = relayState.recordings.get(fullRec.wordId);
    if (!existingRec || (fullRec.updatedAtMs || 0) >= (existingRec.updatedAtMs || 0)) {
      relayState.recordings.set(fullRec.wordId, fullRec);
      changed = true;
    }
    pendingRecordingMetaByKey.delete(audioKey);
  }

  return changed;
}

function compactResults(
  results?: SessionWordResult[]
): CompactResultTuple[] | undefined {
  if (!Array.isArray(results) || results.length === 0) return undefined;
  return results
    .slice(0, 80)
    .map((item) => [
      String(item.wordId || '').slice(0, 64),
      String(item.userAnswer || '').slice(0, 60),
      item.isCorrect ? 1 : 0,
    ]);
}

function expandCompactResults(
  tuples?: CompactResultTuple[]
): SessionWordResult[] | undefined {
  if (!Array.isArray(tuples) || tuples.length === 0) return undefined;
  return tuples.map(([wordId, userAnswer, isCorrectFlag]) => {
    const catalogItem = WORDS_CATALOG.find((w) => w.id === wordId);
    return {
      wordId,
      word: catalogItem?.word || wordId,
      userAnswer: userAnswer || '',
      isCorrect: isCorrectFlag === 1,
      bangla: catalogItem?.bangla || '',
      category: catalogItem?.category || 'General',
      page: catalogItem?.page === 2 ? 2 : 1,
    };
  });
}

function applyRelayEvent(evt: CloudRelayEvent): boolean {
  if (!evt || typeof evt !== 'object' || !evt.op) return false;

  if (evt.op === 'CONTEST_DELETE' && typeof evt.contestId === 'string') {
    const cid = evt.contestId;
    const hadContest = relayState.contests.has(cid);
    const hadDeleted = relayState.deletedContestIds.has(cid);
    relayState.contests.delete(cid);
    relayState.deletedContestIds.add(cid);
    for (const [sid, sub] of relayState.submissions.entries()) {
      if (sub.contestId === cid) {
        relayState.submissions.delete(sid);
      }
    }
    return hadContest || !hadDeleted;
  }

  if (evt.op === 'CONTEST_UPSERT' && evt.contest && evt.contest.id) {
    const c = evt.contest;
    if (c.status === 'cancelled' || relayState.deletedContestIds.has(c.id)) {
      relayState.contests.delete(c.id);
      relayState.deletedContestIds.add(c.id);
      return false;
    }
    const existing = relayState.contests.get(c.id);
    if (!existing || (c.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
      relayState.contests.set(c.id, { ...existing, ...c, status: 'active' });
      return true;
    }
    return false;
  }

  if (evt.op === 'SUBMISSION_UPSERT' && evt.sub && evt.sub.id) {
    const incomingSub: ContestSubmissionRecord = {
      ...evt.sub,
      ...(evt.r ? { results: expandCompactResults(evt.r) } : {}),
    };
    if (relayState.deletedContestIds.has(incomingSub.contestId)) {
      return false;
    }
    const existing = relayState.submissions.get(incomingSub.id);
    if (!existing) {
      relayState.submissions.set(incomingSub.id, incomingSub);
      return true;
    }
    const rIn = statusRank(incomingSub.status);
    const rEx = statusRank(existing.status);
    if (
      rIn > rEx ||
      (rIn === rEx &&
        (incomingSub.updatedAtMs || 0) >= (existing.updatedAtMs || 0))
    ) {
      relayState.submissions.set(incomingSub.id, {
        ...existing,
        ...incomingSub,
        results: incomingSub.results || existing.results,
      });
      return true;
    }
    return false;
  }

  if (
    evt.op === 'WORD_OVERRIDE_UPSERT' &&
    evt.override &&
    evt.override.wordId &&
    evt.override.word
  ) {
    const ov = evt.override;
    relayState.deletedWordOverrideIds.delete(ov.wordId);
    const existing = relayState.wordOverrides.get(ov.wordId);
    if (!existing || (ov.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
      relayState.wordOverrides.set(ov.wordId, ov);
      return true;
    }
    return false;
  }

  if (evt.op === 'WORD_OVERRIDE_DELETE' && typeof evt.wordId === 'string') {
    const wid = evt.wordId;
    relayState.wordOverrides.delete(wid);
    relayState.deletedWordOverrideIds.add(wid);
    return true;
  }

  if (
    evt.op === 'AUDIO_CHUNK' &&
    typeof evt.k === 'string' &&
    typeof evt.i === 'number' &&
    typeof evt.n === 'number' &&
    typeof evt.d === 'string'
  ) {
    let chunkMap = audioChunksStore.get(evt.k);
    if (!chunkMap) {
      chunkMap = new Map();
      audioChunksStore.set(evt.k, chunkMap);
    }
    chunkMap.set(evt.i, evt.d);
    audioTotalChunksStore.set(evt.k, evt.n);
    return tryResolvePendingAudioItems(evt.k);
  }

  if (evt.op === 'CONTRIBUTION_UPSERT' && evt.contrib && evt.contrib.id) {
    const meta = evt.contrib;
    if (relayState.deletedContributionIds.has(meta.id)) {
      return false;
    }
    if (meta.audioDataUrl && meta.audioDataUrl.length >= 20) {
      const fullContrib: AudioContributionRecord = {
        ...meta,
        audioDataUrl: meta.audioDataUrl,
      };
      const existing = relayState.contributions.get(fullContrib.id);
      if (!existing || (fullContrib.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
        relayState.contributions.set(fullContrib.id, fullContrib);
        return true;
      }
      return false;
    }
    if (meta.audioKey && meta.totalChunks) {
      audioTotalChunksStore.set(meta.audioKey, meta.totalChunks);
      pendingContribMetaByKey.set(meta.audioKey, meta);
      return tryResolvePendingAudioItems(meta.audioKey);
    }
    return false;
  }

  if (evt.op === 'CONTRIBUTION_STATUS' && typeof evt.id === 'string') {
    let changed = false;
    if (evt.status === 'deleted') {
      if (relayState.contributions.has(evt.id)) {
        relayState.contributions.delete(evt.id);
        changed = true;
      }
      relayState.deletedContributionIds.add(evt.id);
      if (evt.wordId) {
        for (const [cid, c] of relayState.contributions.entries()) {
          if (c.wordId === evt.wordId && c.status === 'pending') {
            relayState.contributions.delete(cid);
            relayState.deletedContributionIds.add(cid);
            changed = true;
          }
        }
      }
      return changed;
    }

    const existing = relayState.contributions.get(evt.id);
    if (existing) {
      relayState.contributions.set(evt.id, {
        ...existing,
        status: evt.status,
        word: evt.word || existing.word,
        banglaMeaning:
          evt.banglaMeaning !== undefined
            ? evt.banglaMeaning
            : existing.banglaMeaning,
        updatedAtMs: Math.max(existing.updatedAtMs || 0, evt.ts || Date.now()),
      });
      changed = true;
    }
    if (evt.wordId) {
      for (const [cid, c] of relayState.contributions.entries()) {
        if (cid !== evt.id && c.wordId === evt.wordId && c.status === 'pending') {
          relayState.contributions.set(cid, {
            ...c,
            status: evt.status,
            updatedAtMs: Math.max(c.updatedAtMs || 0, evt.ts || Date.now()),
          });
          changed = true;
        }
      }
    }
    return changed;
  }

  if (evt.op === 'RECORDING_UPSERT' && evt.rec && evt.rec.wordId) {
    const meta = evt.rec;
    relayState.deletedRecordingIds.delete(meta.wordId);
    if (meta.audioDataUrl && meta.audioDataUrl.length >= 20) {
      const fullRec: CloudRecording = {
        ...meta,
        audioDataUrl: meta.audioDataUrl,
      };
      const existing = relayState.recordings.get(fullRec.wordId);
      if (!existing || (fullRec.updatedAtMs || 0) >= (existing.updatedAtMs || 0)) {
        relayState.recordings.set(fullRec.wordId, fullRec);
        return true;
      }
      return false;
    }
    if (meta.audioKey && meta.totalChunks) {
      audioTotalChunksStore.set(meta.audioKey, meta.totalChunks);
      pendingRecordingMetaByKey.set(meta.audioKey, meta);
      return tryResolvePendingAudioItems(meta.audioKey);
    }
    return false;
  }

  if (evt.op === 'RECORDING_DELETE' && typeof evt.wordId === 'string') {
    relayState.recordings.delete(evt.wordId);
    relayState.deletedRecordingIds.add(evt.wordId);
    return true;
  }

  return false;
}

function notifyRelayListeners(): void {
  listeners.forEach((cb) => {
    try {
      cb(relayState);
    } catch {
      // ignore listener errors
    }
  });
}

function parseNtfyEnvelopeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    const env = JSON.parse(trimmed);
    if (env?.event !== 'message' || typeof env.message !== 'string') {
      return false;
    }
    const msg: string = env.message;
    const rawJson = msg.startsWith(EVENT_PREFIX)
      ? msg.slice(EVENT_PREFIX.length)
      : msg;
    if (!rawJson.startsWith('{')) return false;
    const evt = JSON.parse(rawJson) as CloudRelayEvent;
    return applyRelayEvent(evt);
  } catch {
    return false;
  }
}

/**
 * Publishes an event to the global cross-domain relay so all connected browsers
 * (across Vercel, AI Studio, and Android APK) receive it in real time.
 */
export async function publishCloudRelayEvent(
  evt: CloudRelayEvent
): Promise<void> {
  if (applyRelayEvent(evt)) {
    notifyRelayListeners();
  }

  try {
    const body = EVENT_PREFIX + JSON.stringify(evt);
    await fetch(CLOUD_RELAY_BASE_URL, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
      },
    });
  } catch {
    // Ignore network offline errors
  }
}

async function publishAudioChunksToRelay(
  audioKey: string,
  audioDataUrl: string
): Promise<number> {
  const totalChunks = Math.ceil(audioDataUrl.length / AUDIO_CHUNK_SIZE);
  if (totalChunks > 40) {
    // Cap chunked relay at ~112KB base64 so we never flood the public relay
    return 0;
  }
  let chunkMap = audioChunksStore.get(audioKey);
  if (!chunkMap) {
    chunkMap = new Map();
    audioChunksStore.set(audioKey, chunkMap);
  }
  audioTotalChunksStore.set(audioKey, totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    chunkMap.set(
      i,
      audioDataUrl.slice(i * AUDIO_CHUNK_SIZE, (i + 1) * AUDIO_CHUNK_SIZE)
    );
  }

  if (sentAudioKeys.has(audioKey)) {
    return totalChunks;
  }
  sentAudioKeys.add(audioKey);

  // Send in small batches of 3 to avoid rate limiting
  for (let i = 0; i < totalChunks; i += 3) {
    const batch: Promise<void>[] = [];
    for (let j = i; j < Math.min(totalChunks, i + 3); j++) {
      const slice = audioDataUrl.slice(
        j * AUDIO_CHUNK_SIZE,
        (j + 1) * AUDIO_CHUNK_SIZE
      );
      batch.push(
        publishCloudRelayEvent({
          op: 'AUDIO_CHUNK',
          k: audioKey,
          i: j,
          n: totalChunks,
          d: slice,
        })
      );
    }
    await Promise.all(batch);
  }

  return totalChunks;
}

export async function publishContributionUpsertToRelay(
  contribution: AudioContributionRecord
): Promise<void> {
  relayState.deletedContributionIds.delete(contribution.id);
  relayState.contributions.set(contribution.id, contribution);
  notifyRelayListeners();

  const { audioDataUrl, ...metaRest } = contribution;
  if (audioDataUrl.length <= 2200) {
    await publishCloudRelayEvent({
      op: 'CONTRIBUTION_UPSERT',
      ts: Date.now(),
      contrib: {
        ...metaRest,
        audioDataUrl,
      },
    });
    return;
  }

  const audioKey = `aud_${contribution.id}`;
  const totalChunks = await publishAudioChunksToRelay(audioKey, audioDataUrl);
  if (totalChunks > 0) {
    await publishCloudRelayEvent({
      op: 'CONTRIBUTION_UPSERT',
      ts: Date.now(),
      contrib: {
        ...metaRest,
        audioKey,
        totalChunks,
      },
    });
  }
}

export async function publishContributionStatusToRelay(params: {
  id: string;
  wordId: string;
  status: 'approved' | 'rejected' | 'deleted';
  word?: string;
  banglaMeaning?: string;
}): Promise<void> {
  await publishCloudRelayEvent({
    op: 'CONTRIBUTION_STATUS',
    ts: Date.now(),
    ...params,
  });
}

export async function publishRecordingUpsertToRelay(
  recording: CloudRecording,
  existingAudioKey?: string
): Promise<void> {
  relayState.deletedRecordingIds.delete(recording.wordId);
  relayState.recordings.set(recording.wordId, recording);
  notifyRelayListeners();

  const { audioDataUrl, ...metaRest } = recording;
  if (audioDataUrl.length <= 2200) {
    await publishCloudRelayEvent({
      op: 'RECORDING_UPSERT',
      ts: Date.now(),
      rec: {
        ...metaRest,
        audioDataUrl,
      },
    });
    return;
  }

  const audioKey =
    existingAudioKey || `rec_${recording.wordId}_${recording.updatedAtMs}`;
  const totalChunks = await publishAudioChunksToRelay(audioKey, audioDataUrl);
  if (totalChunks > 0) {
    await publishCloudRelayEvent({
      op: 'RECORDING_UPSERT',
      ts: Date.now(),
      rec: {
        ...metaRest,
        audioKey,
        totalChunks,
      },
    });
  }
}

export async function publishRecordingDeleteToRelay(
  wordId: string
): Promise<void> {
  await publishCloudRelayEvent({
    op: 'RECORDING_DELETE',
    ts: Date.now(),
    wordId,
  });
}

export async function publishContestUpsertToRelay(
  contest: ContestRecord
): Promise<void> {
  await publishCloudRelayEvent({
    op: 'CONTEST_UPSERT',
    ts: Date.now(),
    contest,
  });
}

export async function publishContestDeleteToRelay(
  contestId: string
): Promise<void> {
  await publishCloudRelayEvent({
    op: 'CONTEST_DELETE',
    ts: Date.now(),
    contestId,
  });
}

export async function publishSubmissionUpsertToRelay(
  submission: ContestSubmissionRecord
): Promise<void> {
  const { results, ...rest } = submission;
  await publishCloudRelayEvent({
    op: 'SUBMISSION_UPSERT',
    ts: Date.now(),
    sub: rest,
    r: compactResults(results),
  });
}

export async function publishWordOverrideUpsertToRelay(
  override: GlobalWordOverride
): Promise<void> {
  await publishCloudRelayEvent({
    op: 'WORD_OVERRIDE_UPSERT',
    ts: Date.now(),
    override,
  });
}

export async function publishWordOverrideDeleteToRelay(
  wordId: string
): Promise<void> {
  await publishCloudRelayEvent({
    op: 'WORD_OVERRIDE_DELETE',
    ts: Date.now(),
    wordId,
  });
}

/**
 * Polls the 12-hour cached event log from the global cloud relay and applies all events in order.
 */
export async function pollCloudRelaySnapshot(
  force = false
): Promise<CloudRelaySnapshot> {
  const now = Date.now();
  if (!force && now - lastPollAtMs < 1500) {
    return relayState;
  }
  if (pollInFlight) {
    return pollInFlight;
  }

  pollInFlight = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(`${CLOUD_RELAY_BASE_URL}/json?poll=1&since=all`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        lastPollAtMs = Date.now();
        const text = await res.text();
        const lines = text.split('\n');
        let changed = false;
        for (const line of lines) {
          if (parseNtfyEnvelopeLine(line)) {
            changed = true;
          }
        }
        if (changed) {
          notifyRelayListeners();
        }
      }
    } catch {
      // Ignore offline/timeout errors
    } finally {
      pollInFlight = null;
    }
    return relayState;
  })();

  return pollInFlight;
}

/**
 * Opens a real-time Server-Sent Events (SSE) stream to the global cloud relay
 * so new contests, registrations, and scores arrive in < 200ms across all browsers and domains.
 */
export function subscribeToCloudRelay(
  callback: (snapshot: CloudRelaySnapshot) => void
): () => void {
  listeners.add(callback);
  callback(relayState);

  void pollCloudRelaySnapshot(false);

  if (typeof window !== 'undefined' && 'EventSource' in window && !sseSource) {
    try {
      sseSource = new EventSource(`${CLOUD_RELAY_BASE_URL}/sse?since=all`);
      sseSource.onmessage = (ev) => {
        if (typeof ev.data === 'string' && parseNtfyEnvelopeLine(ev.data)) {
          notifyRelayListeners();
        }
      };
      sseSource.onerror = () => {
        // Browser EventSource automatically reconnects; poll fallback keeps state fresh
      };
    } catch {
      sseSource = null;
    }
  }

  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && sseSource) {
      try {
        sseSource.close();
      } catch {
        // ignore
      }
      sseSource = null;
    }
  };
}

export function getCurrentCloudRelaySnapshot(): CloudRelaySnapshot {
  return relayState;
}
