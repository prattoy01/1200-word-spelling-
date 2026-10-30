import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { requireAuth, type AuthRequest } from './src/middleware/auth.ts';
import { getOrCreateUser, getUsers } from './src/db/users.ts';
import {
  fetchAllCloudSqlSyncData,
  upsertContestsToSql,
  markContestDeletedInSql,
  upsertSubmissionsToSql,
  upsertContributionsToSql,
  updateContributionStatusInSql,
  markContributionDeletedInSql,
  upsertRecordingsToSql,
  markRecordingDeletedInSql,
  upsertWordOverridesToSql,
  markWordOverrideDeletedInSql,
  getPersonalWordsByOwnerFromSql,
  upsertPersonalWordsToSql,
  markPersonalWordDeletedInSql,
} from './src/db/syncRepository.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '.data');
const STORE_FILE = path.join(DATA_DIR, 'cloud-sync-store.json');

interface SharedCloudStore {
  contests: Record<string, any>;
  deletedContestIds: string[];
  submissions: Record<string, any>;
  contributions: Record<string, any>;
  deletedContributionIds: string[];
  recordings: Record<string, any>;
  deletedRecordingIds: string[];
  wordOverrides: Record<string, any>;
  deletedWordOverrideIds: string[];
  personalWords: Record<string, Record<string, any>>;
  updatedAtMs: number;
}

function createEmptyStore(): SharedCloudStore {
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

function loadStore(): SharedCloudStore {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(STORE_FILE)) {
      const initial = createEmptyStore();
      fs.writeFileSync(STORE_FILE, JSON.stringify(initial, null, 2), 'utf8');
      return initial;
    }
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      contests:
        parsed?.contests && typeof parsed.contests === 'object'
          ? parsed.contests
          : {},
      deletedContestIds: Array.isArray(parsed?.deletedContestIds)
        ? parsed.deletedContestIds
        : [],
      submissions:
        parsed?.submissions && typeof parsed.submissions === 'object'
          ? parsed.submissions
          : {},
      contributions:
        parsed?.contributions && typeof parsed.contributions === 'object'
          ? parsed.contributions
          : {},
      deletedContributionIds: Array.isArray(parsed?.deletedContributionIds)
        ? parsed.deletedContributionIds
        : [],
      recordings:
        parsed?.recordings && typeof parsed.recordings === 'object'
          ? parsed.recordings
          : {},
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
  } catch (err) {
    console.warn('Initializing fresh shared cloud store:', err);
    return createEmptyStore();
  }
}

const store: SharedCloudStore = loadStore();
let saveTimer: NodeJS.Timeout | null = null;
let hasBackfilledSqlFromDisk = false;

function scheduleSaveStore(): void {
  store.updatedAtMs = Date.now();
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(STORE_FILE, JSON.stringify(store), 'utf8');
    } catch (err) {
      console.error('Failed to persist shared store to disk:', err);
    }
  }, 150);
}

async function syncDiskStoreWithCloudSqlOnRequest(includeAudio: boolean) {
  try {
    if (!hasBackfilledSqlFromDisk) {
      hasBackfilledSqlFromDisk = true;
      const diskContests = Object.values(store.contests);
      const diskSubs = Object.values(store.submissions);
      const diskContribs = Object.values(store.contributions);
      const diskRecordings = Object.values(store.recordings);
      const diskOverrides = Object.values(store.wordOverrides);
      if (diskContests.length > 0) await upsertContestsToSql(diskContests);
      if (diskSubs.length > 0) await upsertSubmissionsToSql(diskSubs);
      if (diskContribs.length > 0) await upsertContributionsToSql(diskContribs);
      if (diskRecordings.length > 0)
        await upsertRecordingsToSql(diskRecordings);
      if (diskOverrides.length > 0)
        await upsertWordOverridesToSql(diskOverrides);
    }

    const sqlData = await fetchAllCloudSqlSyncData(includeAudio);

    for (const delId of sqlData.deletedContestIds) {
      delete store.contests[delId];
      if (!store.deletedContestIds.includes(delId)) {
        store.deletedContestIds.push(delId);
      }
    }
    for (const c of sqlData.contests) {
      const ex = store.contests[c.id];
      if (!ex || (c.updatedAtMs || 0) >= (ex.updatedAtMs || 0)) {
        store.contests[c.id] = c;
      }
    }

    for (const s of sqlData.submissions) {
      const ex = store.submissions[s.id];
      if (!ex || (s.updatedAtMs || 0) >= (ex.updatedAtMs || 0)) {
        store.submissions[s.id] = s;
      }
    }

    for (const delId of sqlData.deletedContributionIds) {
      delete store.contributions[delId];
      if (!store.deletedContributionIds.includes(delId)) {
        store.deletedContributionIds.push(delId);
      }
    }
    for (const ac of sqlData.contributions) {
      const ex = store.contributions[ac.id];
      if (!ex || (ac.updatedAtMs || 0) >= (ex.updatedAtMs || 0)) {
        store.contributions[ac.id] = ac;
      }
    }

    if (includeAudio) {
      for (const delWordId of sqlData.deletedRecordingIds) {
        delete store.recordings[delWordId];
        if (!store.deletedRecordingIds.includes(delWordId)) {
          store.deletedRecordingIds.push(delWordId);
        }
      }
      for (const [wid, rec] of Object.entries(sqlData.recordings)) {
        const ex = store.recordings[wid];
        if (!ex || (rec.updatedAtMs || 0) >= (ex.updatedAtMs || 0)) {
          store.recordings[wid] = rec;
        }
      }
    }

    for (const delWordId of sqlData.deletedWordOverrideIds) {
      delete store.wordOverrides[delWordId];
      if (!store.deletedWordOverrideIds.includes(delWordId)) {
        store.deletedWordOverrideIds.push(delWordId);
      }
    }
    for (const [wid, ov] of Object.entries(sqlData.wordOverrides)) {
      const ex = store.wordOverrides[wid];
      if (!ex || (ov.updatedAtMs || 0) >= (ex.updatedAtMs || 0)) {
        store.wordOverrides[wid] = ov;
      }
    }
  } catch (error) {
    console.warn('Cloud SQL sync fallback to local disk store:', error);
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Enable CORS so Vercel, Netlify, and Android APK clients can also sync directly
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PATCH, DELETE, OPTIONS'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization'
    );
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }
    next();
  });

  // Support base64 audio data URLs up to 15MB
  app.use(express.json({ limit: '15mb' }));

  // Authenticated Cloud SQL user routes
  app.get('/api/users', requireAuth, async (_req: AuthRequest, res) => {
    try {
      const allUsers = await getUsers();
      res.json(allUsers);
    } catch (error: any) {
      console.error('Failed to fetch users:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch users' });
    }
  });

  app.post('/api/users/sync', requireAuth, async (req: AuthRequest, res) => {
    try {
      const uid = req.user?.uid;
      const email = req.user?.email || req.body?.email || '';
      const displayName = req.body?.displayName || req.user?.name || '';
      if (!uid || !email) {
        return res.status(400).json({ error: 'Missing user uid or email' });
      }
      const userRecord = await getOrCreateUser(uid, email, displayName);
      res.json({ ok: true, user: userRecord });
    } catch (error: any) {
      console.error('Failed to sync user:', error);
      res.status(500).json({ error: error.message || 'Failed to sync user' });
    }
  });

  // Health & shared state endpoint backed by Cloud SQL PostgreSQL + local cache
  app.get('/api/sync/state', async (req, res) => {
    const includeAudio = req.query.includeAudio !== 'false';
    await syncDiskStoreWithCloudSqlOnRequest(includeAudio);

    const deletedContestSet = new Set(store.deletedContestIds);
    const contestsList = Object.values(store.contests).filter(
      (c: any) =>
        c && c.id && c.status !== 'cancelled' && !deletedContestSet.has(c.id)
    );
    const submissionsList = Object.values(store.submissions).filter(
      (s: any) => s && s.id && !deletedContestSet.has(s.contestId)
    );
    const deletedContribSet = new Set(store.deletedContributionIds);
    const contributionsList = Object.values(store.contributions).filter(
      (c: any) => c && c.id && !deletedContribSet.has(c.id)
    );
    const deletedRecSet = new Set(store.deletedRecordingIds);
    const recordingsMap: Record<string, any> = {};
    if (includeAudio) {
      for (const [wordId, rec] of Object.entries(store.recordings)) {
        if (rec && !deletedRecSet.has(wordId)) {
          recordingsMap[wordId] = rec;
        }
      }
    }

    const deletedWordOverrideSet = new Set(store.deletedWordOverrideIds);
    const wordOverridesMap: Record<string, any> = {};
    for (const [wordId, ov] of Object.entries(store.wordOverrides)) {
      if (ov && !deletedWordOverrideSet.has(wordId)) {
        wordOverridesMap[wordId] = ov;
      }
    }

    res.json({
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
  });

  // Upsert one or more contests into Cloud SQL PostgreSQL + memory store
  app.post('/api/sync/contests', async (req, res) => {
    const items = Array.isArray(req.body?.contests)
      ? req.body.contests
      : req.body?.contest
      ? [req.body.contest]
      : req.body?.id
      ? [req.body]
      : [];

    const deletedSet = new Set(store.deletedContestIds);
    let count = 0;
    const toSql: any[] = [];

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
        const merged = {
          ...existing,
          ...raw,
          status: 'active',
          updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
        };
        store.contests[raw.id] = merged;
        toSql.push(merged);
        count++;
      }
    }

    if (count > 0) scheduleSaveStore();
    if (toSql.length > 0) {
      try {
        await upsertContestsToSql(toSql);
      } catch (error) {
        console.warn('Cloud SQL contest upsert warning:', error);
      }
    }
    res.json({ ok: true, count });
  });

  // Delete or cancel a contest across all users in Cloud SQL PostgreSQL + memory store
  app.delete('/api/sync/contests/:id', async (req, res) => {
    const contestId = req.params.id;
    if (contestId) {
      delete store.contests[contestId];
      if (!store.deletedContestIds.includes(contestId)) {
        store.deletedContestIds.push(contestId);
        if (store.deletedContestIds.length > 500) {
          store.deletedContestIds = store.deletedContestIds.slice(-500);
        }
      }
      for (const [subId, sub] of Object.entries(store.submissions)) {
        if (sub?.contestId === contestId) {
          delete store.submissions[subId];
        }
      }
      scheduleSaveStore();
      try {
        await markContestDeletedInSql(contestId);
      } catch (error) {
        console.warn('Cloud SQL contest delete warning:', error);
      }
    }
    res.json({ ok: true, deletedId: contestId });
  });

  // Upsert one or more contest submissions into Cloud SQL PostgreSQL + memory store
  app.post('/api/sync/contest-submissions', async (req, res) => {
    const items = Array.isArray(req.body?.submissions)
      ? req.body.submissions
      : req.body?.submission
      ? [req.body.submission]
      : req.body?.id
      ? [req.body]
      : [];

    const statusRank = (st?: string) => {
      if (st === 'completed') return 3;
      if (st === 'in_progress') return 2;
      return 1;
    };

    let count = 0;
    const toSql: any[] = [];
    for (const raw of items) {
      if (!raw || typeof raw.id !== 'string') continue;
      const existing = store.submissions[raw.id];
      if (!existing) {
        const next = {
          ...raw,
          updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
        };
        store.submissions[raw.id] = next;
        toSql.push(next);
        count++;
      } else {
        const incomingRank = statusRank(raw.status);
        const existingRank = statusRank(existing.status);
        if (
          incomingRank > existingRank ||
          (incomingRank === existingRank &&
            (Number(raw.updatedAtMs) || 0) >=
              (Number(existing.updatedAtMs) || 0))
        ) {
          const next = {
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
          store.submissions[raw.id] = next;
          toSql.push(next);
          count++;
        }
      }
    }

    if (count > 0) scheduleSaveStore();
    if (toSql.length > 0) {
      try {
        await upsertSubmissionsToSql(toSql);
      } catch (error) {
        console.warn('Cloud SQL submission upsert warning:', error);
      }
    }
    res.json({ ok: true, count });
  });

  // Upsert user pronunciation contribution(s) into Cloud SQL PostgreSQL + memory store
  app.post('/api/sync/audio-contributions', async (req, res) => {
    const items = Array.isArray(req.body?.contributions)
      ? req.body.contributions
      : req.body?.contribution
      ? [req.body.contribution]
      : req.body?.wordId
      ? [req.body]
      : [];

    let count = 0;
    const toSql: any[] = [];
    for (const raw of items) {
      if (!raw || typeof raw.wordId !== 'string' || !raw.audioDataUrl) continue;
      const nowMs = Date.now();
      const id =
        typeof raw.id === 'string' && raw.id
          ? raw.id
          : `contrib_${raw.wordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}_${nowMs}`;

      store.deletedContributionIds = store.deletedContributionIds.filter(
        (x) => x !== id
      );

      const existing = store.contributions[id];
      const isNewPending = raw.forcePending === true;
      if (
        !existing ||
        isNewPending ||
        (Number(raw.updatedAtMs) || 0) >= (Number(existing.updatedAtMs) || 0)
      ) {
        const next = {
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
          status: isNewPending
            ? 'pending'
            : raw.status || existing?.status || 'pending',
          createdAtMs: isNewPending
            ? nowMs
            : Number(raw.createdAtMs) || existing?.createdAtMs || nowMs,
          updatedAtMs: isNewPending ? nowMs : Number(raw.updatedAtMs) || nowMs,
        };
        store.contributions[id] = next;
        toSql.push({ ...next, forcePending: isNewPending });
        count++;
      }
    }

    if (count > 0) scheduleSaveStore();
    if (toSql.length > 0) {
      try {
        await upsertContributionsToSql(toSql);
      } catch (error) {
        console.warn('Cloud SQL contribution upsert warning:', error);
      }
    }
    res.json({ ok: true, count });
  });

  // Update status (approve / reject) of an audio contribution in Cloud SQL + memory store
  app.patch('/api/sync/audio-contributions/:id', async (req, res) => {
    const id = req.params.id;
    const existing = store.contributions[id];
    if (existing) {
      store.contributions[id] = {
        ...existing,
        ...(req.body?.status ? { status: req.body.status } : {}),
        ...(typeof req.body?.word === 'string' && req.body.word.trim()
          ? { word: req.body.word.trim() }
          : {}),
        ...(req.body?.banglaMeaning !== undefined
          ? { banglaMeaning: req.body.banglaMeaning }
          : {}),
        updatedAtMs: Date.now(),
      };
      scheduleSaveStore();
    }
    try {
      await updateContributionStatusInSql(id, {
        status: req.body?.status,
        word: req.body?.word,
        banglaMeaning: req.body?.banglaMeaning,
      });
    } catch (error) {
      console.warn('Cloud SQL contribution status update warning:', error);
    }
    res.json({ ok: true, item: store.contributions[id] || null });
  });

  // Delete an audio contribution in Cloud SQL + memory store
  app.delete('/api/sync/audio-contributions/:id', async (req, res) => {
    const id = req.params.id;
    if (id) {
      delete store.contributions[id];
      if (!store.deletedContributionIds.includes(id)) {
        store.deletedContributionIds.push(id);
      }
      scheduleSaveStore();
      try {
        await markContributionDeletedInSql(id);
      } catch (error) {
        console.warn('Cloud SQL contribution delete warning:', error);
      }
    }
    res.json({ ok: true, deletedId: id });
  });

  // Upsert General App Audio recording(s) into Cloud SQL + memory store
  app.post('/api/sync/recordings', async (req, res) => {
    const items = Array.isArray(req.body?.recordings)
      ? req.body.recordings
      : req.body?.recording
      ? [req.body.recording]
      : req.body?.wordId
      ? [req.body]
      : [];

    let count = 0;
    const toSql: any[] = [];
    for (const raw of items) {
      if (!raw || typeof raw.wordId !== 'string' || !raw.audioDataUrl) continue;
      store.deletedRecordingIds = store.deletedRecordingIds.filter(
        (x) => x !== raw.wordId
      );
      const existing = store.recordings[raw.wordId];
      if (
        !existing ||
        (Number(raw.updatedAtMs) || 0) >= (Number(existing.updatedAtMs) || 0)
      ) {
        const next = {
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
        store.recordings[raw.wordId] = next;
        toSql.push(next);
        count++;
      }
    }

    if (count > 0) scheduleSaveStore();
    if (toSql.length > 0) {
      try {
        await upsertRecordingsToSql(toSql);
      } catch (error) {
        console.warn('Cloud SQL recording upsert warning:', error);
      }
    }
    res.json({ ok: true, count });
  });

  // Delete a General App Audio recording in Cloud SQL + memory store
  app.delete('/api/sync/recordings/:wordId', async (req, res) => {
    const wordId = req.params.wordId;
    if (wordId) {
      delete store.recordings[wordId];
      if (!store.deletedRecordingIds.includes(wordId)) {
        store.deletedRecordingIds.push(wordId);
      }
      scheduleSaveStore();
      try {
        await markRecordingDeletedInSql(wordId);
      } catch (error) {
        console.warn('Cloud SQL recording delete warning:', error);
      }
    }
    res.json({ ok: true, deletedWordId: wordId });
  });

  // Upsert Admin Global Word Spelling Override(s) into Cloud SQL + memory store
  app.post('/api/sync/word-overrides', async (req, res) => {
    const items = Array.isArray(req.body?.overrides)
      ? req.body.overrides
      : req.body?.override
      ? [req.body.override]
      : req.body?.wordId
      ? [req.body]
      : [];

    let count = 0;
    const toSql: any[] = [];
    for (const raw of items) {
      if (
        !raw ||
        typeof raw.wordId !== 'string' ||
        typeof raw.word !== 'string'
      )
        continue;
      const cleanWord = raw.word.trim().slice(0, 120);
      if (!cleanWord) continue;
      store.deletedWordOverrideIds = store.deletedWordOverrideIds.filter(
        (x) => x !== raw.wordId
      );
      const nowMs = Number(raw.updatedAtMs) || Date.now();
      const next = {
        wordId: raw.wordId,
        word: cleanWord,
        bangla: (raw.bangla ?? '').trim().slice(0, 200),
        updatedBy: (raw.updatedBy || 'Admin').trim().slice(0, 120),
        updatedAtMs: nowMs,
      };
      store.wordOverrides[raw.wordId] = next;
      toSql.push(next);
      if (store.recordings[raw.wordId]) {
        store.recordings[raw.wordId].word = cleanWord;
        if (raw.bangla !== undefined && raw.bangla.trim() !== '') {
          store.recordings[raw.wordId].banglaMeaning = raw.bangla
            .trim()
            .slice(0, 200);
        }
        store.recordings[raw.wordId].updatedAtMs = nowMs;
      }
      count++;
    }

    if (count > 0) scheduleSaveStore();
    if (toSql.length > 0) {
      try {
        await upsertWordOverridesToSql(toSql);
      } catch (error) {
        console.warn('Cloud SQL word override upsert warning:', error);
      }
    }
    res.json({ ok: true, count });
  });

  // Delete (reset) an Admin Global Word Spelling Override in Cloud SQL + memory store
  app.delete('/api/sync/word-overrides/:wordId', async (req, res) => {
    const wordId = req.params.wordId;
    if (wordId) {
      delete store.wordOverrides[wordId];
      if (!store.deletedWordOverrideIds.includes(wordId)) {
        store.deletedWordOverrideIds.push(wordId);
      }
      const originalWord =
        typeof req.query.originalWord === 'string'
          ? req.query.originalWord.trim()
          : '';
      if (originalWord && store.recordings[wordId]) {
        store.recordings[wordId].word = originalWord;
        store.recordings[wordId].updatedAtMs = Date.now();
      }
      scheduleSaveStore();
      try {
        await markWordOverrideDeletedInSql(wordId);
      } catch (error) {
        console.warn('Cloud SQL word override delete warning:', error);
      }
    }
    res.json({ ok: true, deletedWordId: wordId });
  });

  // Get personal struggling words for an account ownerId from Cloud SQL + memory store
  app.get('/api/sync/personal-words/:ownerId', async (req, res) => {
    const ownerId = req.params.ownerId;
    try {
      const sqlWords = await getPersonalWordsByOwnerFromSql(ownerId);
      if (!store.personalWords[ownerId]) {
        store.personalWords[ownerId] = {};
      }
      for (const w of sqlWords) {
        store.personalWords[ownerId][w.wordId] = w;
      }
    } catch (error) {
      console.warn('Cloud SQL personal words fetch warning:', error);
    }
    const bucket = store.personalWords[ownerId] || {};
    res.json({
      ok: true,
      words: Object.values(bucket),
    });
  });

  // Upsert personal struggling words for an account ownerId in Cloud SQL + memory store
  app.post('/api/sync/personal-words', async (req, res) => {
    const items = Array.isArray(req.body?.words)
      ? req.body.words
      : req.body?.word
      ? [req.body.word]
      : req.body?.wordId
      ? [req.body]
      : [];

    let count = 0;
    const toSql: any[] = [];
    for (const raw of items) {
      if (
        !raw ||
        typeof raw.ownerId !== 'string' ||
        typeof raw.wordId !== 'string'
      )
        continue;
      if (!store.personalWords[raw.ownerId]) {
        store.personalWords[raw.ownerId] = {};
      }
      const next = {
        id: raw.id || `${raw.ownerId}_${raw.wordId}`,
        wordId: raw.wordId,
        word: raw.word || raw.wordId,
        bangla: raw.bangla || '',
        example: raw.example || '',
        ownerId: raw.ownerId,
        createdAtMs: Number(raw.createdAtMs) || Date.now(),
        updatedAtMs: Number(raw.updatedAtMs) || Date.now(),
      };
      store.personalWords[raw.ownerId][raw.wordId] = next;
      toSql.push(next);
      count++;
    }

    if (count > 0) scheduleSaveStore();
    if (toSql.length > 0) {
      try {
        await upsertPersonalWordsToSql(toSql);
      } catch (error) {
        console.warn('Cloud SQL personal words upsert warning:', error);
      }
    }
    res.json({ ok: true, count });
  });

  // Delete a personal struggling word for an account ownerId in Cloud SQL + memory store
  app.delete(
    '/api/sync/personal-words/:ownerId/:wordId',
    async (req, res) => {
      const { ownerId, wordId } = req.params;
      if (ownerId && wordId) {
        if (store.personalWords[ownerId]) {
          delete store.personalWords[ownerId][wordId];
          scheduleSaveStore();
        }
        try {
          await markPersonalWordDeletedInSql(ownerId, wordId);
        } catch (error) {
          console.warn('Cloud SQL personal word delete warning:', error);
        }
      }
      res.json({ ok: true });
    }
  );

  // Server-side relay proxy (/api/sync/relay) so client IPs are never blocked by ntfy.sh rate limits
  const RELAY_HUB_URL = 'https://ntfy.sh/lw_sync_hub_12193dcd_v5';
  let relayLinesCache: string[] = [];
  let relayLastFetchMs = 0;

  app.post('/api/sync/relay', async (req, res) => {
    const rawEvent =
      typeof req.body?.rawEvent === 'string' ? req.body.rawEvent : '';
    if (!rawEvent) {
      res.status(400).json({ ok: false });
      return;
    }
    relayLinesCache.push(
      JSON.stringify({
        event: 'message',
        time: Math.floor(Date.now() / 1000),
        message: rawEvent,
      })
    );
    if (relayLinesCache.length > 400) {
      relayLinesCache = relayLinesCache.slice(-400);
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
    res.json({ ok: true });
  });

  app.get('/api/sync/relay', async (_req, res) => {
    const now = Date.now();
    if (now - relayLastFetchMs > 5000 || relayLinesCache.length === 0) {
      try {
        const upstream = await fetch(`${RELAY_HUB_URL}/json?poll=1&since=all`, {
          cache: 'no-store',
        });
        if (upstream.ok) {
          const text = await upstream.text();
          relayLinesCache = text
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-400);
          relayLastFetchMs = now;
        }
      } catch {
        // ignore
      }
    }
    res.json({ ok: true, lines: relayLinesCache });
  });

  // Vite middleware for development or static serving for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
