import fs from 'fs';
import path from 'path';

const TMP_STORE_FILE = path.join('/tmp', 'lw-cloud-sync-store.json');

function createEmptyStore() {
  return {
    contests: {},
    deletedContestIds: [],
    submissions: {},
    contributions: {},
    deletedContributionIds: [],
    recordings: {},
    deletedRecordingIds: [],
    wordOverrides: {},
    deletedWordOverrideIds: [],
    personalWords: {},
    updatedAtMs: Date.now(),
  };
}

function loadStore() {
  if (globalThis.__lwSharedCloudStore) {
    return globalThis.__lwSharedCloudStore;
  }
  try {
    if (fs.existsSync(TMP_STORE_FILE)) {
      const raw = fs.readFileSync(TMP_STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      const loaded = {
        contests: parsed?.contests && typeof parsed.contests === 'object' ? parsed.contests : {},
        deletedContestIds: Array.isArray(parsed?.deletedContestIds) ? parsed.deletedContestIds : [],
        submissions:
          parsed?.submissions && typeof parsed.submissions === 'object' ? parsed.submissions : {},
        contributions:
          parsed?.contributions && typeof parsed.contributions === 'object'
            ? parsed.contributions
            : {},
        deletedContributionIds: Array.isArray(parsed?.deletedContributionIds)
          ? parsed.deletedContributionIds
          : [],
        recordings:
          parsed?.recordings && typeof parsed.recordings === 'object' ? parsed.recordings : {},
        deletedRecordingIds: Array.isArray(parsed?.deletedRecordingIds)
          ? parsed.deletedRecordingIds
          : [],
        wordOverrides:
          parsed?.wordOverrides && typeof parsed.wordOverrides === 'object'
            ? parsed.wordOverrides
            : {},
        deletedWordOverrideIds: Array.isArray(parsed?.deletedWordOverrideIds)
          ? parsed.deletedWordOverrideIds
          : [],
        personalWords:
          parsed?.personalWords && typeof parsed.personalWords === 'object'
            ? parsed.personalWords
            : {},
        updatedAtMs: Number(parsed?.updatedAtMs) || Date.now(),
      };
      globalThis.__lwSharedCloudStore = loaded;
      return loaded;
    }
  } catch {
    // ignore
  }
  const initial = createEmptyStore();
  globalThis.__lwSharedCloudStore = initial;
  return initial;
}

function saveStore(store) {
  store.updatedAtMs = Date.now();
  globalThis.__lwSharedCloudStore = store;
  try {
    fs.writeFileSync(TMP_STORE_FILE, JSON.stringify(store), 'utf8');
  } catch {
    // ignore /tmp write errors
  }
}

function statusRank(st) {
  if (st === 'completed') return 3;
  if (st === 'in_progress') return 2;
  return 1;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const store = loadStore();
  const urlObj = new URL(req.url || '/api/sync/state', 'http://localhost');
  const pathname = urlObj.pathname.replace(/^\/api\/sync\/?/, '');
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const resource = segments[0] || 'state';
  const param1 = segments[1] || '';
  const param2 = segments[2] || '';
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

  // GET /api/sync/state
  if (req.method === 'GET' && resource === 'state') {
    const includeAudio = urlObj.searchParams.get('includeAudio') !== 'false';
    const deletedContestSet = new Set(store.deletedContestIds);
    const contestsList = Object.values(store.contests).filter(
      (c) => c && c.id && c.status !== 'cancelled' && !deletedContestSet.has(c.id)
    );
    const submissionsList = Object.values(store.submissions).filter(
      (s) => s && s.id && !deletedContestSet.has(s.contestId)
    );
    const deletedContribSet = new Set(store.deletedContributionIds);
    const contributionsList = Object.values(store.contributions).filter(
      (c) => c && c.id && !deletedContribSet.has(c.id)
    );
    const deletedRecSet = new Set(store.deletedRecordingIds);
    const recordingsMap = {};
    if (includeAudio) {
      for (const [wordId, rec] of Object.entries(store.recordings)) {
        if (rec && !deletedRecSet.has(wordId)) {
          recordingsMap[wordId] = rec;
        }
      }
    }
    const deletedWordOverrideSet = new Set(store.deletedWordOverrideIds);
    const wordOverridesMap = {};
    for (const [wordId, ov] of Object.entries(store.wordOverrides)) {
      if (ov && !deletedWordOverrideSet.has(wordId)) {
        wordOverridesMap[wordId] = ov;
      }
    }

    res.status(200).json({
      ok: true,
      updatedAtMs: store.updatedAtMs,
      contests: contestsList,
      deletedContestIds: store.deletedContestIds,
      submissions: submissionsList,
      contributions: contributionsList,
      deletedContributionIds: store.deletedContributionIds,
      recordings: recordingsMap,
      deletedRecordingIds: store.deletedRecordingIds,
      wordOverrides: wordOverridesMap,
      deletedWordOverrideIds: store.deletedWordOverrideIds,
    });
    return;
  }

  // POST /api/sync/contests
  if (req.method === 'POST' && resource === 'contests') {
    const items = Array.isArray(body?.contests)
      ? body.contests
      : body?.contest
      ? [body.contest]
      : body?.id
      ? [body]
      : [];
    const deletedSet = new Set(store.deletedContestIds);
    let count = 0;
    for (const raw of items) {
      if (!raw || typeof raw.id !== 'string') continue;
      if (raw.status === 'cancelled' || deletedSet.has(raw.id)) {
        delete store.contests[raw.id];
        if (!deletedSet.has(raw.id)) {
          store.deletedContestIds.push(raw.id);
          deletedSet.add(raw.id);
        }
        continue;
      }
      const existing = store.contests[raw.id];
      if (!existing || (Number(raw.updatedAtMs) || 0) >= (Number(existing.updatedAtMs) || 0)) {
        store.contests[raw.id] = {
          ...existing,
          ...raw,
          status: 'active',
          updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
        };
        count++;
      }
    }
    if (count > 0) saveStore(store);
    res.status(200).json({ ok: true, count });
    return;
  }

  // DELETE /api/sync/contests/:id
  if (req.method === 'DELETE' && resource === 'contests' && param1) {
    delete store.contests[param1];
    if (!store.deletedContestIds.includes(param1)) {
      store.deletedContestIds.push(param1);
    }
    for (const [subId, sub] of Object.entries(store.submissions)) {
      if (sub?.contestId === param1) {
        delete store.submissions[subId];
      }
    }
    saveStore(store);
    res.status(200).json({ ok: true, deletedId: param1 });
    return;
  }

  // POST /api/sync/contest-submissions
  if (req.method === 'POST' && resource === 'contest-submissions') {
    const items = Array.isArray(body?.submissions)
      ? body.submissions
      : body?.submission
      ? [body.submission]
      : body?.id
      ? [body]
      : [];
    let count = 0;
    for (const raw of items) {
      if (!raw || typeof raw.id !== 'string') continue;
      const existing = store.submissions[raw.id];
      if (!existing) {
        store.submissions[raw.id] = {
          ...raw,
          updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
        };
        count++;
      } else {
        const incomingRank = statusRank(raw.status);
        const existingRank = statusRank(existing.status);
        if (
          incomingRank > existingRank ||
          (incomingRank === existingRank &&
            (Number(raw.updatedAtMs) || 0) >= (Number(existing.updatedAtMs) || 0))
        ) {
          store.submissions[raw.id] = {
            ...existing,
            ...raw,
            results: raw.results || existing.results,
            createdAtMs: existing.createdAtMs || raw.createdAtMs || Date.now(),
            updatedAtMs: Math.max(
              Number(raw.updatedAtMs) || 0,
              Number(existing.updatedAtMs) || 0,
              Date.now()
            ),
          };
          count++;
        }
      }
    }
    if (count > 0) saveStore(store);
    res.status(200).json({ ok: true, count });
    return;
  }

  // POST /api/sync/audio-contributions
  if (req.method === 'POST' && resource === 'audio-contributions') {
    const items = Array.isArray(body?.contributions)
      ? body.contributions
      : body?.contribution
      ? [body.contribution]
      : body?.wordId
      ? [body]
      : [];
    let count = 0;
    for (const raw of items) {
      if (!raw || typeof raw.wordId !== 'string' || !raw.audioDataUrl) continue;
      const nowMs = Date.now();
      const id =
        typeof raw.id === 'string' && raw.id
          ? raw.id
          : `contrib_${raw.wordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}_${nowMs}`;
      store.deletedContributionIds = store.deletedContributionIds.filter((x) => x !== id);
      const existing = store.contributions[id];
      const isNewPending = raw.forcePending === true;
      if (
        !existing ||
        isNewPending ||
        (Number(raw.updatedAtMs) || 0) >= (Number(existing.updatedAtMs) || 0)
      ) {
        store.contributions[id] = {
          id,
          wordId: raw.wordId,
          word: raw.word || raw.wordId,
          banglaMeaning: raw.banglaMeaning ?? existing?.banglaMeaning ?? '',
          audioDataUrl: raw.audioDataUrl,
          mimeType: raw.mimeType || 'audio/wav',
          fileName: raw.fileName || `${raw.wordId}.wav`,
          fileSize: Number(raw.fileSize) || 1024,
          durationMs: Number(raw.durationMs) || 1200,
          contributorId: raw.contributorId || 'community_user',
          contributorName: raw.contributorName || 'Community Member',
          status: isNewPending ? 'pending' : raw.status || existing?.status || 'pending',
          createdAtMs: isNewPending
            ? nowMs
            : Number(raw.createdAtMs) || existing?.createdAtMs || nowMs,
          updatedAtMs: isNewPending ? nowMs : Number(raw.updatedAtMs) || nowMs,
        };
        count++;
      }
    }
    if (count > 0) saveStore(store);
    res.status(200).json({ ok: true, count });
    return;
  }

  // PATCH /api/sync/audio-contributions/:id
  if (req.method === 'PATCH' && resource === 'audio-contributions' && param1) {
    const existing = store.contributions[param1];
    if (existing) {
      store.contributions[param1] = {
        ...existing,
        ...(body?.status ? { status: body.status } : {}),
        ...(typeof body?.word === 'string' && body.word.trim() ? { word: body.word.trim() } : {}),
        ...(body?.banglaMeaning !== undefined ? { banglaMeaning: body.banglaMeaning } : {}),
        updatedAtMs: Date.now(),
      };
      saveStore(store);
    }
    res.status(200).json({ ok: true, item: store.contributions[param1] || null });
    return;
  }

  // DELETE /api/sync/audio-contributions/:id
  if (req.method === 'DELETE' && resource === 'audio-contributions' && param1) {
    delete store.contributions[param1];
    if (!store.deletedContributionIds.includes(param1)) {
      store.deletedContributionIds.push(param1);
    }
    saveStore(store);
    res.status(200).json({ ok: true, deletedId: param1 });
    return;
  }

  // POST /api/sync/recordings
  if (req.method === 'POST' && resource === 'recordings') {
    const items = Array.isArray(body?.recordings)
      ? body.recordings
      : body?.recording
      ? [body.recording]
      : body?.wordId
      ? [body]
      : [];
    let count = 0;
    for (const raw of items) {
      if (!raw || typeof raw.wordId !== 'string' || !raw.audioDataUrl) continue;
      store.deletedRecordingIds = store.deletedRecordingIds.filter((x) => x !== raw.wordId);
      const existing = store.recordings[raw.wordId];
      if (!existing || (Number(raw.updatedAtMs) || 0) >= (Number(existing.updatedAtMs) || 0)) {
        store.recordings[raw.wordId] = {
          wordId: raw.wordId,
          word: raw.word || raw.wordId,
          banglaMeaning: raw.banglaMeaning ?? existing?.banglaMeaning ?? '',
          audioDataUrl: raw.audioDataUrl,
          mimeType: raw.mimeType || 'audio/mpeg',
          fileName: raw.fileName || `${raw.wordId}.mp3`,
          fileSize: Number(raw.fileSize) || 1024,
          durationMs: Number(raw.durationMs) || 1200,
          ownerId: raw.ownerId || 'admin_general_audio',
          ownerName: raw.ownerName || 'General App Audio',
          status: 'published',
          updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
        };
        count++;
      }
    }
    if (count > 0) saveStore(store);
    res.status(200).json({ ok: true, count });
    return;
  }

  // DELETE /api/sync/recordings/:wordId
  if (req.method === 'DELETE' && resource === 'recordings' && param1) {
    delete store.recordings[param1];
    if (!store.deletedRecordingIds.includes(param1)) {
      store.deletedRecordingIds.push(param1);
    }
    saveStore(store);
    res.status(200).json({ ok: true, deletedWordId: param1 });
    return;
  }

  // POST /api/sync/word-overrides
  if (req.method === 'POST' && resource === 'word-overrides') {
    const items = Array.isArray(body?.overrides)
      ? body.overrides
      : body?.override
      ? [body.override]
      : body?.wordId
      ? [body]
      : [];
    let count = 0;
    for (const raw of items) {
      if (!raw || typeof raw.wordId !== 'string' || typeof raw.word !== 'string') continue;
      const cleanWord = raw.word.trim().slice(0, 120);
      if (!cleanWord) continue;
      store.deletedWordOverrideIds = store.deletedWordOverrideIds.filter((x) => x !== raw.wordId);
      const nowMs = Number(raw.updatedAtMs) || Date.now();
      store.wordOverrides[raw.wordId] = {
        wordId: raw.wordId,
        word: cleanWord,
        bangla: (raw.bangla ?? '').trim().slice(0, 200),
        updatedBy: (raw.updatedBy || 'Admin').trim().slice(0, 120),
        updatedAtMs: nowMs,
      };
      count++;
    }
    if (count > 0) saveStore(store);
    res.status(200).json({ ok: true, count });
    return;
  }

  // DELETE /api/sync/word-overrides/:wordId
  if (req.method === 'DELETE' && resource === 'word-overrides' && param1) {
    delete store.wordOverrides[param1];
    if (!store.deletedWordOverrideIds.includes(param1)) {
      store.deletedWordOverrideIds.push(param1);
    }
    saveStore(store);
    res.status(200).json({ ok: true, deletedWordId: param1 });
    return;
  }

  // GET /api/sync/personal-words/:ownerId
  if (req.method === 'GET' && resource === 'personal-words' && param1) {
    const bucket = store.personalWords[param1] || {};
    res.status(200).json({ ok: true, words: Object.values(bucket) });
    return;
  }

  // POST /api/sync/personal-words
  if (req.method === 'POST' && resource === 'personal-words') {
    const items = Array.isArray(body?.words)
      ? body.words
      : body?.word
      ? [body.word]
      : body?.wordId
      ? [body]
      : [];
    let count = 0;
    for (const raw of items) {
      if (!raw || typeof raw.ownerId !== 'string' || typeof raw.wordId !== 'string') continue;
      if (!store.personalWords[raw.ownerId]) {
        store.personalWords[raw.ownerId] = {};
      }
      store.personalWords[raw.ownerId][raw.wordId] = {
        id: raw.id || `${raw.ownerId}_${raw.wordId}`,
        wordId: raw.wordId,
        word: raw.word || raw.wordId,
        bangla: raw.bangla || '',
        example: raw.example || '',
        ownerId: raw.ownerId,
        createdAtMs: Number(raw.createdAtMs) || Date.now(),
        updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
      };
      count++;
    }
    if (count > 0) saveStore(store);
    res.status(200).json({ ok: true, count });
    return;
  }

  // DELETE /api/sync/personal-words/:ownerId/:wordId
  if (req.method === 'DELETE' && resource === 'personal-words' && param1 && param2) {
    if (store.personalWords[param1]) {
      delete store.personalWords[param1][param2];
      saveStore(store);
    }
    res.status(200).json({ ok: true });
    return;
  }

  // Server-side relay proxy (/api/sync/relay) so client IPs are never blocked by ntfy.sh rate limits
  const RELAY_HUB_URL = 'https://ntfy.sh/lw_sync_hub_12193dcd_v5';
  if (resource === 'relay') {
    if (req.method === 'POST') {
      const rawEvent = typeof body?.rawEvent === 'string' ? body.rawEvent : '';
      if (!rawEvent) {
        res.status(400).json({ ok: false });
        return;
      }
      if (!Array.isArray(globalThis.__lwRelayLinesCache)) {
        globalThis.__lwRelayLinesCache = [];
      }
      globalThis.__lwRelayLinesCache.push(
        JSON.stringify({ event: 'message', time: Math.floor(Date.now() / 1000), message: rawEvent })
      );
      if (globalThis.__lwRelayLinesCache.length > 400) {
        globalThis.__lwRelayLinesCache = globalThis.__lwRelayLinesCache.slice(-400);
      }
      try {
        await fetch(RELAY_HUB_URL, {
          method: 'POST',
          body: rawEvent,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        });
      } catch {
        // ignore
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'GET') {
      const now = Date.now();
      const lastFetch = Number(globalThis.__lwRelayLastFetchMs || 0);
      if (now - lastFetch > 5000 || !Array.isArray(globalThis.__lwRelayLinesCache)) {
        try {
          const upstream = await fetch(`${RELAY_HUB_URL}/json?poll=1&since=all`, {
            cache: 'no-store',
          });
          if (upstream.ok) {
            const text = await upstream.text();
            const fetchedLines = text
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean);
            globalThis.__lwRelayLinesCache = fetchedLines.slice(-400);
            globalThis.__lwRelayLastFetchMs = now;
          }
        } catch {
          // ignore
        }
      }
      res.status(200).json({
        ok: true,
        lines: Array.isArray(globalThis.__lwRelayLinesCache)
          ? globalThis.__lwRelayLinesCache
          : [],
      });
      return;
    }
  }

  res.status(404).json({ ok: false, error: 'Route not found' });
}
