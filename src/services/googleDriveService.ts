/**
 * Google Drive Storage Engine for Global Pronunciation Audio (Admin-Only Write, Public Zero-Login Read).
 *
 * - Only the verified Admin connects Google Drive (`https://www.googleapis.com/auth/drive.file`).
 * - Admin uploads/updates audio files into a dedicated `"ListenWrite-Global-Audio"` folder in their Drive
 *   and sets each file to public read-only (`type: "anyone", role: "reader"`).
 * - Lightweight metadata (`audioDataUrl: "gdrive://<fileId>"`) syncs via Firestore / Cloud SQL / Delta-Sync (~200 bytes/word).
 * - Students listen with ZERO Google login or OAuth prompts via public Drive API + CORS-clean proxy + IndexedDB offline cache.
 */

import firebaseConfig from '../../firebase-applet-config.json';
import { getAdminDriveAccessToken, disconnectAdminGoogleDrive } from '../firebase';
import {
  CANONICAL_CLOUD_RUN_ORIGIN,
  getMirrorSyncOrigins,
} from '../utils/cloudRelay';

export const DRIVE_AUDIO_PREFIX = 'gdrive://';
const GLOBAL_AUDIO_FOLDER_NAME = 'ListenWrite-Global-Audio';
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

let cachedGlobalFolderId: string | null = null;
const inFlightDriveAudioFetches = new Map<string, Promise<string | null>>();

export function isDriveAudioRef(audioRef?: string | null): boolean {
  return Boolean(audioRef && audioRef.startsWith(DRIVE_AUDIO_PREFIX));
}

export function extractDriveFileId(audioRef?: string | null): string | null {
  if (!audioRef || !audioRef.startsWith(DRIVE_AUDIO_PREFIX)) return null;
  const raw = audioRef.slice(DRIVE_AUDIO_PREFIX.length).trim();
  return /^[a-zA-Z0-9_-]{10,128}$/.test(raw) ? raw : null;
}

export function buildDriveAudioRef(fileId: string): string {
  return `${DRIVE_AUDIO_PREFIX}${fileId.trim()}`;
}

function dataUrlToBinaryParts(dataUrl: string): {
  bytes: Uint8Array;
  mimeType: string;
} {
  const parts = dataUrl.split(',');
  const header = parts[0] || '';
  const base64 = parts[1] || '';
  const mimeMatch = header.match(/data:([^;]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'audio/mpeg';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { bytes, mimeType };
}

function blobToAudioDataUrl(blob: Blob, fallbackMime = 'audio/mpeg'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const res = reader.result;
        if (res.startsWith('data:application/octet-stream')) {
          resolve(res.replace('data:application/octet-stream', `data:${fallbackMime}`));
        } else {
          resolve(res);
        }
      } else {
        reject(new Error('Failed to read Drive audio blob.'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to convert Drive audio blob.'));
    reader.readAsDataURL(blob);
  });
}

async function handleDriveApiResponse(res: Response, action: string): Promise<Response> {
  if (res.status === 401) {
    disconnectAdminGoogleDrive();
    throw new Error(
      `Admin Google Drive session expired during ${action}. Please click "Connect Admin Google Drive" again.`
    );
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Google Drive ${action} failed (${res.status}): ${errText.slice(0, 180) || res.statusText}`
    );
  }
  return res;
}

/**
 * Ensures the `"ListenWrite-Global-Audio"` folder exists in the Admin's Google Drive
 * and returns its folderId.
 */
export async function ensureAdminDriveGlobalFolder(
  accessToken: string
): Promise<string> {
  if (cachedGlobalFolderId) {
    try {
      const checkRes = await fetch(
        `${DRIVE_FILES_API}/${encodeURIComponent(cachedGlobalFolderId)}?fields=id,trashed`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (checkRes.ok) {
        const meta = await checkRes.json();
        if (meta?.id && !meta.trashed) {
          return cachedGlobalFolderId;
        }
      }
    } catch {
      // Re-resolve below
    }
    cachedGlobalFolderId = null;
  }

  const query = encodeURIComponent(
    `name='${GLOBAL_AUDIO_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const searchRes = await handleDriveApiResponse(
    await fetch(`${DRIVE_FILES_API}?q=${query}&fields=files(id,name)&pageSize=5`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    'folder lookup'
  );
  const searchJson = await searchRes.json();
  if (Array.isArray(searchJson?.files) && searchJson.files[0]?.id) {
    cachedGlobalFolderId = searchJson.files[0].id;
    return cachedGlobalFolderId!;
  }

  const createRes = await handleDriveApiResponse(
    await fetch(`${DRIVE_FILES_API}?fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: GLOBAL_AUDIO_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        description:
          'Listen & Write IELTS Spelling Global Pronunciation Audio (Public Read-Only for Students)',
      }),
    }),
    'folder creation'
  );
  const created = await createRes.json();
  if (!created?.id) {
    throw new Error('Google Drive did not return a folder ID.');
  }
  cachedGlobalFolderId = created.id;

  // Allow read-only public access on folder so files inside resolve cleanly for students
  await fetch(
    `${DRIVE_FILES_API}/${encodeURIComponent(created.id)}/permissions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    }
  ).catch(() => {});

  return created.id;
}

/**
 * Uploads or updates a single word's Global Audio file in the Admin's Google Drive,
 * sets it to public read-only (`anyone -> reader`), and returns its `fileId` + `gdrive://<fileId>` ref.
 */
export async function uploadWordAudioToAdminDrive(params: {
  wordId: string;
  word: string;
  audioDataUrl: string;
  mimeType?: string;
  fileName?: string;
  accessToken?: string | null;
}): Promise<{ fileId: string; driveRef: string }> {
  const token = params.accessToken || getAdminDriveAccessToken();
  if (!token) {
    throw new Error('Admin Google Drive is not connected.');
  }
  if (!params.audioDataUrl || !params.audioDataUrl.startsWith('data:')) {
    throw new Error('Audio binary data URL is required to upload to Google Drive.');
  }

  const safeWordId = params.wordId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  const folderId = await ensureAdminDriveGlobalFolder(token);
  const { bytes, mimeType: detectedMime } = dataUrlToBinaryParts(params.audioDataUrl);
  const finalMime = params.mimeType || detectedMime || 'audio/mpeg';
  const ext = finalMime.includes('wav')
    ? 'wav'
    : finalMime.includes('ogg')
    ? 'ogg'
    : finalMime.includes('webm')
    ? 'webm'
    : 'mp3';
  const driveFileName = `${safeWordId}.${ext}`;

  // Check if an audio file for this wordId already exists inside our global folder
  const findQuery = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and appProperties has { key='wordId' and value='${safeWordId}' }`
  );
  const findRes = await fetch(
    `${DRIVE_FILES_API}?q=${findQuery}&fields=files(id,name)&pageSize=5`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch(() => null);

  let existingFileId: string | null = null;
  if (findRes?.ok) {
    const findJson = await findRes.json().catch(() => null);
    if (Array.isArray(findJson?.files) && findJson.files[0]?.id) {
      existingFileId = findJson.files[0].id;
    }
  }

  let fileId: string;

  if (existingFileId) {
    // Update existing Drive file content cleanly
    const patchRes = await handleDriveApiResponse(
      await fetch(
        `${DRIVE_UPLOAD_API}/${encodeURIComponent(existingFileId)}?uploadType=media&fields=id`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': finalMime,
          },
          body: new Blob([bytes.buffer as ArrayBuffer], { type: finalMime }),
        }
      ),
      'audio file update'
    );
    const patched = await patchRes.json();
    fileId = patched?.id || existingFileId;
  } else {
    // Create new Drive file with multipart upload (metadata + audio bytes)
    const metadata = {
      name: driveFileName,
      parents: [folderId],
      mimeType: finalMime,
      description: `Listen & Write IELTS pronunciation for "${params.word}"`,
      appProperties: {
        app: 'ListenWrite',
        wordId: safeWordId,
      },
    };

    const form = new FormData();
    form.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' })
    );
    form.append(
      'file',
      new Blob([bytes.buffer as ArrayBuffer], { type: finalMime }),
      driveFileName
    );

    const uploadRes = await handleDriveApiResponse(
      await fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: form,
      }),
      'audio file upload'
    );
    const uploaded = await uploadRes.json();
    if (!uploaded?.id) {
      throw new Error('Google Drive upload did not return a file ID.');
    }
    fileId = uploaded.id;
  }

  // Ensure anyone with link (all students without login) can read/stream this file
  await fetch(`${DRIVE_FILES_API}/${encodeURIComponent(fileId)}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      role: 'reader',
      type: 'anyone',
    }),
  }).catch(() => {});

  return {
    fileId,
    driveRef: buildDriveAudioRef(fileId),
  };
}

/**
 * Deletes an audio file from the Admin's Google Drive when Admin deletes a Global Audio.
 */
export async function deleteWordAudioFromAdminDrive(
  fileId: string,
  accessToken?: string | null
): Promise<boolean> {
  const token = accessToken || getAdminDriveAccessToken();
  if (!token || !fileId) return false;
  try {
    const res = await fetch(
      `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * Public zero-login student download: fetches a public Admin Google Drive audio file
 * via CORS-safe `/api/sync/drive-audio/:fileId` proxy or direct Drive API key fallback
 * and returns a browser-playable `data:audio/...` URL (which is then cached in IndexedDB).
 */
export async function fetchDriveAudioAsDataUrl(
  audioRefOrFileId: string,
  preferredMime = 'audio/mpeg'
): Promise<string | null> {
  const fileId = extractDriveFileId(audioRefOrFileId) || (
    /^[a-zA-Z0-9_-]{10,128}$/.test(audioRefOrFileId) ? audioRefOrFileId : null
  );
  if (!fileId || typeof window === 'undefined') return null;

  const existing = inFlightDriveAudioFetches.get(fileId);
  if (existing) return existing;

  const task = (async () => {
    const isFileProtocol = window.location?.protocol === 'file:';
    const candidateUrls: string[] = [];

    if (!isFileProtocol) {
      candidateUrls.push(`/api/sync/drive-audio/${encodeURIComponent(fileId)}`);
    }
    candidateUrls.push(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        fileId
      )}?alt=media&key=${encodeURIComponent(firebaseConfig.apiKey)}`
    );
    for (const mirrorBase of getMirrorSyncOrigins()) {
      candidateUrls.push(
        `${mirrorBase}/api/sync/drive-audio/${encodeURIComponent(fileId)}`
      );
    }
    if (!candidateUrls.some((u) => u.startsWith(CANONICAL_CLOUD_RUN_ORIGIN))) {
      candidateUrls.push(
        `${CANONICAL_CLOUD_RUN_ORIGIN}/api/sync/drive-audio/${encodeURIComponent(
          fileId
        )}`
      );
    }

    for (const url of candidateUrls) {
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 7000);
        const res = await fetch(url, { mode: 'cors', signal: controller.signal });
        window.clearTimeout(timer);
        if (!res.ok) continue;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html') || ct.includes('application/json')) continue;
        const blob = await res.blob();
        if (!blob || blob.size < 150) continue;
        const detectedMime =
          ct && ct.startsWith('audio/')
            ? ct.split(';')[0]
            : blob.type && blob.type.startsWith('audio/')
            ? blob.type
            : preferredMime;
        return await blobToAudioDataUrl(blob, detectedMime);
      } catch {
        // Try next URL
      }
    }
    return null;
  })().finally(() => {
    inFlightDriveAudioFetches.delete(fileId);
  });

  inFlightDriveAudioFetches.set(fileId, task);
  return task;
}
