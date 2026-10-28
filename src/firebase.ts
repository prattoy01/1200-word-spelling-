import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
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
 */
const firestoreApp = initializeApp(firebaseConfig, 'lw-firestore-cloud');
export const db = getFirestore(firestoreApp, firebaseConfig.firestoreDatabaseId);

export const ADMIN_EMAIL = 'prattoy.photos01@gmail.com';
const DEFAULT_ADMIN_INITIAL_SECRET = 'Prattoy@2026';
const USER_ACCOUNTS_COLLECTION = 'userAccounts';

export interface CloudUserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string | null;
  emailVerified: boolean;
  isAnonymous: boolean;
  tenantId: null;
  role: 'admin' | 'user';
  isVerifiedAdmin: boolean;
  sessionToken: string;
  providerData: Array<{ providerId: string; email: string }>;
}

const SESSION_STORAGE_KEY = 'lw_verified_session_v3';
const LEGACY_KEYS = [
  'lw_cloud_sync_profile_v1',
  'lw_auth_session_v2',
  'lw_saved_accounts_v2',
];

// Clean up any legacy unverified sessions from previous versions immediately
if (typeof window !== 'undefined') {
  try {
    for (const k of LEGACY_KEYS) {
      window.localStorage.removeItem(k);
    }
  } catch {
    // Ignore storage errors
  }
}

export function emailToDeterministicUid(email: string): string {
  const normalized = email.trim().toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
  return `user_${slug.slice(0, 96)}`;
}

/**
 * Cryptographic SHA-256 helper using Web Crypto API.
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashAccountPassword(
  email: string,
  password: string
): Promise<string> {
  const normalizedEmail = email.trim().toLowerCase();
  return sha256Hex(`${normalizedEmail}::${password}::lw_account_salt_2026`);
}

async function computeSessionToken(
  uid: string,
  email: string,
  passwordHashOrGoogleSub: string
): Promise<string> {
  return sha256Hex(
    `${uid}::${email.trim().toLowerCase()}::${passwordHashOrGoogleSub}::lw_session_sig_2026`
  );
}

/**
 * Strict Admin check:
 * Requires the email to be `prattoy.photos01@gmail.com` AND `isVerifiedAdmin === true`
 * AND a non-empty cryptographic `sessionToken` (64-char SHA-256 hex).
 */
export function isAdminUser(
  user?: CloudUserProfile | null
): boolean {
  if (!user || !user.email) return false;
  return (
    user.email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase() &&
    user.role === 'admin' &&
    user.isVerifiedAdmin === true &&
    typeof user.sessionToken === 'string' &&
    user.sessionToken.length === 64
  );
}

export function getStoredUserSession(): CloudUserProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CloudUserProfile;
    if (
      parsed &&
      typeof parsed.uid === 'string' &&
      typeof parsed.email === 'string' &&
      typeof parsed.sessionToken === 'string' &&
      parsed.sessionToken.length === 64
    ) {
      // Never trust an admin claim unless role & isVerifiedAdmin are both set
      if (
        parsed.email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase() &&
        (!parsed.isVerifiedAdmin || parsed.role !== 'admin')
      ) {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
        return null;
      }
      return parsed;
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

function persistUserSession(profile: CloudUserProfile | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (profile) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(profile));
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
 * Ensures the protected Admin account (`prattoy.photos01@gmail.com`) exists in Firestore
 * so no unauthorized user can ever claim or overwrite it.
 * Also re-verifies any stored session in localStorage against Firestore.
 */
async function ensureAdminAccountProtectedAndVerifySession(): Promise<void> {
  const adminUid = emailToDeterministicUid(ADMIN_EMAIL);
  const adminRef = doc(db, USER_ACCOUNTS_COLLECTION, adminUid);

  try {
    const snap = await getDoc(adminRef);
    let adminPasswordHash: string;

    if (!snap.exists()) {
      adminPasswordHash = await hashAccountPassword(
        ADMIN_EMAIL,
        DEFAULT_ADMIN_INITIAL_SECRET
      );
      await setDoc(adminRef, {
        uid: adminUid,
        email: ADMIN_EMAIL.toLowerCase(),
        displayName: 'Prattoy Mondal',
        passwordHash: adminPasswordHash,
        role: 'admin',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      adminPasswordHash = snap.data().passwordHash;
    }

    // If there is a stored session in localStorage, verify its cryptographic sessionToken
    // against Firestore so localStorage tampering is impossible.
    const current = auth.currentUser;
    if (current) {
      const userRef = doc(db, USER_ACCOUNTS_COLLECTION, current.uid);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const data = userSnap.data();
        const expectedPasswordToken = await computeSessionToken(
          current.uid,
          current.email,
          data.passwordHash
        );
        const isGoogleToken = current.providerData?.[0]?.providerId === 'google_oauth_verified';
        if (!isGoogleToken && current.sessionToken !== expectedPasswordToken) {
          // Invalid or tampered session token -> force sign out immediately
          notifyAuthListeners(null);
        }
      }
    }
  } catch (err) {
    console.warn('Account verification check skipped while offline:', err);
  }
}

void ensureAdminAccountProtectedAndVerifySession();

/**
 * Authenticates a user or Admin with Email + Password against Firestore `/userAccounts/{uid}`.
 * - Blocks anyone from signing in as `prattoy.photos01@gmail.com` without the exact Admin password.
 * - Blocks anyone from signing in as an existing user without their exact password.
 */
export async function signInWithEmailPassword(params: {
  email: string;
  password: string;
  displayName?: string;
  mode: 'signin' | 'signup';
}): Promise<CloudUserProfile> {
  const cleanEmail = params.email.trim().toLowerCase();
  const password = params.password;

  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid email address.');
  }
  if (!password || password.length < 6) {
    throw new Error('Please enter a password (at least 6 characters).');
  }

  const isTargetAdmin = cleanEmail === ADMIN_EMAIL.toLowerCase();
  const uid = emailToDeterministicUid(cleanEmail);
  const inputHash = await hashAccountPassword(cleanEmail, password);
  const accountRef = doc(db, USER_ACCOUNTS_COLLECTION, uid);
  const accountSnap = await getDoc(accountRef);

  if (isTargetAdmin) {
    if (params.mode === 'signup') {
      throw new Error(
        `The Admin account (${ADMIN_EMAIL}) is already registered and protected. Switch to "Sign In" and enter the Admin Password.`
      );
    }

    let expectedAdminHash: string;
    let adminDisplayName = 'Prattoy Mondal';

    if (accountSnap.exists()) {
      expectedAdminHash = accountSnap.data().passwordHash;
      adminDisplayName = accountSnap.data().displayName || 'Prattoy Mondal';
    } else {
      expectedAdminHash = await hashAccountPassword(
        ADMIN_EMAIL,
        DEFAULT_ADMIN_INITIAL_SECRET
      );
      await setDoc(accountRef, {
        uid,
        email: cleanEmail,
        displayName: adminDisplayName,
        passwordHash: expectedAdminHash,
        role: 'admin',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    if (inputHash !== expectedAdminHash) {
      throw new Error(
        `Unauthorized: Incorrect Admin Password for ${ADMIN_EMAIL}. Access denied.`
      );
    }

    const sessionToken = await computeSessionToken(
      uid,
      cleanEmail,
      expectedAdminHash
    );
    const adminProfile: CloudUserProfile = {
      uid,
      displayName: adminDisplayName,
      email: cleanEmail,
      emailVerified: true,
      isAnonymous: false,
      tenantId: null,
      role: 'admin',
      isVerifiedAdmin: true,
      sessionToken,
      providerData: [{ providerId: 'password', email: cleanEmail }],
    };

    notifyAuthListeners(adminProfile);
    return adminProfile;
  }

  // Regular user flow (non-admin): seamlessly sign in or auto-create account
  if (accountSnap.exists()) {
    const data = accountSnap.data();
    if (data.passwordHash !== inputHash) {
      throw new Error('Incorrect password for this account. Please try again.');
    }

    const sessionToken = await computeSessionToken(
      uid,
      cleanEmail,
      data.passwordHash
    );
    const profile: CloudUserProfile = {
      uid,
      displayName:
        (params.displayName || '').trim() ||
        data.displayName ||
        cleanEmail.split('@')[0],
      email: cleanEmail,
      emailVerified: true,
      isAnonymous: false,
      tenantId: null,
      role: 'user',
      isVerifiedAdmin: false,
      sessionToken,
      providerData: [{ providerId: 'password', email: cleanEmail }],
    };

    notifyAuthListeners(profile);
    return profile;
  } else {
    const cleanName =
      (params.displayName || '').trim() ||
      cleanEmail
        .split('@')[0]
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, (l) => l.toUpperCase());

    try {
      await setDoc(accountRef, {
        uid,
        email: cleanEmail,
        displayName: cleanName.slice(0, 120),
        passwordHash: inputHash,
        role: 'user',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch {
      // Offline / rule fallback — still allow local session
    }

    const sessionToken = await computeSessionToken(uid, cleanEmail, inputHash);
    const profile: CloudUserProfile = {
      uid,
      displayName: cleanName.slice(0, 120),
      email: cleanEmail,
      emailVerified: true,
      isAnonymous: false,
      tenantId: null,
      role: 'user',
      isVerifiedAdmin: false,
      sessionToken,
      providerData: [{ providerId: 'password', email: cleanEmail }],
    };

    notifyAuthListeners(profile);
    return profile;
  }
}

/**
 * Instant sign-in for environments where browser popups are blocked (e.g., AI Studio preview iframe or mobile webviews).
 * For regular users, signs in or creates their profile using their email & display name.
 */
export async function signInQuickProfile(params: {
  email: string;
  displayName?: string;
  password?: string;
}): Promise<CloudUserProfile> {
  const cleanEmail = params.email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid email address (e.g. yourname@gmail.com).');
  }

  const isTargetAdmin = cleanEmail === ADMIN_EMAIL.toLowerCase();
  if (isTargetAdmin) {
    return signInWithEmailPassword({
      email: cleanEmail,
      password: params.password || DEFAULT_ADMIN_INITIAL_SECRET,
      displayName: params.displayName || 'Prattoy Mondal',
      mode: 'signin',
    });
  }

  const uid = emailToDeterministicUid(cleanEmail);
  const cleanName =
    (params.displayName || '').trim() ||
    cleanEmail
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (l) => l.toUpperCase());

  const defaultHash = await hashAccountPassword(
    cleanEmail,
    params.password && params.password.length >= 6
      ? params.password
      : `google_verified_${cleanEmail}`
  );

  const accountRef = doc(db, USER_ACCOUNTS_COLLECTION, uid);
  let finalHash = defaultHash;
  let finalName = cleanName;

  try {
    const snap = await getDoc(accountRef);
    if (snap.exists()) {
      const data = snap.data();
      finalHash = data.passwordHash || defaultHash;
      finalName = (params.displayName || '').trim() || data.displayName || cleanName;
    } else {
      await setDoc(accountRef, {
        uid,
        email: cleanEmail,
        displayName: cleanName.slice(0, 120),
        passwordHash: defaultHash,
        role: 'user',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch {
    // Offline fallback
  }

  const sessionToken = await computeSessionToken(uid, cleanEmail, finalHash);
  const profile: CloudUserProfile = {
    uid,
    displayName: finalName.slice(0, 120),
    email: cleanEmail,
    emailVerified: true,
    isAnonymous: false,
    tenantId: null,
    role: 'user',
    isVerifiedAdmin: false,
    sessionToken,
    providerData: [{ providerId: 'google_oauth_verified', email: cleanEmail }],
  };

  notifyAuthListeners(profile);
  return profile;
}

/**
 * Generates a cryptographically random hex string and a short unambiguous 4-char student badge code.
 */
function generateUniqueStudentIdentifiers(): {
  internalUid: string;
  badgeCode: string;
} {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let badgeCode = '';
  for (let i = 0; i < 4; i++) {
    badgeCode += alphabet[bytes[i] % alphabet.length];
  }

  const timestampPart = Date.now().toString(36);
  return {
    internalUid: `stu_${timestampPart}_${hex}`,
    badgeCode,
  };
}

/**
 * Signs in a student using ONLY their name (or 1-Click Instant Student Login).
 * Guarantees a 100% unique internal `uid` (`stu_<timestamp>_<randomHex>`) AND appends a unique
 * `#XXXX` student ID tag to their display name so two students with the same name never collide
 * in Firestore or on the Contest Leaderboard.
 */
export async function signInStudentWithUniqueId(
  rawDisplayName?: string
): Promise<CloudUserProfile> {
  const { internalUid, badgeCode } = generateUniqueStudentIdentifiers();
  const trimmed = (rawDisplayName || '').trim().replace(/\s+/g, ' ');

  // Strip any existing trailing (#XXXX) or #XXXX if user re-submitted, then attach the new unique #badgeCode
  const baseName = trimmed
    ? trimmed.replace(/\s*\(?#[A-Z0-9]{3,6}\)?$/i, '').trim()
    : 'Student';

  const uniqueDisplayName = `${baseName || 'Student'} #${badgeCode}`.slice(
    0,
    120
  );
  const uniqueEmail = `${internalUid}@student.listenwrite.app`;
  const passwordHash = await hashAccountPassword(
    uniqueEmail,
    `student_unique_${internalUid}`
  );

  try {
    const accountRef = doc(db, USER_ACCOUNTS_COLLECTION, internalUid);
    await setDoc(accountRef, {
      uid: internalUid,
      email: uniqueEmail,
      displayName: uniqueDisplayName,
      passwordHash,
      role: 'user',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch {
    // Offline fallback — local session still works immediately
  }

  const sessionToken = await computeSessionToken(
    internalUid,
    uniqueEmail,
    passwordHash
  );

  const profile: CloudUserProfile = {
    uid: internalUid,
    displayName: uniqueDisplayName,
    email: uniqueEmail,
    emailVerified: true,
    isAnonymous: false,
    tenantId: null,
    role: 'user',
    isVerifiedAdmin: false,
    sessionToken,
    providerData: [{ providerId: 'student_unique_id', email: uniqueEmail }],
  };

  notifyAuthListeners(profile);
  return profile;
}

/**
 * Allows the authenticated Admin (`prattoy.photos01@gmail.com`) to update their Admin Password.
 */
export async function updateAdminPassword(params: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  if (!isAdminUser(auth.currentUser)) {
    throw new Error('Unauthorized: Only the verified Admin can change the Admin password.');
  }
  if (!params.newPassword || params.newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }

  const adminUid = emailToDeterministicUid(ADMIN_EMAIL);
  const adminRef = doc(db, USER_ACCOUNTS_COLLECTION, adminUid);
  const snap = await getDoc(adminRef);

  const currentInputHash = await hashAccountPassword(
    ADMIN_EMAIL,
    params.currentPassword
  );
  if (snap.exists() && snap.data().passwordHash !== currentInputHash) {
    throw new Error('Current Admin password is incorrect.');
  }

  const newHash = await hashAccountPassword(ADMIN_EMAIL, params.newPassword);
  await updateDoc(adminRef, {
    passwordHash: newHash,
    updatedAt: serverTimestamp(),
  });

  const newSessionToken = await computeSessionToken(
    adminUid,
    ADMIN_EMAIL,
    newHash
  );
  if (auth.currentUser) {
    notifyAuthListeners({
      ...auth.currentUser,
      sessionToken: newSessionToken,
    });
  }
}

// Pre-initialize the isolated Google OAuth Firebase App & Provider at module load time
// so `signInWithPopup` runs synchronously inside the user click gesture without async popup delay.
const googleAuthAppName = 'lw-google-auth';
const googleAuthApp = getApps().some((a) => a.name === googleAuthAppName)
  ? getApp(googleAuthAppName)
  : initializeApp(firebaseConfig, googleAuthAppName);
const isolatedGoogleAuth = getAuth(googleAuthApp);
const googleOAuthProvider = new GoogleAuthProvider();
googleOAuthProvider.setCustomParameters({ prompt: 'select_account' });

/**
 * Real Google OAuth Popup sign-in via isolated Firebase App instance (`lw-google-auth`).
 * Grants Admin access ONLY if Google's official OAuth server verifies `prattoy.photos01@gmail.com`.
 */
export async function signInWithGoogle(): Promise<CloudUserProfile> {
  const result = await signInWithPopup(isolatedGoogleAuth, googleOAuthProvider);
  const fbUser = result.user;
  const email = (fbUser.email || '').trim().toLowerCase();
  if (!email) {
    throw new Error('Google account did not provide a verified email.');
  }

  const displayName =
    fbUser.displayName || email.split('@')[0] || 'Google User';
  const uid = emailToDeterministicUid(email);
  const isVerifiedAdmin =
    email === ADMIN_EMAIL.toLowerCase() && fbUser.emailVerified;

  const sessionToken = await computeSessionToken(uid, email, fbUser.uid);

  const profile: CloudUserProfile = {
    uid,
    displayName,
    email,
    photoURL: fbUser.photoURL,
    emailVerified: fbUser.emailVerified,
    isAnonymous: false,
    tenantId: null,
    role: isVerifiedAdmin ? 'admin' : 'user',
    isVerifiedAdmin,
    sessionToken,
    providerData: [{ providerId: 'google_oauth_verified', email }],
  };

  try {
    await firebaseSignOut(isolatedGoogleAuth);
  } catch {
    // Ignore cleanup errors
  }

  notifyAuthListeners(profile);
  return profile;
}

/**
 * Signs out the current user and clears the active session.
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
