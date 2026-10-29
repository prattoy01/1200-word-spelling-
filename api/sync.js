import fs from 'fs';
import path from 'path';

const STORE_FILE = path.join('/tmp', 'lw-cloud-sync-store.json');

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

let memoryStore = null;

function loadStore() {
  if (memoryStore) return memoryStore;
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      memoryStore = {
        ...createEmptyStore(),
        ...parsed,
      };
      return memoryStore;
    }
  } catch {
    // ignore
  }
  memoryStore = createEmptyStore();
  return memoryStore;
}

function saveStore(store) {
  store.updatedAtMs = Date.now();
  memoryStore = store;
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store), 'utf8');
  } catch {
    // ignore /tmp write warnings
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PATCH, DELETE, OPTIONS'
  );
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const store = loadStore();
  const urlObj = new URL(req.url || '/api/sync/state', 'http://localhost');
  const routeParam = urlObj.searchParams.get('route') || '';
  const cleanPath = routeParam
    ? `/api/sync/${routeParam.replace(/^\/+/, '')}`
    : urlObj.pathname;

  if (req.method === 'GET' && cleanPath === '/api/sync/state') {
    const includeAudio = urlObj.searchParams.get('includeAudio') !== 'false';
    const deletedContestSet = new Set(store.deletedContestIds);
    const contestsList = Object.values(store.contests).filter(
      (c) =>
        c && c.id && c.status !== 'cancelled' && !deletedContestSet.has(c.id)
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
      for (const [wid, rec] of Object.entries(store.recordings)) {
        if (rec && !deletedRecSet.has(wid)) {
          recordingsMap[wid] = rec;
        }
      }
    }
    const deletedWordOverrideSet = new Set(store.deletedWordOverrideIds);
    const wordOverridesMap = {};
    for (const [wid, ov] of Object.entries(store.wordOverrides)) {
      if (ov && !deletedWordOverrideSet.has(wid)) {
        wordOverridesMap[wid] = ov;
      }
    }

    return res.status(200).json({
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
  }

  if (req.method === 'POST' && cleanPath === '/api/sync/contests') {
    const body = req.body || {};
    const items = Array.isArray(body.contests)
      ? body.contests
      : body.contest
      ? [body.contest]
      : body.id
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
      if (
        !existing ||
        (Number(raw.updatedAtMs) || 0) >= (Number(existing.updatedAtMs) || 0)
      ) {
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
    return res.status(200).json({ ok: true, count });
  }

  if (
    req.method === 'DELETE' &&
    cleanPath.startsWith('/api/sync/contests/')
  ) {
    const contestId = decodeURIComponent(
      cleanPath.slice('/api/sync/contests/'.length)
    );
    if (contestId) {
      delete store.contests[contestId];
      if (!store.deletedContestIds.includes(contestId)) {
        store.deletedContestIds.push(contestId);
      }
      for (const [subId, sub] of Object.entries(store.submissions)) {
        if (sub?.contestId === contestId) {
          delete store.submissions[subId];
        }
      }
      saveStore(store);
    }
    return res.status(200).json({ ok: true, deletedId: contestId });
  }

  if (req.method === 'POST' && cleanPath === '/api/sync/contest-submissions') {
    const body = req.body || {};
    const items = Array.isArray(body.submissions)
      ? body.submissions
      : body.submission
      ? [body.submission]
      : body.id
      ? [body]
      : [];
    const statusRank = (st) =>
      st === 'completed' ? 3 : st === 'in_progress' ? 2 : 1;
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
        const rIn = statusRank(raw.status);
        const rEx = statusRank(existing.status);
        if (
          rIn > rEx ||
          (rIn === rEx &&
            (Number(raw.updatedAtMs) || 0) >=
              (Number(existing.updatedAtMs) || 0))
        ) {
          store.submissions[raw.id] = {
            ...existing,
            ...raw,
            results: raw.results || existing.results,
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
    return res.status(200).json({ ok: true, count });
  }

  if (req.method === 'POST' && cleanPath === '/api/sync/word-overrides') {
    const body = req.body || {};
    const items = Array.isArray(body.overrides)
      ? body.overrides
      : body.override
      ? [body.override]
      : body.wordId
      ? [body]
      : [];
    let count = 0;
    for (const raw of items) {
      if (!raw || typeof raw.wordId !== 'string' || typeof raw.word !== 'string')
        continue;
      const cleanWord = raw.word.trim().slice(0, 120);
      if (!cleanWord) continue;
      store.deletedWordOverrideIds = store.deletedWordOverrideIds.filter(
        (x) => x !== raw.wordId
      );
      store.wordOverrides[raw.wordId] = {
        wordId: raw.wordId,
        word: cleanWord,
        bangla: (raw.bangla ?? '').trim().slice(0, 200),
        updatedBy: (raw.updatedBy || 'Admin').trim().slice(0, 120),
        updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
      };
      count++;
    }
    if (count > 0) saveStore(store);
    return res.status(200).json({ ok: true, count });
  }

  if (
    req.method === 'DELETE' &&
    cleanPath.startsWith('/api/sync/word-overrides/')
  ) {
    const wordId = decodeURIComponent(
      cleanPath.slice('/api/sync/word-overrides/'.length)
    );
    if (wordId) {
      delete store.wordOverrides[wordId];
      if (!store.deletedWordOverrideIds.includes(wordId)) {
        store.deletedWordOverrideIds.push(wordId);
      }
      saveStore(store);
    }
    return res.status(200).json({ ok: true, deletedWordId: wordId });
  }

  return res.status(200).json({ ok: true });
}
