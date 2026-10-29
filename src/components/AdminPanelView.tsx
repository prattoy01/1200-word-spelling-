import React, { useState, useMemo } from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Volume2,
  Clock,
  Trash2,
  Sparkles,
  ArrowLeft,
  UserCheck,
  Globe,
  Lock,
  Search,
  Trophy,
  Edit3,
  RotateCcw,
  Save,
  LogIn,
} from 'lucide-react';
import {
  WORDS_CATALOG,
  type GlobalWordOverride,
  getOriginalCatalogWord,
  getActiveGlobalWordOverrides,
} from '../data/words';
import {
  type AudioContributionRecord,
  type CloudRecording,
  approveAudioContribution,
  rejectAudioContribution,
  deleteAudioContribution,
  deleteWordRecording,
  saveGlobalWordSpellingOverride,
  resetGlobalWordSpellingOverride,
  syncAudioContributionsNow,
} from '../services/recordingsService';
import {
  type ContestRecord,
  deleteOrCancelContest,
  getContestPhase,
} from '../services/contestService';
import { playWordAudio } from '../utils/audioUtils';
import {
  auth,
  isAdminUser,
  updateAdminPassword,
  signInAsAdminDirect,
  signInWithGoogle,
  ADMIN_EMAIL,
} from '../firebase';

interface AdminPanelViewProps {
  contributions: AudioContributionRecord[];
  generalRecordingsMap: Record<string, CloudRecording>;
  personalRecordingsMap: Record<string, CloudRecording>;
  wordOverridesMap?: Record<string, GlobalWordOverride>;
  contests?: ContestRecord[];
  onRemoveContest?: (contestId: string) => void;
  userEmail?: string | null;
  isAdmin?: boolean;
  onRefreshAudioState?: () => Promise<void>;
  onBackToPractice: () => void;
  onRestore14General: () => Promise<void>;
  isRestoring14: boolean;
}

export const AdminPanelView: React.FC<AdminPanelViewProps> = ({
  contributions,
  generalRecordingsMap,
  personalRecordingsMap,
  wordOverridesMap,
  contests = [],
  onRemoveContest,
  userEmail,
  isAdmin,
  onRefreshAudioState,
  onBackToPractice,
  onRestore14General,
  isRestoring14,
}) => {
  const [activeAdminTab, setActiveAdminTab] = useState<
    'pending' | 'spelling' | 'reviewed' | 'general' | 'contests'
  >('pending');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [editedBanglaMap, setEditedBanglaMap] = useState<Record<string, string>>(
    {}
  );
  const [editedWordMap, setEditedWordMap] = useState<Record<string, string>>(
    {}
  );
  const [searchSpellingQuery, setSearchSpellingQuery] = useState<string>('');
  const [spellingFilterMode, setSpellingFilterMode] = useState<
    'all' | 'modified'
  >('all');
  const [catalogWordDrafts, setCatalogWordDrafts] = useState<
    Record<string, { word: string; bangla: string }>
  >({});
  const [searchGeneral, setSearchGeneral] = useState<string>('');
  const [feedbackBanner, setFeedbackBanner] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Admin password change & direct unlock states
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentAdminPwd, setCurrentAdminPwd] = useState('');
  const [newAdminPwd, setNewAdminPwd] = useState('');
  const [isUpdatingPwd, setIsUpdatingPwd] = useState(false);
  const [unlockAdminPwd, setUnlockAdminPwd] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [isUnlockingAdmin, setIsUnlockingAdmin] = useState(false);

  const isRecognizedOwner = Boolean(isAdmin || isAdminUser(auth.currentUser));

  const pendingList = useMemo(
    () => contributions.filter((c) => c.status === 'pending'),
    [contributions]
  );

  const reviewedList = useMemo(
    () => contributions.filter((c) => c.status !== 'pending'),
    [contributions]
  );

  const generalList = useMemo(() => {
    const q = searchGeneral.trim().toLowerCase();
    const all = Object.values(generalRecordingsMap).sort(
      (a, b) => b.updatedAtMs - a.updatedAtMs
    );
    if (!q) return all;
    return all.filter(
      (r) =>
        r.word.toLowerCase().includes(q) ||
        r.banglaMeaning.toLowerCase().includes(q) ||
        r.ownerName.toLowerCase().includes(q)
    );
  }, [generalRecordingsMap, searchGeneral]);

  const activeOverrides = wordOverridesMap || getActiveGlobalWordOverrides();
  const modifiedSpellingsCount = Object.keys(activeOverrides).length;

  const filteredCatalogForSpelling = useMemo(() => {
    const q = searchSpellingQuery.trim().toLowerCase();
    return WORDS_CATALOG.filter((item) => {
      const isModified = Boolean(activeOverrides[item.id]);
      if (spellingFilterMode === 'modified' && !isModified) return false;
      if (!q) return true;
      const orig = getOriginalCatalogWord(item.id);
      return (
        item.word.toLowerCase().includes(q) ||
        (orig?.word || '').toLowerCase().includes(q) ||
        item.bangla.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    }).map((item) => ({ ...item }));
  }, [searchSpellingQuery, spellingFilterMode, activeOverrides]);

  const handleDirectAdminUnlock = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!unlockAdminPwd.trim()) {
      setUnlockError('Please enter the Admin Password to unlock the Admin Panel.');
      return;
    }
    setIsUnlockingAdmin(true);
    setUnlockError(null);
    try {
      await signInAsAdminDirect(unlockAdminPwd);
      setUnlockAdminPwd('');
      await onRefreshAudioState?.();
    } catch (err) {
      setUnlockError(
        err instanceof Error ? err.message : 'Incorrect Admin Password.'
      );
    } finally {
      setIsUnlockingAdmin(false);
    }
  };

  const handleGoogleAdminUnlock = async () => {
    setIsUnlockingAdmin(true);
    setUnlockError(null);
    try {
      const profile = await signInWithGoogle();
      if (!profile.isVerifiedAdmin) {
        setUnlockError(
          `Access Denied: "${profile.email}" is not the authorized Admin account (${ADMIN_EMAIL}).`
        );
        return;
      }
      await onRefreshAudioState?.();
    } catch (err) {
      setUnlockError(
        err instanceof Error
          ? err.message
          : 'Google sign-in popup was cancelled or blocked. Please enter your Admin Password above.'
      );
    } finally {
      setIsUnlockingAdmin(false);
    }
  };

  if (!isRecognizedOwner) {
    return (
      <main className="flex-1 max-w-xl w-full mx-auto px-4 sm:px-6 pt-12 pb-28 text-center space-y-5">
        <div className="rounded-3xl bg-[#0d1d16] border border-[#244737] p-7 space-y-4 shadow-2xl">
          <div className="w-14 h-14 rounded-2xl bg-[#fbbf24]/15 border border-[#fbbf24]/40 flex items-center justify-center text-[#fbbf24] mx-auto">
            <Lock className="w-7 h-7" />
          </div>
          <h1 className="text-xl font-extrabold text-white">
            Admin Panel — Password Protected
          </h1>
          <p className="text-xs sm:text-sm text-[#9bb8aa] leading-relaxed">
            You are currently signed in as{' '}
            <strong className="text-white">
              {userEmail || auth.currentUser?.displayName || 'a Participant / Guest'}
            </strong>
            . Only the verified Administrator (
            <strong className="text-[#10b981]">{ADMIN_EMAIL}</strong>) with the valid{' '}
            <strong className="text-white">Admin Password</strong> can unlock this panel.
          </p>

          {unlockError && (
            <div className="rounded-xl bg-[#2a1215] border border-[#f87171]/40 px-3.5 py-2.5 text-xs text-[#fecaca]">
              {unlockError}
            </div>
          )}

          <form onSubmit={handleDirectAdminUnlock} className="space-y-3 max-w-sm mx-auto">
            <input
              type="password"
              required
              value={unlockAdminPwd}
              onChange={(e) => setUnlockAdminPwd(e.target.value)}
              placeholder="Enter Admin Password (Required)"
              className="w-full min-h-[42px] px-3.5 py-2 rounded-xl bg-[#07120e] border border-[#1d3d2f] text-xs text-white placeholder-[#5e7d6e] focus:outline-none focus:border-[#10b981]"
            />
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2.5">
              <button
                type="submit"
                disabled={isUnlockingAdmin || !unlockAdminPwd.trim()}
                className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
              >
                <Lock className="w-4 h-4" />
                <span>
                  {isUnlockingAdmin
                    ? 'Verifying Password...'
                    : 'Verify Password & Unlock Admin'}
                </span>
              </button>

              <button
                type="button"
                onClick={onBackToPractice}
                className="min-h-[44px] px-4 py-2.5 rounded-xl bg-[#11261d] hover:bg-[#173327] border border-[#224736] text-[#d2e5dc] text-xs font-bold inline-flex items-center justify-center gap-2 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Back to Practice</span>
              </button>
            </div>
          </form>

          <div className="pt-2 border-t border-[#183327] max-w-sm mx-auto">
            <button
              type="button"
              disabled={isUnlockingAdmin}
              onClick={handleGoogleAdminUnlock}
              className="w-full min-h-[40px] px-4 py-2 rounded-xl bg-[#132a20] hover:bg-[#19382b] border border-[#254d3c] text-xs font-semibold text-[#d5ebe0] inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
            >
              <ShieldCheck className="w-4 h-4 text-[#10b981]" />
              <span>Or Verify via Google OAuth ({ADMIN_EMAIL})</span>
            </button>
          </div>
        </div>
      </main>
    );
  }

  const handleUpdateAdminPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdatingPwd(true);
    setFeedbackBanner(null);
    try {
      await updateAdminPassword({
        currentPassword: currentAdminPwd,
        newPassword: newAdminPwd,
      });
      setCurrentAdminPwd('');
      setNewAdminPwd('');
      setShowPasswordChange(false);
      setFeedbackBanner({
        type: 'success',
        text: 'Admin Password updated! Only someone with your new Admin Password can sign in as Admin.',
      });
    } catch (err) {
      setFeedbackBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Could not update Admin password.',
      });
    } finally {
      setIsUpdatingPwd(false);
    }
  };

  const handleApprove = async (item: AudioContributionRecord) => {
    setProcessingId(item.id);
    setFeedbackBanner(null);
    try {
      const customBangla =
        editedBanglaMap[item.id] !== undefined
          ? editedBanglaMap[item.id]
          : item.banglaMeaning;
      const customWord =
        editedWordMap[item.id] !== undefined
          ? editedWordMap[item.id]
          : item.word;
      await approveAudioContribution(item, customBangla, customWord);
      await onRefreshAudioState?.();
      setFeedbackBanner({
        type: 'success',
        text: `Accepted "${customWord}" from ${item.contributorName}! General App Audio & Official Spelling are now updated for all users.`,
      });
    } catch (err) {
      setFeedbackBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Could not approve contribution.',
      });
    } finally {
      setProcessingId(null);
    }
  };

  const handleSaveCatalogWordSpelling = async (wordId: string) => {
    const item = WORDS_CATALOG.find((w) => w.id === wordId);
    if (!item) return;
    const draft = catalogWordDrafts[wordId];
    const nextWord = (draft?.word ?? item.word).trim();
    const nextBangla = (draft?.bangla ?? item.bangla).trim();
    if (!nextWord) {
      setFeedbackBanner({
        type: 'error',
        text: 'Official word spelling cannot be empty.',
      });
      return;
    }

    setProcessingId(`spell_${wordId}`);
    setFeedbackBanner(null);
    try {
      await saveGlobalWordSpellingOverride({
        wordId,
        word: nextWord,
        bangla: nextBangla,
      });
      setCatalogWordDrafts((prev) => {
        const next = { ...prev };
        delete next[wordId];
        return next;
      });
      await onRefreshAudioState?.();
      setFeedbackBanner({
        type: 'success',
        text: `Updated official spelling to "${nextWord}"! This new spelling now applies to all users across Practice, Exams, and Contests.`,
      });
    } catch (err) {
      setFeedbackBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Could not update word spelling.',
      });
    } finally {
      setProcessingId(null);
    }
  };

  const handleResetCatalogWordSpelling = async (wordId: string) => {
    const orig = getOriginalCatalogWord(wordId);
    setProcessingId(`spell_${wordId}`);
    setFeedbackBanner(null);
    try {
      await resetGlobalWordSpellingOverride(wordId);
      setCatalogWordDrafts((prev) => {
        const next = { ...prev };
        delete next[wordId];
        return next;
      });
      await onRefreshAudioState?.();
      setFeedbackBanner({
        type: 'success',
        text: `Reset spelling back to original "${orig?.word || wordId}" for all users.`,
      });
    } catch (err) {
      setFeedbackBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Could not reset word spelling.',
      });
    } finally {
      setProcessingId(null);
    }
  };

  const handleReject = async (item: AudioContributionRecord) => {
    setProcessingId(item.id);
    setFeedbackBanner(null);
    try {
      await rejectAudioContribution(item.id);
      setFeedbackBanner({
        type: 'success',
        text: `Rejected contribution for "${item.word}". General App Audio was not changed (the user still keeps their personal audio on their own device).`,
      });
    } catch (err) {
      setFeedbackBanner({
        type: 'error',
        text:
          err instanceof Error ? err.message : 'Could not reject contribution.',
      });
    } finally {
      setProcessingId(null);
    }
  };

  const handleDeleteContribution = async (id: string) => {
    setProcessingId(id);
    try {
      await deleteAudioContribution(id);
    } finally {
      setProcessingId(null);
    }
  };

  const handleDeleteGeneralAudio = async (rec: CloudRecording) => {
    setProcessingId(rec.wordId);
    setFeedbackBanner(null);
    try {
      await deleteWordRecording(rec.wordId, rec.ownerId, true);
      await onRefreshAudioState?.();
      setFeedbackBanner({
        type: 'success',
        text: `Removed General App Audio for "${rec.word}". Users without a personal audio will now hear the default bundled audio.`,
      });
    } catch (err) {
      setFeedbackBanner({
        type: 'error',
        text:
          err instanceof Error ? err.message : 'Could not remove general audio.',
      });
    } finally {
      setProcessingId(null);
    }
  };

  const handleAdminDeleteContest = async (contest: ContestRecord) => {
    setProcessingId(contest.id);
    setFeedbackBanner(null);
    try {
      await deleteOrCancelContest(contest.id);
      onRemoveContest?.(contest.id);
      setFeedbackBanner({
        type: 'success',
        text: `Removed contest "${contest.title}" permanently.`,
      });
    } catch (err) {
      setFeedbackBanner({
        type: 'error',
        text:
          err instanceof Error ? err.message : 'Could not remove contest.',
      });
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 pt-5 pb-28 md:py-8 space-y-6">
      {/* Top Navigation Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBackToPractice}
          className="min-h-[42px] text-xs sm:text-sm font-semibold text-[#10b981] hover:text-[#34d399] flex items-center gap-1.5 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Practice &amp; Recordings</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowPasswordChange((prev) => !prev)}
            className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#11261d] hover:bg-[#173327] border border-[#224736] text-xs font-semibold text-[#d2e5dc] flex items-center gap-1.5 transition-colors"
          >
            <Lock className="w-3.5 h-3.5 text-[#fbbf24]" />
            <span>Change Admin Password</span>
          </button>

          <span className="px-3 py-1.5 rounded-xl bg-[#10b981]/15 border border-[#10b981]/40 text-xs font-bold text-[#10b981] flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4" />
            <span>Verified Admin ({ADMIN_EMAIL})</span>
          </span>
        </div>
      </div>

      {/* Change Admin Password Card */}
      {showPasswordChange && (
        <form
          onSubmit={handleUpdateAdminPassword}
          className="rounded-2xl bg-[#0a1712] border border-[#244c3a] p-4 sm:p-5 space-y-3.5"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Lock className="w-4 h-4 text-[#fbbf24]" />
              <span>Update Admin Password ({ADMIN_EMAIL})</span>
            </h3>
            <button
              type="button"
              onClick={() => setShowPasswordChange(false)}
              className="text-xs text-[#8ba89a] hover:text-white"
            >
              Cancel
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-[#9bb8aa] mb-1">
                Current Admin Password
              </label>
              <input
                type="password"
                required
                value={currentAdminPwd}
                onChange={(e) => setCurrentAdminPwd(e.target.value)}
                placeholder="Enter current password..."
                className="w-full px-3.5 py-2 rounded-xl bg-[#07120e] border border-[#1d3d2f] text-xs text-white focus:outline-none focus:border-[#10b981]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-[#9bb8aa] mb-1">
                New Admin Password (min 6 chars)
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={newAdminPwd}
                onChange={(e) => setNewAdminPwd(e.target.value)}
                placeholder="Enter new secret password..."
                className="w-full px-3.5 py-2 rounded-xl bg-[#07120e] border border-[#1d3d2f] text-xs text-white focus:outline-none focus:border-[#10b981]"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={isUpdatingPwd}
            className="px-4 py-2 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold transition-colors disabled:opacity-50"
          >
            {isUpdatingPwd ? 'Updating...' : 'Save New Admin Password'}
          </button>
        </form>
      )}

      {/* Architecture Explanation Card */}
      <section className="rounded-3xl bg-[#0d1d16] border border-[#244737] p-5 sm:p-7 space-y-4 shadow-2xl">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-[#10b981]/15 border border-[#10b981]/40 flex items-center justify-center text-[#10b981] shrink-0">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">
                Admin Panel · Audio Contributions &amp; General Audio
              </h1>
              <p className="text-xs sm:text-sm text-[#8ba89a] mt-1 leading-relaxed">
                Review user-contributed pronunciations. When you <strong>Accept</strong> a contribution, it updates the <strong>General App Audio</strong> for everyone who has not set their own personal audio for that word.
              </p>
            </div>
          </div>
        </div>

        {/* 2-Rule Priority Summary Boxes */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div className="rounded-2xl bg-[#09140f] border border-[#1a3528] p-3.5 flex items-start gap-3">
            <UserCheck className="w-5 h-5 text-[#fbbf24] shrink-0 mt-0.5" />
            <div className="text-xs text-[#c4d9ce] leading-relaxed">
              <strong className="text-[#fbbf24] block mb-0.5">
                1. Personal Audio Never Changes
              </strong>
              If a user uploads or records an audio for themselves, their app locks it as their <strong>Personal Audio</strong>. Accepting a new General Audio here will <strong>never</strong> overwrite a user&apos;s personal audio.
            </div>
          </div>

          <div className="rounded-2xl bg-[#09140f] border border-[#1a3528] p-3.5 flex items-start gap-3">
            <Globe className="w-5 h-5 text-[#10b981] shrink-0 mt-0.5" />
            <div className="text-xs text-[#c4d9ce] leading-relaxed">
              <strong className="text-[#10b981] block mb-0.5">
                2. General Audio Updates for Everyone Else
              </strong>
              When you <strong>Accept</strong> a user contribution below, it becomes the official <strong>General Audio</strong> for all users who haven&apos;t set a personal audio for that word.
            </div>
          </div>
        </div>

        {/* KPI Counters */}
        <div className="grid grid-cols-3 rounded-2xl bg-[#08130e] border border-[#1a3327] divide-x divide-[#1a3327] overflow-hidden text-center">
          <div className="py-3 px-2">
            <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums text-[#fbbf24]">
              {pendingList.length}
            </div>
            <div className="text-[10px] sm:text-xs font-semibold text-[#8ba89a] mt-0.5">
              PENDING REVIEW
            </div>
          </div>
          <div className="py-3 px-2">
            <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums text-[#10b981]">
              {Object.keys(generalRecordingsMap).length}
            </div>
            <div className="text-[10px] sm:text-xs font-semibold text-[#8ba89a] mt-0.5">
              GENERAL AUDIOS
            </div>
          </div>
          <div className="py-3 px-2">
            <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums text-[#38bdf8]">
              {
                Object.values(personalRecordingsMap).filter(
                  (r) => r.isPersonalOverride
                ).length
              }
            </div>
            <div className="text-[10px] sm:text-xs font-semibold text-[#8ba89a] mt-0.5">
              MY PERSONAL AUDIOS
            </div>
          </div>
        </div>
      </section>

      {/* Feedback Banner */}
      {feedbackBanner && (
        <div
          className={`rounded-2xl px-4 py-3.5 border text-xs flex items-center justify-between gap-3 ${
            feedbackBanner.type === 'success'
              ? 'bg-[#0e291e] border-[#10b981]/50 text-[#a7f3d0]'
              : 'bg-[#2c1215] border-[#f87171]/50 text-[#fecaca]'
          }`}
        >
          <span>{feedbackBanner.text}</span>
          <button
            type="button"
            onClick={() => setFeedbackBanner(null)}
            className="text-xs underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Admin Sub-Navigation Tabs */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 p-1.5 rounded-2xl bg-[#0b1812] border border-[#1d382b]">
        <button
          type="button"
          onClick={() => setActiveAdminTab('pending')}
          className={`min-h-[44px] px-3 py-2 rounded-xl text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 ${
            activeAdminTab === 'pending'
              ? 'bg-[#fbbf24] text-[#08120e]'
              : 'text-[#8ba89a] hover:text-white'
          }`}
        >
          <Clock className="w-4 h-4 shrink-0" />
          <span>Pending ({pendingList.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveAdminTab('spelling')}
          className={`min-h-[44px] px-3 py-2 rounded-xl text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 ${
            activeAdminTab === 'spelling'
              ? 'bg-[#10b981] text-[#04120c]'
              : 'text-[#8ba89a] hover:text-white'
          }`}
        >
          <Edit3 className="w-4 h-4 shrink-0" />
          <span>
            Change Spelling
            {modifiedSpellingsCount > 0 ? ` (${modifiedSpellingsCount})` : ''}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveAdminTab('general')}
          className={`min-h-[44px] px-3 py-2 rounded-xl text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 ${
            activeAdminTab === 'general'
              ? 'bg-[#10b981] text-[#04120c]'
              : 'text-[#8ba89a] hover:text-white'
          }`}
        >
          <Globe className="w-4 h-4 shrink-0" />
          <span>General Audio ({Object.keys(generalRecordingsMap).length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveAdminTab('contests')}
          className={`min-h-[44px] px-3 py-2 rounded-xl text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 ${
            activeAdminTab === 'contests'
              ? 'bg-[#fbbf24] text-[#08120e]'
              : 'text-[#8ba89a] hover:text-white'
          }`}
        >
          <Trophy className="w-4 h-4 shrink-0" />
          <span>Contests ({contests.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveAdminTab('reviewed')}
          className={`min-h-[44px] px-3 py-2 rounded-xl text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 ${
            activeAdminTab === 'reviewed'
              ? 'bg-[#152e23] text-white border border-[#244c3a]'
              : 'text-[#8ba89a] hover:text-white'
          }`}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>History ({reviewedList.length})</span>
        </button>
      </div>

      {/* TAB: GLOBAL SPELLING EDITOR (APPLIES TO ALL USERS) */}
      {activeAdminTab === 'spelling' && (
        <section className="rounded-3xl bg-[#0d1d16] border border-[#1f3b2e] p-4 sm:p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-[#10b981]" />
                <span>
                  Official Word Spelling Manager (Applies to All Users)
                </span>
              </h2>
              <p className="text-xs text-[#8ba89a] mt-0.5">
                Change any word&apos;s English spelling or Bangla meaning below. Changes sync immediately to all users across Practice, Strict Test, and Live Contests (tip: use <code className="text-[#10b981] font-mono">word1 / word2</code> to accept both spellings).
              </p>
            </div>

            <div className="inline-flex rounded-xl bg-[#08130e] border border-[#1a3327] p-1 gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setSpellingFilterMode('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  spellingFilterMode === 'all'
                    ? 'bg-[#10b981] text-[#04120c]'
                    : 'text-[#8ba89a] hover:text-white'
                }`}
              >
                All Words ({WORDS_CATALOG.length})
              </button>
              <button
                type="button"
                onClick={() => setSpellingFilterMode('modified')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  spellingFilterMode === 'modified'
                    ? 'bg-[#fbbf24] text-[#08120e]'
                    : 'text-[#8ba89a] hover:text-white'
                }`}
              >
                Modified ({modifiedSpellingsCount})
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 text-[#668576] absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchSpellingQuery}
              onChange={(e) => setSearchSpellingQuery(e.target.value)}
              placeholder="Search any word by English spelling, Bangla meaning, or category..."
              className="w-full min-h-[44px] pl-10 pr-4 py-2 rounded-2xl bg-[#08130e] border border-[#1d362a] focus:border-[#10b981] focus:outline-none text-sm text-white placeholder-[#668576]"
            />
          </div>

          {filteredCatalogForSpelling.length === 0 ? (
            <div className="rounded-2xl bg-[#08130e] border border-[#193327] py-10 px-4 text-center text-xs text-[#8ba89a]">
              {spellingFilterMode === 'modified'
                ? 'No modified word spellings yet. Search any word in "All Words" to change its official spelling.'
                : 'No words match your search query.'}
            </div>
          ) : (
            <div className="space-y-2.5 max-h-[520px] overflow-y-auto pr-1">
              {filteredCatalogForSpelling.slice(0, 80).map((item) => {
                const orig = getOriginalCatalogWord(item.id);
                const override = activeOverrides[item.id];
                const draft = catalogWordDrafts[item.id];
                const currentWordVal = draft ? draft.word : item.word;
                const currentBanglaVal = draft ? draft.bangla : item.bangla;
                const isSaving = processingId === `spell_${item.id}`;
                const genRec = generalRecordingsMap[item.id];

                return (
                  <div
                    key={item.id}
                    className={`rounded-2xl p-3.5 sm:p-4 border space-y-3 ${
                      override
                        ? 'bg-[#0b1f17] border-[#10b981]/60'
                        : 'bg-[#08130e] border-[#1a3327]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-bold text-sm text-white">
                          {item.word}
                        </span>
                        <span className="text-xs text-[#7ea090]">
                          Page {item.page} · {item.category}
                        </span>
                        {override && orig && (
                          <span className="px-2 py-0.5 rounded bg-[#fbbf24]/20 text-[#fbbf24] text-[10px] font-bold">
                            Modified (Default: &ldquo;{orig.word}&rdquo;)
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            void playWordAudio({
                              word: item.word,
                              audioDataUrl: genRec?.audioDataUrl,
                              bundledAudioFile: item.bundledAudioFile,
                            })
                          }
                          className="min-h-[32px] px-2.5 py-1 rounded-lg bg-[#12281e] hover:bg-[#19382a] text-xs font-semibold text-[#10b981] flex items-center gap-1"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                          <span>Listen</span>
                        </button>

                        {override && (
                          <button
                            type="button"
                            disabled={isSaving}
                            onClick={() =>
                              void handleResetCatalogWordSpelling(item.id)
                            }
                            className="min-h-[32px] px-2.5 py-1 rounded-lg bg-[#2a1215] hover:bg-[#3b181c] border border-[#f87171]/40 text-xs font-semibold text-[#fca5a5] flex items-center gap-1 disabled:opacity-50"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>Reset to Default</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
                      <div className="sm:col-span-5">
                        <label className="block text-[10px] font-semibold text-[#8ba89a] mb-1">
                          Official English Spelling (All Users):
                        </label>
                        <input
                          type="text"
                          value={currentWordVal}
                          onChange={(e) =>
                            setCatalogWordDrafts((prev) => ({
                              ...prev,
                              [item.id]: {
                                word: e.target.value,
                                bangla: currentBanglaVal,
                              },
                            }))
                          }
                          placeholder="Enter official spelling..."
                          className="w-full min-h-[38px] px-3 py-1.5 rounded-xl bg-[#0d1d16] border border-[#234837] focus:border-[#10b981] focus:outline-none text-xs sm:text-sm font-mono font-bold text-white"
                        />
                      </div>

                      <div className="sm:col-span-4">
                        <label className="block text-[10px] font-semibold text-[#8ba89a] mb-1">
                          Bangla Meaning (All Users):
                        </label>
                        <input
                          type="text"
                          value={currentBanglaVal}
                          onChange={(e) =>
                            setCatalogWordDrafts((prev) => ({
                              ...prev,
                              [item.id]: {
                                word: currentWordVal,
                                bangla: e.target.value,
                              },
                            }))
                          }
                          placeholder="বাংলা অর্থ..."
                          className="w-full min-h-[38px] px-3 py-1.5 rounded-xl bg-[#0d1d16] border border-[#234837] focus:border-[#10b981] focus:outline-none text-xs sm:text-sm text-white"
                        />
                      </div>

                      <div className="sm:col-span-3 sm:pt-4">
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={() =>
                            void handleSaveCatalogWordSpelling(item.id)
                          }
                          className="w-full min-h-[38px] px-3 py-1.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold flex items-center justify-center gap-1.5 disabled:opacity-50 transition-colors"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>
                            {isSaving ? 'Saving...' : 'Save for All'}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* TAB 1: PENDING CONTRIBUTIONS QUEUE */}
      {activeAdminTab === 'pending' && (
        <section className="rounded-3xl bg-[#0d1d16] border border-[#1f3b2e] p-4 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base sm:text-lg font-bold text-white">
              Pending User Audio Contributions ({pendingList.length})
            </h2>
            <button
              type="button"
              disabled={processingId === 'sync_contribs'}
              onClick={async () => {
                setProcessingId('sync_contribs');
                try {
                  await syncAudioContributionsNow();
                  await onRefreshAudioState?.();
                } finally {
                  setProcessingId(null);
                }
              }}
              className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#11261d] hover:bg-[#173327] border border-[#224736] text-xs font-bold text-[#10b981] flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <RotateCcw
                className={`w-3.5 h-3.5 ${
                  processingId === 'sync_contribs' ? 'animate-spin' : ''
                }`}
              />
              <span>
                {processingId === 'sync_contribs'
                  ? 'Syncing...'
                  : 'Sync Contributions'}
              </span>
            </button>
          </div>

          {pendingList.length === 0 ? (
            <div className="rounded-2xl bg-[#08130e] border border-[#193327] py-12 px-4 text-center space-y-2">
              <p className="text-sm font-semibold text-[#c4d9ce]">
                No pending audio contributions right now.
              </p>
              <p className="text-xs text-[#6d8c7d] max-w-md mx-auto">
                When any user uploads or records an audio in the Recordings section and clicks &ldquo;Contribute to App (Send to Admin)&rdquo;, it will appear here for you to listen and accept.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {pendingList.map((item) => {
                const catalogWord = WORDS_CATALOG.find(
                  (w) => w.id === item.wordId
                );
                const existingGeneral = generalRecordingsMap[item.wordId];
                const hasPersonalOverrideOnThisDevice = Boolean(
                  personalRecordingsMap[item.wordId]?.isPersonalOverride
                );
                const banglaVal =
                  editedBanglaMap[item.id] !== undefined
                    ? editedBanglaMap[item.id]
                    : item.banglaMeaning || catalogWord?.bangla || '';
                const wordVal =
                  editedWordMap[item.id] !== undefined
                    ? editedWordMap[item.id]
                    : catalogWord?.word || item.word;

                return (
                  <div
                    key={item.id}
                    className="rounded-2xl bg-[#08130e] border border-[#224434] p-4 sm:p-5 space-y-4"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-lg font-extrabold text-white">
                            {wordVal}
                          </span>
                          <span className="px-2.5 py-0.5 rounded-lg bg-[#fbbf24]/15 text-[#fbbf24] text-[11px] font-bold">
                            Pending Review
                          </span>
                          {catalogWord && (
                            <span className="text-xs text-[#7ea090]">
                              Page {catalogWord.page} · {catalogWord.category}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-[#8ba89a] mt-1">
                          Submitted by{' '}
                          <strong className="text-[#d2e5dc]">
                            {item.contributorName}
                          </strong>{' '}
                          · {Math.max(1, Math.round(item.fileSize / 1024))} KB ·{' '}
                          {new Date(item.createdAtMs).toLocaleString()}
                        </div>
                      </div>

                      {hasPersonalOverrideOnThisDevice && (
                        <span className="self-start sm:self-center px-2.5 py-1 rounded-lg bg-[#38bdf8]/15 border border-[#38bdf8]/40 text-[11px] text-[#7dd3fc] font-semibold">
                          You also have a Personal Audio set for this word
                        </span>
                      )}
                    </div>

                    {/* Editable Official Spelling & Bangla Meaning before Approving */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs font-semibold text-[#8ba89a]">
                          Official English Spelling (All Users):
                        </label>
                        <input
                          type="text"
                          value={wordVal}
                          onChange={(e) =>
                            setEditedWordMap((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                          placeholder="English spelling..."
                          className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#0d1d16] border border-[#1f3d2f] focus:border-[#10b981] focus:outline-none text-sm font-mono font-bold text-white"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-xs font-semibold text-[#8ba89a]">
                          Bangla Meaning (All Users):
                        </label>
                        <input
                          type="text"
                          value={banglaVal}
                          onChange={(e) =>
                            setEditedBanglaMap((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                          placeholder="বাংলা অর্থ..."
                          className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#0d1d16] border border-[#1f3d2f] focus:border-[#10b981] focus:outline-none text-sm text-white"
                        />
                      </div>
                    </div>

                    {/* Audio Comparison & Approve / Reject Buttons */}
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            playWordAudio({
                              word: item.word,
                              audioDataUrl: item.audioDataUrl,
                            })
                          }
                          className="min-h-[42px] px-4 py-2 rounded-xl bg-[#132a20] hover:bg-[#1b3b2d] border border-[#254f3c] text-xs font-bold text-[#10b981] flex items-center gap-1.5"
                        >
                          <Volume2 className="w-4 h-4" />
                          <span>Listen Contributed Audio</span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            playWordAudio({
                              word: item.word,
                              audioDataUrl: existingGeneral?.audioDataUrl,
                              bundledAudioFile: catalogWord?.bundledAudioFile,
                            })
                          }
                          className="min-h-[42px] px-3.5 py-2 rounded-xl bg-[#0d1d16] hover:bg-[#142c22] border border-[#1c382b] text-xs font-semibold text-[#9ab5a7] hover:text-white flex items-center gap-1.5"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                          <span>
                            Listen Current General Audio (
                            {existingGeneral ? 'Cloud' : 'Bundled'})
                          </span>
                        </button>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={processingId === item.id}
                          onClick={() => handleReject(item)}
                          className="min-h-[42px] px-4 py-2 rounded-xl bg-[#2a1215] hover:bg-[#3b181c] border border-[#f87171]/40 text-xs font-bold text-[#fca5a5] flex items-center gap-1.5 disabled:opacity-50"
                        >
                          <XCircle className="w-4 h-4" />
                          <span>Reject</span>
                        </button>

                        <button
                          type="button"
                          disabled={processingId === item.id}
                          onClick={() => handleApprove(item)}
                          className="min-h-[42px] px-5 py-2 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold flex items-center gap-1.5 disabled:opacity-50"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          <span>
                            {processingId === item.id
                              ? 'Accepting...'
                              : 'Accept & Update General Audio'}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* TAB 2: GENERAL APP AUDIO LIBRARY */}
      {activeAdminTab === 'general' && (
        <section className="rounded-3xl bg-[#0d1d16] border border-[#1f3b2e] p-4 sm:p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white">
                Active General App Audios ({Object.keys(generalRecordingsMap).length})
              </h2>
              <p className="text-xs text-[#8ba89a]">
                These approved recordings play for all users who have not set their own personal audio for the word.
              </p>
            </div>

            <button
              type="button"
              onClick={onRestore14General}
              disabled={isRestoring14}
              className="self-start sm:self-center min-h-[40px] px-3.5 py-2 rounded-xl bg-[#fbbf24]/15 hover:bg-[#fbbf24]/25 border border-[#fbbf24]/40 text-xs font-bold text-[#fbbf24] flex items-center gap-1.5 shrink-0"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>
                {isRestoring14
                  ? 'Syncing 14 General Audios...'
                  : 'Restore 14 Default General Audios'}
              </span>
            </button>
          </div>

          <div className="relative">
            <Search className="w-4 h-4 text-[#668576] absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchGeneral}
              onChange={(e) => setSearchGeneral(e.target.value)}
              placeholder="Search general audios..."
              className="w-full min-h-[44px] pl-10 pr-4 py-2 rounded-2xl bg-[#08130e] border border-[#1d362a] focus:border-[#10b981] focus:outline-none text-sm text-white placeholder-[#668576]"
            />
          </div>

          {generalList.length === 0 ? (
            <div className="rounded-2xl bg-[#08130e] border border-[#193327] py-10 px-4 text-center text-xs text-[#8ba89a]">
              No General Cloud Audio overrides found.
            </div>
          ) : (
            <div className="rounded-2xl bg-[#08130e] border border-[#1a3327] divide-y divide-[#14291f] max-h-96 overflow-y-auto">
              {generalList.map((rec) => (
                <div
                  key={rec.wordId}
                  className="p-3.5 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-sm text-white">
                        {rec.word}
                      </span>
                      {rec.banglaMeaning && (
                        <span className="text-xs text-[#10b981]">
                          ({rec.banglaMeaning})
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded bg-[#10b981]/15 text-[#10b981] text-[10px] font-bold">
                        General Audio
                      </span>
                    </div>
                    <div className="text-[11px] text-[#7ea090] mt-0.5">
                      Source: {rec.ownerName} ·{' '}
                      {Math.max(1, Math.round(rec.fileSize / 1024))} KB
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        playWordAudio({
                          word: rec.word,
                          audioDataUrl: rec.audioDataUrl,
                        })
                      }
                      className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#12281e] hover:bg-[#19382a] text-xs font-semibold text-[#10b981] flex items-center gap-1.5"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                      <span>Listen</span>
                    </button>

                    <button
                      type="button"
                      disabled={processingId === rec.wordId}
                      onClick={() => handleDeleteGeneralAudio(rec)}
                      title="Remove General Audio override"
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#2a1215] hover:bg-[#3b181c] text-xs font-semibold text-[#f87171] flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Remove</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* TAB 3: REVIEWED HISTORY */}
      {activeAdminTab === 'reviewed' && (
        <section className="rounded-3xl bg-[#0d1d16] border border-[#1f3b2e] p-4 sm:p-6 space-y-4">
          <h2 className="text-base sm:text-lg font-bold text-white">
            Reviewed Contributions History ({reviewedList.length})
          </h2>

          {reviewedList.length === 0 ? (
            <div className="rounded-2xl bg-[#08130e] border border-[#193327] py-10 px-4 text-center text-xs text-[#8ba89a]">
              No approved or rejected contributions yet.
            </div>
          ) : (
            <div className="rounded-2xl bg-[#08130e] border border-[#1a3327] divide-y divide-[#14291f] max-h-96 overflow-y-auto">
              {reviewedList.map((item) => (
                <div
                  key={item.id}
                  className="p-3.5 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-sm text-white">
                        {item.word}
                      </span>
                      {item.banglaMeaning && (
                        <span className="text-xs text-[#8ba89a]">
                          ({item.banglaMeaning})
                        </span>
                      )}
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          item.status === 'approved'
                            ? 'bg-[#10b981]/15 text-[#10b981]'
                            : 'bg-[#f87171]/15 text-[#f87171]'
                        }`}
                      >
                        {item.status === 'approved'
                          ? 'Approved as General Audio'
                          : 'Rejected'}
                      </span>
                    </div>
                    <div className="text-[11px] text-[#7ea090] mt-0.5">
                      Contributor: {item.contributorName} ·{' '}
                      {new Date(item.updatedAtMs).toLocaleString()}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        playWordAudio({
                          word: item.word,
                          audioDataUrl: item.audioDataUrl,
                        })
                      }
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#12281e] hover:bg-[#19382a] text-xs font-semibold text-[#10b981] flex items-center gap-1.5"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                      <span>Listen</span>
                    </button>

                    {item.status === 'rejected' && (
                      <button
                        type="button"
                        disabled={processingId === item.id}
                        onClick={() => handleApprove(item)}
                        className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#10b981] text-[#04120c] text-xs font-bold"
                      >
                        Approve Now
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={processingId === item.id}
                      onClick={() => handleDeleteContribution(item.id)}
                      className="min-h-[38px] px-2.5 py-1.5 rounded-xl bg-[#2a1215] text-[#f87171] text-xs"
                      title="Delete record"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* TAB 4: MANAGE & REMOVE CONTESTS */}
      {activeAdminTab === 'contests' && (
        <section className="rounded-3xl bg-[#0d1d16] border border-[#1f3b2e] p-4 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white">
                Manage Contests ({contests.length})
              </h2>
              <p className="text-xs text-[#8ba89a]">
                As Admin, you can remove any scheduled, live, or ended contest from the platform.
              </p>
            </div>
          </div>

          {contests.length === 0 ? (
            <div className="rounded-2xl bg-[#08130e] border border-[#193327] py-10 px-4 text-center text-xs text-[#8ba89a]">
              No active contests on the platform right now.
            </div>
          ) : (
            <div className="rounded-2xl bg-[#08130e] border border-[#1a3327] divide-y divide-[#14291f] max-h-96 overflow-y-auto">
              {contests.map((contest) => {
                const phase = getContestPhase(contest, Date.now());
                return (
                  <div
                    key={contest.id}
                    className="p-3.5 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-sm text-white">
                          {contest.title}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            phase === 'live'
                              ? 'bg-[#10b981] text-[#04120c]'
                              : phase === 'upcoming'
                              ? 'bg-[#fbbf24]/20 text-[#fbbf24]'
                              : 'bg-[#13261d] text-[#6d8a7b]'
                          }`}
                        >
                          {phase}
                        </span>
                      </div>
                      <div className="text-[11px] text-[#7ea090] mt-0.5">
                        Setter: {contest.creatorName} · {contest.wordCount} words ·{' '}
                        {new Date(contest.startTimeMs).toLocaleString()}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={processingId === contest.id}
                      onClick={() => void handleAdminDeleteContest(contest)}
                      className="self-start sm:self-center min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#2a1215] hover:bg-[#3b181c] border border-[#f87171]/40 text-xs font-bold text-[#f87171] flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>
                        {processingId === contest.id
                          ? 'Removing...'
                          : 'Remove Contest'}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </main>
  );
};
