import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  initializeFirestore,
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
 * Dedicated Firebase App instance for Cloud Firestore with long-polling enabled
 * so real-time listeners (Contests, Submissions, Recordings) work reliably across
 * desktop browsers, mobile carrier networks, and Android APK WebViews.
 */
const firestoreApp = initializeApp(firebaseConfig, 'lw-firestore-cloud');
export const db = initializeFirestore(
  firestoreApp,
  {
    experimentalForceLongPolling: true,
  },
  firebaseConfig.firestoreDatabaseId
);

export const ADMIN_EMAIL = 'prattoy.photos01@gmail.com';
const DEFAULT_ADMIN_INITIAL_SECRET = 'Prattoy@2026';
const USER_ACCOUNTS_COLLECTION = 'userAccounts';

/**
 * Primary Cloud Sync Mode:
 * By default, high-frequency collections (Contests, Leaderboard Submissions, Audio Contributions,
 * General Recordings, and Word Overrides) use our built-in `/api/sync` Cloud Server + Global Relay
 * instead of opening 6 simultaneous Firestore `onSnapshot` collection listeners on every page load
 * (which previously consumed ~500 Firestore document reads per refresh and hit the 50,000/day free limit).
 */
export const USE_FIRESTORE_COLLECTION_LISTENERS = false;
const FIRESTORE_QUOTA_COOLDOWN_KEY = 'lw_firestore_quota_exhausted_until_v1';

export function isFirestoreQuotaExhausted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const until = Number(
      window.localStorage.getItem(FIRESTORE_QUOTA_COOLDOWN_KEY) || '0'
    );
    return until > Date.now();
  } catch {
    return false;
  }
}

export function markFirestoreQuotaExhausted(error?: unknown): void {
  if (typeof window === 'undefined') return;
  const msg = error instanceof Error ? error.message : String(error || '');
  if (
    !error ||
    msg.includes('Quota limit exceeded') ||
    msg.includes('resource-exhausted')
  ) {
    try {
      // Pause Firestore requests for 60 minutes when daily quota is exhausted
      window.localStorage.setItem(
        FIRESTORE_QUOTA_COOLDOWN_KEY,
        String(Date.now() + 60 * 60 * 1000)
      );
    } catch {
      // ignore
    }
  }
}

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
 * Pure-JS SHA-256 fallback for environments (like file:// WebViews) where crypto.subtle may be restricted.
 */
function sha256PureJs(ascii: string): string {
  function rightRotate(value: number, amount: number) {
    return (value >>> amount) | (value << (32 - amount));
  }
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let result = '';
  const words: number[] = [];
  const utf8 = unescape(encodeURIComponent(ascii));
  const asciiBitLength = utf8.length * 8;

  let hash: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;

  const isComposite: Record<number, number> = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = 0; i < 313; i += candidate) {
        isComposite[i] = candidate;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  let str = utf8 + '\x80';
  while ((str.length % 64) - 56) str += '\x00';
  for (let i = 0; i < str.length; i++) {
    const j = str.charCodeAt(i);
    words[i >> 2] |= j << ((3 - (i % 4)) * 8);
  }
  words[words.length] = (asciiBitLength / maxWord) | 0;
  words[words.length] = asciiBitLength;

  for (let j = 0; j < words.length; ) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash.slice(0);
    hash = hash.slice(0, 8);

    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const a = hash[0];
      const e = hash[4];
      const temp1 =
        hash[7] +
        (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
        ((e & hash[5]) ^ (~e & hash[6])) +
        k[i] +
        (w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] +
                (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                w[i - 7] +
                (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
              0);
      const temp2 =
        (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
        ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));

      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
    }

    for (let i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }

  for (let i = 0; i < 8; i++) {
    for (let j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? 0 : '') + b.toString(16);
    }
  }
  return result;
}

/**
 * Cryptographic SHA-256 helper using Web Crypto API with pure-JS fallback for Android WebViews.
 */
async function sha256Hex(input: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      const encoder = new TextEncoder();
      const data = encoder.encode(input);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Fallback to pure JS SHA-256
  }
  return sha256PureJs(input);
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
    `${uid}::${email.trim().toLowerCase()}::${passwordHashOrGoogleSub}::lw_session_sig_2026_strict_v2`
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

const SESSION_VERSION_KEY = 'lw_session_strict_v2';

export function getStoredUserSession(): CloudUserProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    // Invalidate any legacy session created before strict admin password enforcement
    if (window.localStorage.getItem(SESSION_VERSION_KEY) !== '1') {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      window.localStorage.setItem(SESSION_VERSION_KEY, '1');
      return null;
    }
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
    window.localStorage.setItem(SESSION_VERSION_KEY, '1');
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

const ADMIN_CUSTOM_PWD_STORAGE_KEY = 'lw_admin_custom_pwd_hash_v1';

/**
 * Ensures the protected Admin account (`prattoy.photos01@gmail.com`) exists in Firestore
 * when online, without ever force-signing-out an active Admin session during quota/offline states.
 */
async function ensureAdminAccountProtectedAndVerifySession(): Promise<void> {
  if (!USE_FIRESTORE_COLLECTION_LISTENERS || isFirestoreQuotaExhausted()) {
    return;
  }
  const adminUid = emailToDeterministicUid(ADMIN_EMAIL);
  const adminRef = doc(db, USER_ACCOUNTS_COLLECTION, adminUid);

  try {
    const snap = await getDoc(adminRef);
    if (!snap.exists()) {
      const adminPasswordHash = await hashAccountPassword(
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
      const data = snap.data();
      if (data?.passwordHash && typeof window !== 'undefined') {
        window.localStorage.setItem(
          ADMIN_CUSTOM_PWD_STORAGE_KEY,
          data.passwordHash
        );
      }
    }
  } catch (err) {
    markFirestoreQuotaExhausted(err);
    console.warn('Account verification check skipped while offline/quota:', err);
  }
}

void ensureAdminAccountProtectedAndVerifySession();

/**
 * Direct Admin sign-in for `prattoy.photos01@gmail.com`.
 * Strictly requires a non-empty, valid Admin password matching the Admin account hash.
 */
export async function signInAsAdminDirect(
  passwordInput?: string
): Promise<CloudUserProfile> {
  const cleanEmail = ADMIN_EMAIL.toLowerCase();
  const uid = emailToDeterministicUid(cleanEmail);
  const trimmedPassword = (passwordInput || '').trim();

  if (!trimmedPassword) {
    throw new Error(
      'Admin Password is required. Nobody can sign in as Admin without the password.'
    );
  }

  let customLocalHash: string | null = null;
  try {
    customLocalHash =
      typeof window !== 'undefined'
        ? window.localStorage.getItem(ADMIN_CUSTOM_PWD_STORAGE_KEY)
        : null;
  } catch {
    // ignore
  }

  const inputHash = await hashAccountPassword(cleanEmail, trimmedPassword);
  const defaultAdminHash = await hashAccountPassword(
    cleanEmail,
    DEFAULT_ADMIN_INITIAL_SECRET
  );

  let firestorePasswordHash: string | null = null;
  try {
    const accountRef = doc(db, USER_ACCOUNTS_COLLECTION, uid);
    const snap = await Promise.race([
      getDoc(accountRef),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (snap && snap.exists()) {
      const data = snap.data();
      if (typeof data?.passwordHash === 'string' && data.passwordHash.length > 0) {
        firestorePasswordHash = data.passwordHash;
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(
            ADMIN_CUSTOM_PWD_STORAGE_KEY,
            firestorePasswordHash
          );
        }
      }
    }
  } catch {
    // Firestore quota or offline fallback — verify against local/default hash below
  }

  const authoritativeHash =
    firestorePasswordHash || customLocalHash || defaultAdminHash;

  // Accept either the authoritative stored hash OR the default initial admin secret if no custom password was set
  const isAuthorized =
    inputHash === authoritativeHash ||
    (!firestorePasswordHash && !customLocalHash && inputHash === defaultAdminHash);

  if (!isAuthorized) {
    throw new Error('Incorrect Admin Password. Access denied.');
  }

  const finalHash = authoritativeHash;

  try {
    const accountRef = doc(db, USER_ACCOUNTS_COLLECTION, uid);
    await setDoc(
      accountRef,
      {
        uid,
        email: cleanEmail,
        displayName: 'Prattoy Mondal',
        passwordHash: finalHash,
        role: 'admin',
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch {
    // Firestore quota or offline fallback — proceed with verified local session
  }

  const sessionToken = await computeSessionToken(uid, cleanEmail, finalHash);
  const adminProfile: CloudUserProfile = {
    uid,
    displayName: 'Prattoy Mondal',
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

/**
 * Authenticates a user or Admin with Email + Password against Firestore `/userAccounts/{uid}`.
 * Resilient to Firestore quota/offline states.
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

  const isTargetAdmin = cleanEmail === ADMIN_EMAIL.toLowerCase();
  if (isTargetAdmin) {
    return signInAsAdminDirect(password);
  }

  if (!password || password.length < 6) {
    throw new Error('Please enter a password (at least 6 characters).');
  }

  const uid = emailToDeterministicUid(cleanEmail);
  const inputHash = await hashAccountPassword(cleanEmail, password);
  const accountRef = doc(db, USER_ACCOUNTS_COLLECTION, uid);

  let existingData: { passwordHash?: string; displayName?: string } | null =
    null;
  try {
    const accountSnap = await getDoc(accountRef);
    if (accountSnap.exists()) {
      existingData = accountSnap.data() as {
        passwordHash?: string;
        displayName?: string;
      };
    }
  } catch {
    // Offline / quota fallback: proceed with deterministic local session
  }

  if (existingData && existingData.passwordHash) {
    if (existingData.passwordHash !== inputHash) {
      throw new Error('Incorrect password for this account. Please try again.');
    }

    const sessionToken = await computeSessionToken(
      uid,
      cleanEmail,
      existingData.passwordHash
    );
    const profile: CloudUserProfile = {
      uid,
      displayName:
        (params.displayName || '').trim() ||
        existingData.displayName ||
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
    return signInAsAdminDirect(params.password);
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
  const newHash = await hashAccountPassword(ADMIN_EMAIL, params.newPassword);

  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ADMIN_CUSTOM_PWD_STORAGE_KEY, newHash);
    }
  } catch {
    // ignore
  }

  try {
    const adminRef = doc(db, USER_ACCOUNTS_COLLECTION, adminUid);
    const snap = await getDoc(adminRef);
    if (snap.exists()) {
      await updateDoc(adminRef, {
        passwordHash: newHash,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(adminRef, {
        uid: adminUid,
        email: ADMIN_EMAIL.toLowerCase(),
        displayName: 'Prattoy Mondal',
        passwordHash: newHash,
        role: 'admin',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch {
    // Firestore quota or offline fallback — saved locally above
  }

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
): void {
  const errMsg = error instanceof Error ? error.message : String(error);
  const isQuotaOrOffline =
    errMsg.includes('Quota limit exceeded') ||
    errMsg.includes('resource-exhausted') ||
    errMsg.includes('client is offline') ||
    errMsg.includes('unavailable');

  if (isQuotaOrOffline) {
    markFirestoreQuotaExhausted(error);
    console.warn(
      `[Cloud Sync Cache Mode] Firestore ${operationType} on "${path}" using local cache (quota/offline):`,
      errMsg
    );
    return;
  }

  const errInfo: FirestoreErrorInfo = {
    error: errMsg,
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
  console.warn('Firestore Operation Notice: ', JSON.stringify(errInfo));
}

