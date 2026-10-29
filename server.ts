import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

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

let store: SharedCloudStore = loadStore();
let saveTimer: NodeJS.Timeout | null = null;

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

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Support base64 audio data URLs up to 15MB
  app.use(express.json({ limit: '15mb' }));

  // Health & shared state endpoint for real-time cross-user synchronization
  app.get('/api/sync/state', (req, res) => {
    const includeAudio = req.query.includeAudio !== 'false';
    const deletedContestSet = new Set(store.deletedContestIds);
    const contestsList = Object.values(store.contests).filter(
      (c: any) => c && c.id && c.status !== 'cancelled' && !deletedContestSet.has(c.id)
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
    });
  });

  // Upsert one or more contests
  app.post('/api/sync/contests', (req, res) => {
    const items = Array.isArray(req.body?.contests)
      ? req.body.contests
      : req.body?.contest
      ? [req.body.contest]
      : req.body?.id
      ? [req.body]
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

    if (count > 0) scheduleSaveStore();
    res.json({ ok: true, count });
  });

  // Delete or cancel a contest across all users
  app.delete('/api/sync/contests/:id', (req, res) => {
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
    }
    res.json({ ok: true, deletedId: contestId });
  });

  // Upsert one or more contest submissions (registration, in_progress, completed)
  app.post('/api/sync/contest-submissions', (req, res) => {
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
        // Never downgrade a submission from completed -> in_progress -> registered
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

    if (count > 0) scheduleSaveStore();
    res.json({ ok: true, count });
  });

  // Upsert user pronunciation contribution(s) to Admin Panel
  app.post('/api/sync/audio-contributions', (req, res) => {
    const items = Array.isArray(req.body?.contributions)
      ? req.body.contributions
      : req.body?.contribution
      ? [req.body.contribution]
      : req.body?.wordId
      ? [req.body]
      : [];

    let count = 0;
    for (const raw of items) {
      if (!raw || typeof raw.wordId !== 'string' || !raw.audioDataUrl) continue;
      const id =
        typeof raw.id === 'string' && raw.id
          ? raw.id
          : `pending_${raw.wordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}`;

      store.deletedContributionIds = store.deletedContributionIds.filter((x) => x !== id);

      const existing = store.contributions[id];
      const nowMs = Date.now();
      // If a user explicitly submits a new pending contribution, or if this record is newer, store it
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

    if (count > 0) scheduleSaveStore();
    res.json({ ok: true, count });
  });

  // Update status (approve / reject) of an audio contribution
  app.patch('/api/sync/audio-contributions/:id', (req, res) => {
    const id = req.params.id;
    const existing = store.contributions[id];
    if (existing) {
      store.contributions[id] = {
        ...existing,
        ...(req.body?.status ? { status: req.body.status } : {}),
        ...(req.body?.banglaMeaning !== undefined
          ? { banglaMeaning: req.body.banglaMeaning }
          : {}),
        updatedAtMs: Date.now(),
      };
      scheduleSaveStore();
    }
    res.json({ ok: true, item: store.contributions[id] || null });
  });

  // Delete an audio contribution
  app.delete('/api/sync/audio-contributions/:id', (req, res) => {
    const id = req.params.id;
    if (id) {
      delete store.contributions[id];
      if (!store.deletedContributionIds.includes(id)) {
        store.deletedContributionIds.push(id);
      }
      scheduleSaveStore();
    }
    res.json({ ok: true, deletedId: id });
  });

  // Upsert General App Audio recording(s) (Admin approved)
  app.post('/api/sync/recordings', (req, res) => {
    const items = Array.isArray(req.body?.recordings)
      ? req.body.recordings
      : req.body?.recording
      ? [req.body.recording]
      : req.body?.wordId
      ? [req.body]
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

    if (count > 0) scheduleSaveStore();
    res.json({ ok: true, count });
  });

  // Delete a General App Audio recording
  app.delete('/api/sync/recordings/:wordId', (req, res) => {
    const wordId = req.params.wordId;
    if (wordId) {
      delete store.recordings[wordId];
      if (!store.deletedRecordingIds.includes(wordId)) {
        store.deletedRecordingIds.push(wordId);
      }
      scheduleSaveStore();
    }
    res.json({ ok: true, deletedWordId: wordId });
  });

  // Get personal struggling words for an account ownerId
  app.get('/api/sync/personal-words/:ownerId', (req, res) => {
    const ownerId = req.params.ownerId;
    const bucket = store.personalWords[ownerId] || {};
    res.json({
      ok: true,
      words: Object.values(bucket),
    });
  });

  // Upsert personal struggling words for an account ownerId
  app.post('/api/sync/personal-words', (req, res) => {
    const items = Array.isArray(req.body?.words)
      ? req.body.words
      : req.body?.word
      ? [req.body.word]
      : req.body?.wordId
      ? [req.body]
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

    if (count > 0) scheduleSaveStore();
    res.json({ ok: true, count });
  });

  // Delete a personal struggling word for an account ownerId
  app.delete('/api/sync/personal-words/:ownerId/:wordId', (req, res) => {
    const { ownerId, wordId } = req.params;
    if (ownerId && wordId && store.personalWords[ownerId]) {
      delete store.personalWords[ownerId][wordId];
      scheduleSaveStore();
    }
    res.json({ ok: true });
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
