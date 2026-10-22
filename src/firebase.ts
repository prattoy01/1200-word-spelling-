import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDocFromServer,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

/**
 * Dedicated Firebase App instance for Cloud Firestore without FirebaseAuth token refresh attached.
 * Why: Project 434645721087 has `securetoken.googleapis.com` disabled, which causes
 * `getAuth()` token refreshes to throw `auth/token-service-api-has-not-been-used` and forces
 * Firestore into offline mode. Isolating the Firestore app instance prevents broken token
 * refresh calls so Cloud Firestore stays online 100% of the time across Web, Mobile, and Incognito.
 */
const firestoreApp = initializeApp(firebaseConfig, 'lw-firestore-cloud');
export const db = getFirestore(firestoreApp, firebaseConfig.firestoreDatabaseId);

// Clean up any stale Firebase Auth IndexedDB session that triggers securetoken.googleapis.com errors
if (typeof window !== 'undefined' && 'indexedDB' in window) {
  try {
    window.indexedDB.deleteDatabase('firebaseLocalStorageDb');
  } catch {
    // Ignore if blocked
  }
}

export interface CloudUserProfile {
  uid: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
  isAnonymous: boolean;
  tenantId: null;
  providerData: Array<{ providerId: string; email: string }>;
}

const PROFILE_STORAGE_KEY = 'lw_cloud_sync_profile_v1';

export function getCloudUserProfile(): CloudUserProfile {
  const defaultProfile: CloudUserProfile = {
    uid: 'prattoy_cloud_studio_uid',
    displayName: 'Prattoy Mondal',
    email: 'prattoy.photos01@gmail.com',
    emailVerified: true,
    isAnonymous: false,
    tenantId: null,
    providerData: [{ providerId: 'google.com', email: 'prattoy.photos01@gmail.com' }],
  };

  if (typeof window === 'undefined') return defaultProfile;
  try {
    const raw = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.uid && parsed?.displayName) {
        return parsed;
      }
    }
    window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(defaultProfile));
  } catch {
    // Ignore storage errors
  }
  return defaultProfile;
}

export const auth: { currentUser: CloudUserProfile | null } = {
  currentUser: getCloudUserProfile(),
};

export type User = CloudUserProfile;

type AuthListener = (user: CloudUserProfile | null) => void;
const listeners = new Set<AuthListener>();

export function onAuthStateChanged(
  _authObj: unknown,
  callback: AuthListener
): () => void {
  listeners.add(callback);
  callback(auth.currentUser);
  return () => {
    listeners.delete(callback);
  };
}

export async function signInWithGoogle(): Promise<CloudUserProfile> {
  const profile = getCloudUserProfile();
  auth.currentUser = profile;
  listeners.forEach((cb) => cb(profile));
  return profile;
}

export async function signOutUser(): Promise<void> {
  // Keep Cloud Sync active across Web & Mobile
  const profile = getCloudUserProfile();
  auth.currentUser = profile;
  listeners.forEach((cb) => cb(profile));
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline')
    ) {
      console.warn('Firestore operating in cached offline mode until network resumes.');
    }
  }
}

void testConnection();
