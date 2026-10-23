import React, { useState } from 'react';
import {
  X,
  LogIn,
  LogOut,
  UserCheck,
  Mail,
  User as UserIcon,
  Sparkles,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import {
  type User,
  signInWithGoogle,
  signInWithProfile,
  signOutUser,
  getSavedAccountsList,
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
  const [displayName, setDisplayName] = useState(currentUser?.displayName || '');
  const [email, setEmail] = useState(currentUser?.email || '');
  const [isLoadingGoogle, setIsLoadingGoogle] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const savedAccounts = getSavedAccountsList();

  const handleGooglePopup = async () => {
    setErrorMsg(null);
    setIsLoadingGoogle(true);
    try {
      const profile = await signInWithGoogle();
      onSignedIn(profile);
      onClose();
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      if (
        rawMsg.includes('unauthorized-domain') ||
        rawMsg.includes('token-service-api') ||
        rawMsg.includes('popup-blocked') ||
        rawMsg.includes('operation-not-allowed')
      ) {
        setErrorMsg(
          'Google popup is restricted on this preview URL/browser. Please enter your Name & Email below to sign in immediately on this Chrome profile.'
        );
      } else if (rawMsg.includes('popup-closed-by-user')) {
        setErrorMsg('Google sign-in popup was closed. You can also sign in with your Name & Email below.');
      } else {
        setErrorMsg(
          'Could not complete Google popup sign-in. Please enter your Name & Email below to sign in directly.'
        );
      }
    } finally {
      setIsLoadingGoogle(false);
    }
  };

  const handleDirectSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    try {
      const profile = await signInWithProfile({
        displayName,
        email,
      });
      onSignedIn(profile);
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Please enter a valid name and email.'
      );
    }
  };

  const handleQuickSwitch = async (acc: User) => {
    setErrorMsg(null);
    const profile = await signInWithProfile({
      displayName: acc.displayName,
      email: acc.email,
    });
    onSignedIn(profile);
    onClose();
  };

  const handleSignOut = async () => {
    await signOutUser();
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
                {currentUser ? 'Account & Switch User' : 'Sign In to Listen & Write'}
              </h3>
              <p className="text-[11px] text-[#7ea090]">
                Each Chrome profile &amp; user gets their own Personal Audio &amp; Exam History
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

        <div className="p-5 space-y-5 max-h-[82vh] overflow-y-auto">
          {/* Active User Banner (if signed in) */}
          {currentUser && (
            <div className="p-3.5 rounded-xl bg-[#0a1712] border border-[#1f4735] flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#10b981] shrink-0" />
                  <span className="text-xs font-bold text-white truncate">
                    {currentUser.displayName}
                  </span>
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

          {errorMsg && (
            <div className="p-3 rounded-xl bg-[#2a1215] border border-[#5c2026] text-xs text-[#fda4af] flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-[#f43f5e] shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Direct Email & Name Sign-In Form */}
          <form onSubmit={handleDirectSignIn} className="space-y-3.5">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9bb8aa] mb-1.5">
                Your Name
              </label>
              <div className="relative">
                <UserIcon className="w-4 h-4 text-[#5e8070] absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Prattoy Mondal or Student Name"
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#07120e] border border-[#1d3d2f] text-sm text-white placeholder-[#527062] focus:outline-none focus:border-[#10b981]"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9bb8aa] mb-1.5">
                Email Address (Google / Personal Email)
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-[#5e8070] absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. yourname@gmail.com"
                  className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-[#07120e] border border-[#1d3d2f] text-sm text-white placeholder-[#527062] focus:outline-none focus:border-[#10b981]"
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-bold text-sm transition-colors flex items-center justify-center gap-2 shadow-sm"
            >
              <LogIn className="w-4 h-4" />
              <span>{currentUser ? 'Switch to This Account' : 'Sign In'}</span>
            </button>
          </form>

          {/* Divider */}
          <div className="relative flex items-center justify-center">
            <div className="border-t border-[#183327] w-full" />
            <span className="bg-[#0d1f18] px-3 text-[11px] text-[#6c8c7d] uppercase tracking-wider">
              or
            </span>
            <div className="border-t border-[#183327] w-full" />
          </div>

          {/* Google OAuth Popup Button */}
          <button
            type="button"
            onClick={handleGooglePopup}
            disabled={isLoadingGoogle}
            className="w-full min-h-[42px] py-2.5 px-4 rounded-xl bg-[#132a20] hover:bg-[#19382b] border border-[#254d3c] text-xs font-semibold text-[#d5ebe0] transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4 text-[#10b981]" />
            <span>
              {isLoadingGoogle
                ? 'Opening Google Account Chooser...'
                : 'Continue with Google Popup'}
            </span>
          </button>

          {/* Previously Saved Accounts on this Chrome Profile */}
          {savedAccounts.length > 0 && (
            <div className="pt-2 border-t border-[#183327] space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[#7ea090]">
                Recent Accounts on this Browser
              </p>
              <div className="space-y-1.5">
                {savedAccounts.map((acc) => {
                  const isCurrent =
                    currentUser?.email.toLowerCase() === acc.email.toLowerCase();
                  return (
                    <button
                      key={acc.uid}
                      type="button"
                      onClick={() => handleQuickSwitch(acc)}
                      className={`w-full px-3 py-2 rounded-xl border text-left transition-colors flex items-center justify-between gap-2 ${
                        isCurrent
                          ? 'bg-[#11281e] border-[#10b981]/50 text-white'
                          : 'bg-[#091410] border-[#183327] text-[#b5cfc2] hover:border-[#2a5441]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold truncate">
                          {acc.displayName}
                        </div>
                        <div className="text-[11px] text-[#7ea090] truncate">
                          {acc.email}
                        </div>
                      </div>
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-[#132a20] text-[#10b981] shrink-0">
                        {isCurrent ? 'Active' : 'Use'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
