import React, { useState, useRef } from 'react';
import {
  X,
  LogIn,
  LogOut,
  UserCheck,
  Mail,
  Lock,
  User as UserIcon,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  UserPlus,
  Zap,
} from 'lucide-react';
import {
  type User,
  ADMIN_EMAIL,
  signInWithGoogle,
  signInWithEmailPassword,
  signInQuickProfile,
  signInStudentWithUniqueId,
  signInAsAdminDirect,
  signOutUser,
} from '../firebase';

interface SignInModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: User | null;
  onSignedIn: (user: User) => void;
  onSignedOut: () => void;
}

export const SignInModal: React.FC<SignInModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onSignedIn,
  onSignedOut,
}) => {
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingGoogle, setIsLoadingGoogle] = useState(false);
  const [quickGoogleMode, setQuickGoogleMode] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const isTypingAdminEmail =
    email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();

  const handleGooglePopup = async () => {
    setErrorMsg(null);

    // For non-admin emails (or if admin password was explicitly entered), allow direct profile sign-in
    if (email.trim().includes('@') && (!isTypingAdminEmail || password.trim().length > 0)) {
      setIsLoadingGoogle(true);
      try {
        const profile = await signInQuickProfile({
          email,
          displayName,
          password,
        });
        setPassword('');
        onSignedIn(profile);
        onClose();
        return;
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : 'Could not sign in with this email.'
        );
        setIsLoadingGoogle(false);
        return;
      }
    }

    setIsLoadingGoogle(true);
    try {
      const profile = await signInWithGoogle();
      setPassword('');
      onSignedIn(profile);
      onClose();
    } catch {
      // Browser/iframe blocked popup or third-party cookies ->
      // Switch smoothly to Instant In-Page Google Email Sign-In (no popup required)
      setQuickGoogleMode(true);
      setErrorMsg(
        isTypingAdminEmail
          ? 'Google OAuth popup was blocked. Please enter your Admin Password above to sign in as Admin.'
          : null
      );
      setTimeout(() => {
        emailInputRef.current?.focus();
      }, 50);
    } finally {
      setIsLoadingGoogle(false);
    }
  };

  const handleQuickGuestParticipant = async () => {
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      // Always creates a 100% unique internal UID (`stu_<timestamp>_<randomHex>`) and unique `#XXXX` name tag
      const profile = await signInStudentWithUniqueId(displayName);
      onSignedIn(profile);
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Quick sign-in failed.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      let profile: User;
      // If a student submitted ONLY their name (without typing an email), generate a guaranteed unique Student ID
      if (!email.trim() && displayName.trim()) {
        profile = await signInStudentWithUniqueId(displayName);
      } else if (!isTypingAdminEmail && (quickGoogleMode || password.trim().length < 6)) {
        profile = await signInQuickProfile({
          email,
          displayName,
          password,
        });
      } else {
        profile = await signInWithEmailPassword({
          email,
          password,
          displayName,
          mode: isTypingAdminEmail ? 'signin' : authMode,
        });
      }
      setPassword('');
      onSignedIn(profile);
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Authentication failed.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await signOutUser();
    setPassword('');
    onSignedOut();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-[#0d1f18] border border-[#1d3d2f] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#183327] flex items-center justify-between bg-[#0a1712]">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-xl bg-[#10b981]/15 border border-[#10b981]/40 flex items-center justify-center text-[#10b981]">
              <UserCheck className="w-4 h-4" />
            </span>
            <div>
              <h3 className="text-base font-bold text-white">
                {currentUser
                  ? 'Account & Switch User'
                  : 'Sign In to Listen & Write'}
              </h3>
              <p className="text-[11px] text-[#7ea090]">
                Syncs your contests, personal words &amp; progress across devices
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-[#132a20] text-[#9bb8aa] hover:text-white flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[84vh] overflow-y-auto">
          {/* Active User Banner (if signed in) */}
          {currentUser && (
            <div className="p-3.5 rounded-xl bg-[#0a1712] border border-[#1f4735] flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#10b981] shrink-0" />
                  <span className="text-xs font-bold text-white truncate">
                    {currentUser.displayName}
                  </span>
                  {currentUser.isVerifiedAdmin && (
                    <span className="px-1.5 py-0.5 rounded bg-[#10b981]/20 border border-[#10b981]/40 text-[10px] font-bold text-[#10b981]">
                      ADMIN
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-[#7ea090] truncate mt-0.5">
                  {currentUser.email}
                </p>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="px-3 py-1.5 rounded-lg bg-[#2a1215] border border-[#5c2026] text-xs font-bold text-[#fda4af] hover:bg-[#3b171b] transition-colors flex items-center gap-1.5 shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          )}

          {/* Mode Toggle: Sign In vs Create Account */}
          <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#07120e] border border-[#183327]">
            <button
              type="button"
              onClick={() => {
                setAuthMode('signin');
                setQuickGoogleMode(false);
                setErrorMsg(null);
              }}
              className={`py-2 px-3 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 ${
                authMode === 'signin'
                  ? 'bg-[#10b981] text-[#04120c]'
                  : 'text-[#8ca89a] hover:text-white'
              }`}
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Sign In</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthMode('signup');
                setQuickGoogleMode(false);
                setErrorMsg(null);
              }}
              className={`py-2 px-3 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 ${
                authMode === 'signup'
                  ? 'bg-[#10b981] text-[#04120c]'
                  : 'text-[#8ca89a] hover:text-white'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Create Account</span>
            </button>
          </div>

          {quickGoogleMode && (
            <div className="p-3 rounded-xl bg-[#0e291e] border border-[#10b981]/50 text-xs text-[#a7f3d0] flex items-start gap-2">
              <Sparkles className="w-4 h-4 text-[#10b981] shrink-0 mt-0.5" />
              <span>
                <strong>Direct In-Page Google Sign-In Active:</strong> Browser popup windows are restricted here, so simply type your <strong>Gmail / Email address</strong> below and click <strong>Sign In</strong>!
              </span>
            </div>
          )}

          {errorMsg && (
            <div className="p-3 rounded-xl bg-[#2a1215] border border-[#5c2026] text-xs text-[#fda4af] flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-[#f43f5e] shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {isTypingAdminEmail && (
            <div className="p-3 rounded-xl bg-[#0e291e] border border-[#10b981]/40 text-xs text-[#a7f3d0] flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-[#10b981] shrink-0 mt-0.5" />
              <span>
                <strong>Protected Admin Account:</strong> Entering{' '}
                <code className="font-mono">{ADMIN_EMAIL}</code> verifies your{' '}
                <strong>Admin Password</strong>.
              </span>
            </div>
          )}

          {/* Email & Password / Student Name Form */}
          <form onSubmit={handleFormSubmit} className="space-y-3.5">
            {!isTypingAdminEmail && (
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9bb8aa] mb-1.5">
                  Student / Participant Name (Auto-Generates Unique #ID)
                </label>
                <div className="relative">
                  <UserIcon className="w-4 h-4 text-[#5e8070] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Rahat Ahmed (gets unique #ID automatically)"
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#07120e] border border-[#1d3d2f] text-sm text-white placeholder-[#527062] focus:outline-none focus:border-[#10b981]"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9bb8aa] mb-1.5">
                Email / Gmail Address{' '}
                {displayName.trim() && !isTypingAdminEmail ? (
                  <span className="text-[#10b981] font-normal normal-case">
                    (Optional if entering Student Name above)
                  </span>
                ) : null}
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-[#5e8070] absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  ref={emailInputRef}
                  type="email"
                  required={!displayName.trim() || isTypingAdminEmail}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. yourname@gmail.com (or leave blank for Name-Only)"
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#07120e] border border-[#1d3d2f] text-sm text-white placeholder-[#527062] focus:outline-none focus:border-[#10b981]"
                />
              </div>
            </div>

            {(!quickGoogleMode || isTypingAdminEmail) && (
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9bb8aa] mb-1.5">
                  {isTypingAdminEmail
                    ? 'Admin Password (Required)'
                    : 'Password (or leave blank for Quick Sign-In)'}
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-[#5e8070] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    required={isTypingAdminEmail}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      isTypingAdminEmail
                        ? 'Enter Admin Password (Required)...'
                        : 'Enter password (optional for quick student login)...'
                    }
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#07120e] border border-[#1d3d2f] text-sm text-white placeholder-[#527062] focus:outline-none focus:border-[#10b981]"
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting || (isTypingAdminEmail && !password.trim())}
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-bold text-sm transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
            >
              <LogIn className="w-4 h-4" />
              <span>
                {isSubmitting
                  ? 'Signing In...'
                  : isTypingAdminEmail
                  ? 'Verify Password & Sign In as Admin'
                  : !email.trim() && displayName.trim()
                  ? `Sign In as "${displayName.trim()}" (Unique Student ID)`
                  : quickGoogleMode
                  ? 'Continue with Gmail Address'
                  : authMode === 'signup'
                  ? 'Create Account & Sign In'
                  : 'Sign In'}
              </span>
            </button>
          </form>

          {/* Divider */}
          <div className="relative flex items-center justify-center">
            <div className="border-t border-[#183327] w-full" />
            <span className="bg-[#0d1f18] px-3 text-[11px] text-[#6c8c7d] uppercase tracking-wider">
              or quick access
            </span>
            <div className="border-t border-[#183327] w-full" />
          </div>

          <div className="space-y-2">
            {/* Google OAuth Button (with automatic In-Page fallback) */}
            <button
              type="button"
              onClick={handleGooglePopup}
              disabled={isLoadingGoogle}
              className="w-full min-h-[42px] py-2.5 px-4 rounded-xl bg-[#132a20] hover:bg-[#19382b] border border-[#254d3c] text-xs font-semibold text-[#d5ebe0] transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4 text-[#10b981]" />
              <span>
                {isLoadingGoogle
                  ? 'Connecting Google Account...'
                  : email.trim().includes('@') && !isTypingAdminEmail
                  ? `Continue Instantly as ${email.trim()}`
                  : 'Continue with Google Account'}
              </span>
            </button>

            {/* 1-Click Instant Student Contest Access */}
            <button
              type="button"
              onClick={handleQuickGuestParticipant}
              disabled={isSubmitting}
              className="w-full min-h-[40px] py-2 px-4 rounded-xl bg-[#0a1812] hover:bg-[#11261d] border border-[#1d3b2d] text-xs font-semibold text-[#fbbf24] transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5 text-[#fbbf24]" />
              <span>
                {displayName.trim()
                  ? `1-Click Student Login as "${displayName.trim()}" (Unique #ID)`
                  : '1-Click Instant Student Login (Unique #ID)'}
              </span>
            </button>

            {/* Admin Login Helper (Requires Password) */}
            {!currentUser?.isVerifiedAdmin && !isTypingAdminEmail && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  setAuthMode('signin');
                  setQuickGoogleMode(false);
                  setEmail(ADMIN_EMAIL);
                  setErrorMsg(
                    'Enter the Admin Password above to sign in as Admin.'
                  );
                }}
                className="w-full min-h-[40px] py-2 px-4 rounded-xl bg-[#0e291e] hover:bg-[#143a2a] border border-[#10b981]/50 text-xs font-extrabold text-[#10b981] transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-[#10b981]" />
                <span>Admin Login (Password Required)</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
