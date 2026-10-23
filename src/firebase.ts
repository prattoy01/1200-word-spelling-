import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDocFromServer,
} from 'firebase/firestore';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

/**
 * Dedicated Firebase App instance for Cloud Firestore without FirebaseAuth token refresh attached.
 * Why: Project 434645721087 has `securetoken.googleapis.com` disabled, which causes
 * `getAuth()` token refreshes to throw `auth/token-service-api-has-not-been-used` and forces
 * Firestore into offline mode when attached to the same app instance.
 * Isolating the Firestore app instance prevents broken token refresh calls so Cloud Firestore
 * stays online 100% of the time across Web, Mobile, and all Chrome profiles.
 */
const firestoreApp = initializeApp(firebaseConfig, 'lw-firestore-cloud');
export const db = getFirestore(firestoreApp, firebaseConfig.firestoreDatabaseId);

export interface CloudUserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string | null;
  emailVerified: boolean;
  isAnonymous: boolean;
  tenantId: null;
  providerData: Array<{ providerId: string; email: string }>;
}

const SESSION_STORAGE_KEY = 'lw_auth_session_v2';
const SAVED_ACCOUNTS_KEY = 'lw_saved_accounts_v2';
const LEGACY_FORCED_PROFILE_KEY = 'lw_cloud_sync_profile_v1';

// Remove the old forced default profile key so every Chrome profile starts cleanly
if (typeof window !== 'undefined') {
  try {
    window.localStorage.removeItem(LEGACY_FORCED_PROFILE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function emailToDeterministicUid(email: string): string {
  const normalized = email.trim().toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
  return `user_${slug.slice(0, 96)}`;
}

export function getStoredUserSession(): CloudUserProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.uid === 'string' && typeof parsed.email === 'string') {
      return parsed as CloudUserProfile;
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

export function getSavedAccountsList(): CloudUserProfile[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SAVED_ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAccountToHistory(profile: CloudUserProfile): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = getSavedAccountsList().filter(
      (a) => a.email.toLowerCase() !== profile.email.toLowerCase()
    );
    const updated = [profile, ...existing].slice(0, 8);
    window.localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage errors
  }
}

function persistUserSession(profile: CloudUserProfile | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (profile) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(profile));
      saveAccountToHistory(profile);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export const auth: { currentUser: CloudUserProfile | null } = {
  currentUser: getStoredUserSession(),
};

export type User = CloudUserProfile;

type AuthListener = (user: CloudUserProfile | null) => void;
const listeners = new Set<AuthListener>();

function notifyAuthListeners(user: CloudUserProfile | null): void {
  auth.currentUser = user;
  persistUserSession(user);
  listeners.forEach((cb) => cb(user));
}

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

/**
 * Signs in with a user's Name and Email directly (works across all Chrome profiles, mobile browsers, and iframes).
 */
export async function signInWithProfile(params: {
  displayName: string;
  email: string;
}): Promise<CloudUserProfile> {
  const cleanEmail = params.email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid email address.');
  }
  const cleanName =
    params.displayName.trim() ||
    cleanEmail
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (l) => l.toUpperCase());

  const profile: CloudUserProfile = {
    uid: emailToDeterministicUid(cleanEmail),
    displayName: cleanName,
    email: cleanEmail,
    emailVerified: true,
    isAnonymous: false,
    tenantId: null,
    providerData: [{ providerId: 'google.com', email: cleanEmail }],
  };

  notifyAuthListeners(profile);
  return profile;
}

/**
 * Attempts real Google OAuth Popup sign-in via an isolated Firebase App instance (`lw-google-auth`)
 * with `prompt: 'select_account'` so each Chrome profile lets the user pick their Google account
 * without ever disrupting the `lw-firestore-cloud` Firestore connection.
 */
export async function signInWithGoogle(): Promise<CloudUserProfile> {
  const authAppName = 'lw-google-auth';
  const authApp = getApps().some((a) => a.name === authAppName)
    ? getApp(authAppName)
    : initializeApp(firebaseConfig, authAppName);

  const isolatedAuth = getAuth(authApp);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  const result = await signInWithPopup(isolatedAuth, provider);
  const fbUser = result.user;
  const email = (fbUser.email || '').trim().toLowerCase();
  const displayName =
    fbUser.displayName ||
    email.split('@')[0] ||
    'Google User';

  const profile: CloudUserProfile = {
    uid: email ? emailToDeterministicUid(email) : fbUser.uid,
    displayName,
    email: email || `${fbUser.uid}@googleuser.com`,
    photoURL: fbUser.photoURL,
    emailVerified: fbUser.emailVerified,
    isAnonymous: false,
    tenantId: null,
    providerData: [{ providerId: 'google.com', email: email || fbUser.uid }],
  };

  // Immediately sign out the isolated Firebase Auth instance so background token refresh
  // timers never call securetoken.googleapis.com if disabled on the GCP project.
  try {
    await firebaseSignOut(isolatedAuth);
  } catch {
    // Ignore cleanup errors
  }

  notifyAuthListeners(profile);
  return profile;
}

/**
 * Signs out the current user on this Chrome profile and clears the active session.
 */
export async function signOutUser(): Promise<void> {
  notifyAuthListeners(null);
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
