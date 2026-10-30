import { eq, and } from 'drizzle-orm';
import { db } from './index.ts';
import {
  contests,
  contestSubmissions,
  audioContributions,
  recordings,
  wordOverrides,
  personalWords,
} from './schema.ts';

function statusRank(st?: string): number {
  if (st === 'completed') return 3;
  if (st === 'in_progress') return 2;
  return 1;
}

export async function fetchAllCloudSqlSyncData(includeAudio = true) {
  try {
    const [
      allContests,
      allSubs,
      allContribs,
      allRecordings,
      allWordOverrides,
    ] = await Promise.all([
      db.select().from(contests),
      db.select().from(contestSubmissions),
      db.select().from(audioContributions),
      includeAudio ? db.select().from(recordings) : Promise.resolve([]),
      db.select().from(wordOverrides),
    ]);

    const deletedContestIds: string[] = [];
    const activeContests = [];
    for (const c of allContests) {
      if (c.status === 'cancelled' || c.status === 'deleted') {
        deletedContestIds.push(c.id);
      } else {
        let parsedCategories: string[] = [];
        try {
          parsedCategories = JSON.parse(c.categoriesJson || '[]');
        } catch {
          parsedCategories = [];
        }
        activeContests.push({
          id: c.id,
          title: c.title,
          creatorId: c.creatorId,
          creatorName: c.creatorName,
          pageFilter: c.pageFilter as 'page1' | 'page2' | 'all',
          categories: Array.isArray(parsedCategories) ? parsedCategories : [],
          wordCount: c.wordCount,
          baseSeconds: c.baseSeconds,
          showBangla: c.showBangla,
          startTimeMs: Number(c.startTimeMs),
          durationMinutes: c.durationMinutes,
          randomSeed: c.randomSeed,
          status: 'active' as const,
          createdAtMs: Number(c.createdAtMs),
          updatedAtMs: Number(c.updatedAtMs),
        });
      }
    }

    const deletedContestSet = new Set(deletedContestIds);
    const activeSubmissions = [];
    for (const s of allSubs) {
      if (deletedContestSet.has(s.contestId)) continue;
      let parsedResults = undefined;
      try {
        const arr = JSON.parse(s.resultsJson || '[]');
        if (Array.isArray(arr) && arr.length > 0) {
          parsedResults = arr;
        }
      } catch {
        parsedResults = undefined;
      }
      activeSubmissions.push({
        id: s.id,
        contestId: s.contestId,
        userId: s.userId,
        userName: s.userName,
        userEmail: s.userEmail,
        status: s.status as 'registered' | 'in_progress' | 'completed',
        totalWords: s.totalWords,
        correctCount: s.correctCount,
        accuracy: s.accuracy,
        timeTakenMs: s.timeTakenMs,
        ...(parsedResults ? { results: parsedResults } : {}),
        createdAtMs: Number(s.createdAtMs),
        updatedAtMs: Number(s.updatedAtMs),
      });
    }

    const deletedContributionIds: string[] = [];
    const activeContributions = [];
    for (const ac of allContribs) {
      if (ac.status === 'deleted') {
        deletedContributionIds.push(ac.id);
      } else {
        activeContributions.push({
          id: ac.id,
          wordId: ac.wordId,
          word: ac.word,
          banglaMeaning: ac.banglaMeaning,
          audioDataUrl: ac.audioDataUrl,
          mimeType: ac.mimeType,
          fileName: ac.fileName,
          fileSize: ac.fileSize,
          durationMs: ac.durationMs,
          contributorId: ac.contributorId,
          contributorName: ac.contributorName,
          status: ac.status as 'pending' | 'approved' | 'rejected',
          createdAtMs: Number(ac.createdAtMs),
          updatedAtMs: Number(ac.updatedAtMs),
        });
      }
    }

    const deletedRecordingIds: string[] = [];
    const recordingsMap: Record<string, any> = {};
    for (const rec of allRecordings) {
      if (rec.status === 'deleted') {
        deletedRecordingIds.push(rec.wordId);
      } else {
        recordingsMap[rec.wordId] = {
          wordId: rec.wordId,
          word: rec.word,
          banglaMeaning: rec.banglaMeaning,
          audioDataUrl: rec.audioDataUrl,
          mimeType: rec.mimeType,
          fileName: rec.fileName,
          fileSize: rec.fileSize,
          durationMs: rec.durationMs,
          ownerId: rec.ownerId,
          ownerName: rec.ownerName,
          status: 'published',
          updatedAtMs: Number(rec.updatedAtMs),
        };
      }
    }

    const deletedWordOverrideIds: string[] = [];
    const wordOverridesMap: Record<string, any> = {};
    for (const ov of allWordOverrides) {
      if (ov.status === 'deleted') {
        deletedWordOverrideIds.push(ov.wordId);
      } else {
        wordOverridesMap[ov.wordId] = {
          wordId: ov.wordId,
          word: ov.word,
          bangla: ov.bangla,
          updatedBy: ov.updatedBy,
          updatedAtMs: Number(ov.updatedAtMs),
        };
      }
    }

    return {
      contests: activeContests,
      deletedContestIds,
      submissions: activeSubmissions,
      contributions: activeContributions,
      deletedContributionIds,
      recordings: recordingsMap,
      deletedRecordingIds,
      wordOverrides: wordOverridesMap,
      deletedWordOverrideIds,
    };
  } catch (error) {
    throw new Error('Failed to load sync state from Cloud SQL.', {
      cause: error,
    });
  }
}

export async function upsertContestsToSql(items: any[]): Promise<void> {
  try {
    for (const raw of items) {
      if (!raw || typeof raw.id !== 'string') continue;
      const nowMs = Date.now();
      const status = raw.status === 'cancelled' ? 'cancelled' : 'active';
      const categoriesJson = JSON.stringify(
        Array.isArray(raw.categories) ? raw.categories : []
      );
      await db
        .insert(contests)
        .values({
          id: raw.id,
          title: String(raw.title || 'IELTS Live Spelling Contest'),
          creatorId: String(raw.creatorId || 'user'),
          creatorName: String(raw.creatorName || 'Setter'),
          pageFilter: String(raw.pageFilter || 'all'),
          categoriesJson,
          wordCount: Number(raw.wordCount) || 15,
          baseSeconds: Number(raw.baseSeconds) || 12,
          showBangla: Boolean(raw.showBangla),
          startTimeMs: Number(raw.startTimeMs) || nowMs,
          durationMinutes: Number(raw.durationMinutes) || 30,
          randomSeed: String(raw.randomSeed || 'seed'),
          status,
          createdAtMs: Number(raw.createdAtMs) || nowMs,
          updatedAtMs: Number(raw.updatedAtMs) || nowMs,
        })
        .onConflictDoUpdate({
          target: contests.id,
          set: {
            title: String(raw.title || 'IELTS Live Spelling Contest'),
            pageFilter: String(raw.pageFilter || 'all'),
            categoriesJson,
            wordCount: Number(raw.wordCount) || 15,
            baseSeconds: Number(raw.baseSeconds) || 12,
            showBangla: Boolean(raw.showBangla),
            startTimeMs: Number(raw.startTimeMs) || nowMs,
            durationMinutes: Number(raw.durationMinutes) || 30,
            status,
            updatedAtMs: Number(raw.updatedAtMs) || nowMs,
          },
        });
    }
  } catch (error) {
    throw new Error('Failed to upsert contests in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function markContestDeletedInSql(contestId: string): Promise<void> {
  try {
    const nowMs = Date.now();
    await db
      .insert(contests)
      .values({
        id: contestId,
        title: 'Deleted Contest',
        creatorId: 'admin',
        creatorName: 'Admin',
        pageFilter: 'all',
        categoriesJson: '[]',
        wordCount: 10,
        baseSeconds: 12,
        showBangla: false,
        startTimeMs: nowMs,
        durationMinutes: 30,
        randomSeed: 'deleted',
        status: 'cancelled',
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      })
      .onConflictDoUpdate({
        target: contests.id,
        set: {
          status: 'cancelled',
          updatedAtMs: nowMs,
        },
      });
  } catch (error) {
    throw new Error('Failed to mark contest deleted in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function upsertSubmissionsToSql(items: any[]): Promise<void> {
  try {
    for (const raw of items) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.contestId !== 'string')
        continue;
      const existingRows = await db
        .select()
        .from(contestSubmissions)
        .where(eq(contestSubmissions.id, raw.id));
      const existing = existingRows[0];
      const nowMs = Date.now();

      if (existing) {
        const inRank = statusRank(raw.status);
        const exRank = statusRank(existing.status);
        if (
          inRank < exRank ||
          (inRank === exRank &&
            (Number(raw.updatedAtMs) || 0) < Number(existing.updatedAtMs || 0))
        ) {
          continue;
        }
      }

      const resultsJson =
        Array.isArray(raw.results) && raw.results.length > 0
          ? JSON.stringify(raw.results)
          : existing?.resultsJson || '[]';

      await db
        .insert(contestSubmissions)
        .values({
          id: raw.id,
          contestId: raw.contestId,
          userId: String(raw.userId || ''),
          userName: String(raw.userName || 'Participant'),
          userEmail: String(raw.userEmail || ''),
          status: String(raw.status || 'registered'),
          totalWords: Number(raw.totalWords) || 15,
          correctCount: Number(raw.correctCount) || 0,
          accuracy: Number(raw.accuracy) || 0,
          timeTakenMs: Number(raw.timeTakenMs) || 0,
          resultsJson,
          createdAtMs:
            Number(existing?.createdAtMs) || Number(raw.createdAtMs) || nowMs,
          updatedAtMs: Number(raw.updatedAtMs) || nowMs,
        })
        .onConflictDoUpdate({
          target: contestSubmissions.id,
          set: {
            userName: String(raw.userName || 'Participant'),
            status: String(raw.status || 'registered'),
            totalWords: Number(raw.totalWords) || 15,
            correctCount: Number(raw.correctCount) || 0,
            accuracy: Number(raw.accuracy) || 0,
            timeTakenMs: Number(raw.timeTakenMs) || 0,
            resultsJson,
            updatedAtMs: Number(raw.updatedAtMs) || nowMs,
          },
        });
    }
  } catch (error) {
    throw new Error('Failed to upsert contest submissions in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function upsertContributionsToSql(items: any[]): Promise<void> {
  try {
    for (const raw of items) {
      if (!raw || typeof raw.wordId !== 'string' || !raw.audioDataUrl) continue;
      const nowMs = Date.now();
      const id =
        typeof raw.id === 'string' && raw.id
          ? raw.id
          : `contrib_${raw.wordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}_${nowMs}`;
      const isNewPending = raw.forcePending === true;
      const status = isNewPending
        ? 'pending'
        : String(raw.status || 'pending');

      await db
        .insert(audioContributions)
        .values({
          id,
          wordId: raw.wordId,
          word: String(raw.word || raw.wordId),
          banglaMeaning: String(raw.banglaMeaning || ''),
          audioDataUrl: String(raw.audioDataUrl),
          mimeType: String(raw.mimeType || 'audio/wav'),
          fileName: String(raw.fileName || `${raw.wordId}.wav`),
          fileSize: Number(raw.fileSize) || 1024,
          durationMs: Number(raw.durationMs) || 1200,
          contributorId: String(raw.contributorId || 'community_user'),
          contributorName: String(raw.contributorName || 'Community Member'),
          status,
          createdAtMs: Number(raw.createdAtMs) || nowMs,
          updatedAtMs: Number(raw.updatedAtMs) || nowMs,
        })
        .onConflictDoUpdate({
          target: audioContributions.id,
          set: {
            word: String(raw.word || raw.wordId),
            banglaMeaning: String(raw.banglaMeaning || ''),
            audioDataUrl: String(raw.audioDataUrl),
            status,
            updatedAtMs: Number(raw.updatedAtMs) || nowMs,
          },
        });
    }
  } catch (error) {
    throw new Error('Failed to upsert audio contributions in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function updateContributionStatusInSql(
  id: string,
  updates: { status?: string; word?: string; banglaMeaning?: string }
): Promise<void> {
  try {
    const existingRows = await db
      .select()
      .from(audioContributions)
      .where(eq(audioContributions.id, id));
    const existing = existingRows[0];
    if (!existing) return;

    await db
      .update(audioContributions)
      .set({
        status: updates.status || existing.status,
        word: updates.word ? updates.word.trim() : existing.word,
        banglaMeaning:
          updates.banglaMeaning !== undefined
            ? updates.banglaMeaning
            : existing.banglaMeaning,
        updatedAtMs: Date.now(),
      })
      .where(eq(audioContributions.id, id));
  } catch (error) {
    throw new Error('Failed to update audio contribution in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function markContributionDeletedInSql(id: string): Promise<void> {
  try {
    await db
      .update(audioContributions)
      .set({ status: 'deleted', updatedAtMs: Date.now() })
      .where(eq(audioContributions.id, id));
  } catch (error) {
    throw new Error('Failed to delete audio contribution in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function upsertRecordingsToSql(items: any[]): Promise<void> {
  try {
    for (const raw of items) {
      if (!raw || typeof raw.wordId !== 'string' || !raw.audioDataUrl) continue;
      const nowMs = Date.now();
      await db
        .insert(recordings)
        .values({
          wordId: raw.wordId,
          word: String(raw.word || raw.wordId),
          banglaMeaning: String(raw.banglaMeaning || ''),
          audioDataUrl: String(raw.audioDataUrl),
          mimeType: String(raw.mimeType || 'audio/mpeg'),
          fileName: String(raw.fileName || `${raw.wordId}.mp3`),
          fileSize: Number(raw.fileSize) || 1024,
          durationMs: Number(raw.durationMs) || 1200,
          ownerId: String(raw.ownerId || 'admin_general_audio'),
          ownerName: String(raw.ownerName || 'General App Audio'),
          status: 'published',
          updatedAtMs: Number(raw.updatedAtMs) || nowMs,
        })
        .onConflictDoUpdate({
          target: recordings.wordId,
          set: {
            word: String(raw.word || raw.wordId),
            banglaMeaning: String(raw.banglaMeaning || ''),
            audioDataUrl: String(raw.audioDataUrl),
            mimeType: String(raw.mimeType || 'audio/mpeg'),
            fileName: String(raw.fileName || `${raw.wordId}.mp3`),
            fileSize: Number(raw.fileSize) || 1024,
            durationMs: Number(raw.durationMs) || 1200,
            ownerId: String(raw.ownerId || 'admin_general_audio'),
            ownerName: String(raw.ownerName || 'General App Audio'),
            status: 'published',
            updatedAtMs: Number(raw.updatedAtMs) || nowMs,
          },
        });
    }
  } catch (error) {
    throw new Error('Failed to upsert recordings in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function markRecordingDeletedInSql(wordId: string): Promise<void> {
  try {
    await db
      .update(recordings)
      .set({ status: 'deleted', updatedAtMs: Date.now() })
      .where(eq(recordings.wordId, wordId));
  } catch (error) {
    throw new Error('Failed to delete recording in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function upsertWordOverridesToSql(items: any[]): Promise<void> {
  try {
    for (const raw of items) {
      if (
        !raw ||
        typeof raw.wordId !== 'string' ||
        typeof raw.word !== 'string'
      )
        continue;
      const nowMs = Number(raw.updatedAtMs) || Date.now();
      await db
        .insert(wordOverrides)
        .values({
          wordId: raw.wordId,
          word: raw.word.trim().slice(0, 120),
          bangla: String(raw.bangla || '').trim().slice(0, 200),
          updatedBy: String(raw.updatedBy || 'Admin').trim().slice(0, 120),
          status: 'published',
          updatedAtMs: nowMs,
        })
        .onConflictDoUpdate({
          target: wordOverrides.wordId,
          set: {
            word: raw.word.trim().slice(0, 120),
            bangla: String(raw.bangla || '').trim().slice(0, 200),
            updatedBy: String(raw.updatedBy || 'Admin').trim().slice(0, 120),
            status: 'published',
            updatedAtMs: nowMs,
          },
        });
    }
  } catch (error) {
    throw new Error('Failed to upsert word overrides in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function markWordOverrideDeletedInSql(
  wordId: string
): Promise<void> {
  try {
    await db
      .update(wordOverrides)
      .set({ status: 'deleted', updatedAtMs: Date.now() })
      .where(eq(wordOverrides.wordId, wordId));
  } catch (error) {
    throw new Error('Failed to delete word override in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function getPersonalWordsByOwnerFromSql(ownerId: string) {
  try {
    const rows = await db
      .select()
      .from(personalWords)
      .where(
        and(
          eq(personalWords.ownerId, ownerId),
          eq(personalWords.status, 'active')
        )
      );
    return rows.map((r) => ({
      id: r.id,
      wordId: r.wordId,
      word: r.word,
      bangla: r.bangla,
      example: r.example,
      ownerId: r.ownerId,
      createdAtMs: Number(r.createdAtMs),
      updatedAtMs: Number(r.updatedAtMs),
    }));
  } catch (error) {
    throw new Error('Failed to fetch personal words from Cloud SQL.', {
      cause: error,
    });
  }
}

export async function upsertPersonalWordsToSql(items: any[]): Promise<void> {
  try {
    for (const raw of items) {
      if (
        !raw ||
        typeof raw.ownerId !== 'string' ||
        typeof raw.wordId !== 'string'
      )
        continue;
      const nowMs = Date.now();
      const id = raw.id || `${raw.ownerId}_${raw.wordId}`;
      await db
        .insert(personalWords)
        .values({
          id,
          wordId: raw.wordId,
          word: String(raw.word || raw.wordId),
          bangla: String(raw.bangla || ''),
          example: String(raw.example || ''),
          ownerId: raw.ownerId,
          status: 'active',
          createdAtMs: Number(raw.createdAtMs) || nowMs,
          updatedAtMs: Number(raw.updatedAtMs) || nowMs,
        })
        .onConflictDoUpdate({
          target: personalWords.id,
          set: {
            word: String(raw.word || raw.wordId),
            bangla: String(raw.bangla || ''),
            example: String(raw.example || ''),
            status: 'active',
            updatedAtMs: Number(raw.updatedAtMs) || nowMs,
          },
        });
    }
  } catch (error) {
    throw new Error('Failed to upsert personal words in Cloud SQL.', {
      cause: error,
    });
  }
}

export async function markPersonalWordDeletedInSql(
  ownerId: string,
  wordId: string
): Promise<void> {
  try {
    await db
      .update(personalWords)
      .set({ status: 'deleted', updatedAtMs: Date.now() })
      .where(
        and(
          eq(personalWords.ownerId, ownerId),
          eq(personalWords.wordId, wordId)
        )
      );
  } catch (error) {
    throw new Error('Failed to delete personal word in Cloud SQL.', {
      cause: error,
    });
  }
}
