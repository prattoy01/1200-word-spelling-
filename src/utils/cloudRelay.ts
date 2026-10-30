import { WORDS_CATALOG } from '../data/words';
import { compactAudioDataUrlForRelay } from './audioUtils';
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
 * Unified Single-Topic Cross-Origin / Cross-Domain Real-Time Cloud Relay:
 * Uses a single lightweight topic (<3.5KB inline JSON per event, zero file attachments)
 * and a single SSE connection per tab so home Wi-Fi IPs are never rate-limited by ntfy.sh,
 * with automatic server-side relay fallback via `/api/sync/relay`.
 */
export const CONTEST_RELAY_TOPIC = 'lw_sync_hub_12193dcd_v5';
export const AUDIO_RELAY_TOPIC = 'lw_sync_hub_12193dcd_v5';
export const CONTEST_RELAY_URL = `https://ntfy.sh/${CONTEST_RELAY_TOPIC}`;
export const AUDIO_RELAY_URL = CONTEST_RELAY_URL;
const EVENT_PREFIX = 'LW_EVT:';
const AUDIO_CHUNK_SIZE = 3450;

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
let contestSseSource: EventSource | null = null;
let audioSseSource: EventSource | null = null;
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

function parseRawEventPayload(msg: string): boolean {
  const rawJson = msg.startsWith(EVENT_PREFIX)
    ? msg.slice(EVENT_PREFIX.length)
    : msg;
  if (!rawJson.startsWith('{')) return false;
  try {
    const evt = JSON.parse(rawJson) as CloudRelayEvent;
    return applyRelayEvent(evt);
  } catch {
    return false;
  }
}

function parseNtfyEnvelopeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    const env = JSON.parse(trimmed);
    if (env?.event !== 'message' || typeof env.message !== 'string') {
      return false;
    }
    return parseRawEventPayload(env.message);
  } catch {
    return false;
  }
}

function getTargetRelayUrl(evt: CloudRelayEvent): string {
  if (
    evt.op === 'AUDIO_CHUNK' ||
    evt.op === 'CONTRIBUTION_UPSERT' ||
    evt.op === 'CONTRIBUTION_STATUS' ||
    evt.op === 'RECORDING_UPSERT' ||
    evt.op === 'RECORDING_DELETE'
  ) {
    return AUDIO_RELAY_URL;
  }
  return CONTEST_RELAY_URL;
}

/**
 * Publishes an inline (<4KB) event to the unified global cross-domain relay topic,
 * with automatic fallback to `/api/sync/relay` if the client IP is rate-limited.
 */
export async function publishCloudRelayEvent(
  evt: CloudRelayEvent
): Promise<boolean> {
  if (applyRelayEvent(evt)) {
    notifyRelayListeners();
  }

  const body = EVENT_PREFIX + JSON.stringify(evt);
  const targetUrl = getTargetRelayUrl(evt);

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
      },
    });
    if (res.ok) return true;
  } catch {
    // Fall through to server-side relay proxy
  }

  try {
    const proxyRes = await fetch('/api/sync/relay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawEvent: body }),
    });
    return proxyRes.ok;
  } catch {
    return false;
  }
}

async function publishInlineAudioChunksToRelay(
  audioKey: string,
  rawAudioDataUrl: string
): Promise<{ totalChunks: number; finalAudioUrl: string; allSent: boolean }> {
  const finalAudioUrl = await compactAudioDataUrlForRelay(rawAudioDataUrl);
  const totalChunks = Math.ceil(finalAudioUrl.length / AUDIO_CHUNK_SIZE);

  let chunkMap = audioChunksStore.get(audioKey);
  if (!chunkMap) {
    chunkMap = new Map();
    audioChunksStore.set(audioKey, chunkMap);
  }
  audioTotalChunksStore.set(audioKey, totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    chunkMap.set(
      i,
      finalAudioUrl.slice(i * AUDIO_CHUNK_SIZE, (i + 1) * AUDIO_CHUNK_SIZE)
    );
  }

  if (sentAudioKeys.has(audioKey)) {
    return { totalChunks, finalAudioUrl, allSent: true };
  }

  let allSent = true;
  for (let i = 0; i < totalChunks; i++) {
    const slice = finalAudioUrl.slice(
      i * AUDIO_CHUNK_SIZE,
      (i + 1) * AUDIO_CHUNK_SIZE
    );
    const ok = await publishCloudRelayEvent({
      op: 'AUDIO_CHUNK',
      k: audioKey,
      i,
      n: totalChunks,
      d: slice,
    });
    if (!ok) {
      allSent = false;
      break;
    }
    if (i + 1 < totalChunks) {
      await new Promise((r) => setTimeout(r, 180));
    }
  }

  if (allSent) {
    sentAudioKeys.add(audioKey);
  }
  return { totalChunks, finalAudioUrl, allSent };
}

export async function publishContributionUpsertToRelay(
  contribution: AudioContributionRecord
): Promise<boolean> {
  relayState.deletedContributionIds.delete(contribution.id);
  const sentKey = `contrib_meta_${contribution.id}_${contribution.updatedAtMs}`;
  if (sentAudioKeys.has(sentKey)) {
    return true;
  }

  const { audioDataUrl, ...metaRest } = contribution;
  if (audioDataUrl.length <= 2400) {
    const ok = await publishCloudRelayEvent({
      op: 'CONTRIBUTION_UPSERT',
      ts: Date.now(),
      contrib: {
        ...metaRest,
        audioDataUrl,
      },
    });
    if (ok) sentAudioKeys.add(sentKey);
    return ok;
  }

  const audioKey = `aud_${contribution.id}`;
  const { totalChunks, allSent } = await publishInlineAudioChunksToRelay(
    audioKey,
    audioDataUrl
  );
  if (!allSent || totalChunks <= 0) {
    return false;
  }

  const ok = await publishCloudRelayEvent({
    op: 'CONTRIBUTION_UPSERT',
    ts: Date.now(),
    contrib: {
      ...metaRest,
      audioKey,
      totalChunks,
    },
  });
  if (ok) {
    sentAudioKeys.add(sentKey);
  }
  return ok;
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
): Promise<boolean> {
  relayState.deletedRecordingIds.delete(recording.wordId);
  const sentKey = `rec_meta_${recording.wordId}_${recording.updatedAtMs}`;
  if (sentAudioKeys.has(sentKey)) {
    return true;
  }

  const { audioDataUrl, ...metaRest } = recording;
  if (audioDataUrl.length <= 2400) {
    const ok = await publishCloudRelayEvent({
      op: 'RECORDING_UPSERT',
      ts: Date.now(),
      rec: {
        ...metaRest,
        audioDataUrl,
      },
    });
    if (ok) sentAudioKeys.add(sentKey);
    return ok;
  }

  const audioKey =
    existingAudioKey || `rec_${recording.wordId}_${recording.updatedAtMs}`;
  const { totalChunks, allSent } = await publishInlineAudioChunksToRelay(
    audioKey,
    audioDataUrl
  );
  if (!allSent || totalChunks <= 0) {
    return false;
  }

  const ok = await publishCloudRelayEvent({
    op: 'RECORDING_UPSERT',
    ts: Date.now(),
    rec: {
      ...metaRest,
      audioKey,
      totalChunks,
    },
  });
  if (ok) {
    sentAudioKeys.add(sentKey);
  }
  return ok;
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
): Promise<boolean> {
  const sentKey = `contest_${contest.id}_${contest.updatedAtMs}`;
  if (sentAudioKeys.has(sentKey)) return true;
  const ok = await publishCloudRelayEvent({
    op: 'CONTEST_UPSERT',
    ts: Date.now(),
    contest,
  });
  if (ok) sentAudioKeys.add(sentKey);
  return ok;
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
): Promise<boolean> {
  const sentKey = `sub_${submission.id}_${submission.status}_${submission.updatedAtMs}`;
  if (sentAudioKeys.has(sentKey)) return true;
  const { results, ...rest } = submission;
  const ok = await publishCloudRelayEvent({
    op: 'SUBMISSION_UPSERT',
    ts: Date.now(),
    sub: rest,
    r: compactResults(results),
  });
  if (ok) sentAudioKeys.add(sentKey);
  return ok;
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

async function pollSingleRelayTopic(topicUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${topicUrl}/json?poll=1&since=all`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const text = await res.text();
      const lines = text.split('\n');
      let changed = false;
      for (const line of lines) {
        if (parseNtfyEnvelopeLine(line)) {
          changed = true;
        }
      }
      return changed;
    }
  } catch {
    // Fall through to server-side relay proxy
  }

  try {
    const proxyRes = await fetch('/api/sync/relay', { cache: 'no-store' });
    if (!proxyRes.ok) return false;
    const data = await proxyRes.json();
    if (!Array.isArray(data?.lines)) return false;
    let changed = false;
    for (const line of data.lines) {
      if (typeof line === 'string' && parseNtfyEnvelopeLine(line)) {
        changed = true;
      }
    }
    return changed;
  } catch {
    return false;
  }
}

/**
 * Polls the 12-hour cached event log from the unified global cloud relay topic and applies all events in order.
 * Throttled so even multiple tabs on the same Wi-Fi IP never hit ntfy.sh rate limits.
 */
export async function pollCloudRelaySnapshot(
  force = false
): Promise<CloudRelaySnapshot> {
  const now = Date.now();
  const minCooldownMs = force ? 5000 : 25000;
  if (lastPollAtMs > 0 && now - lastPollAtMs < minCooldownMs) {
    return relayState;
  }
  if (pollInFlight) {
    return pollInFlight;
  }

  pollInFlight = (async () => {
    try {
      lastPollAtMs = Date.now();
      const changed = await pollSingleRelayTopic(CONTEST_RELAY_URL);
      if (changed) {
        notifyRelayListeners();
      }
    } finally {
      pollInFlight = null;
    }
    return relayState;
  })();

  return pollInFlight;
}

/**
 * Opens a single real-time Server-Sent Events (SSE) stream to the unified global cloud relay topic
 * so new contests, registrations, scores, and audio contributions arrive in < 200ms across all browsers and domains.
 */
export function subscribeToCloudRelay(
  callback: (snapshot: CloudRelaySnapshot) => void
): () => void {
  listeners.add(callback);
  callback(relayState);

  void pollCloudRelaySnapshot(false);

  if (typeof window !== 'undefined' && 'EventSource' in window) {
    if (!contestSseSource) {
      try {
        contestSseSource = new EventSource(`${CONTEST_RELAY_URL}/sse?since=all`);
        contestSseSource.onmessage = (ev) => {
          if (typeof ev.data === 'string' && parseNtfyEnvelopeLine(ev.data)) {
            notifyRelayListeners();
          }
        };
      } catch {
        contestSseSource = null;
      }
    }
  }

  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) {
      if (contestSseSource) {
        try {
          contestSseSource.close();
        } catch {
          // ignore
        }
        contestSseSource = null;
      }
      if (audioSseSource) {
        try {
          audioSseSource.close();
        } catch {
          // ignore
        }
        audioSseSource = null;
      }
    }
  };
}

export function getCurrentCloudRelaySnapshot(): CloudRelaySnapshot {
  return relayState;
}
