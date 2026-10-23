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
} from 'lucide-react';
import { WORDS_CATALOG } from '../data/words';
import {
  type AudioContributionRecord,
  type CloudRecording,
  approveAudioContribution,
  rejectAudioContribution,
  deleteAudioContribution,
  deleteWordRecording,
} from '../services/recordingsService';
import { playWordAudio } from '../utils/audioUtils';
import { auth, isAdminUser, updateAdminPassword, ADMIN_EMAIL } from '../firebase';

interface AdminPanelViewProps {
  contributions: AudioContributionRecord[];
  generalRecordingsMap: Record<string, CloudRecording>;
  personalRecordingsMap: Record<string, CloudRecording>;
  userEmail?: string | null;
  onBackToPractice: () => void;
  onRestore14General: () => Promise<void>;
  isRestoring14: boolean;
}

export const AdminPanelView: React.FC<AdminPanelViewProps> = ({
  contributions,
  generalRecordingsMap,
  personalRecordingsMap,
  onBackToPractice,
  onRestore14General,
  isRestoring14,
}) => {
  const [activeAdminTab, setActiveAdminTab] = useState<
    'pending' | 'reviewed' | 'general'
  >('pending');
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [editedBanglaMap, setEditedBanglaMap] = useState<Record<string, string>>(
    {}
  );
  const [searchGeneral, setSearchGeneral] = useState<string>('');
  const [feedbackBanner, setFeedbackBanner] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Admin password change states
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentAdminPwd, setCurrentAdminPwd] = useState('');
  const [newAdminPwd, setNewAdminPwd] = useState('');
  const [isUpdatingPwd, setIsUpdatingPwd] = useState(false);

  const isRecognizedOwner = isAdminUser(auth.currentUser);

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

  if (!isRecognizedOwner) {
    return (
      <main className="flex-1 max-w-xl w-full mx-auto px-4 sm:px-6 pt-12 pb-28 text-center space-y-5">
        <div className="rounded-3xl bg-[#0d1d16] border border-[#3d1d24] p-7 space-y-4 shadow-2xl">
          <div className="w-14 h-14 rounded-2xl bg-[#2a1215] border border-[#5c2026] flex items-center justify-center text-[#f43f5e] mx-auto">
            <Lock className="w-7 h-7" />
          </div>
          <h1 className="text-xl font-extrabold text-white">
            Admin Access Restricted
          </h1>
          <p className="text-xs sm:text-sm text-[#9bb8aa] leading-relaxed">
            Only the verified Admin (<strong className="text-white">{ADMIN_EMAIL}</strong> authenticated with the Admin Password or Verified Google OAuth) can access the Admin Panel.
          </p>
          <button
            type="button"
            onClick={onBackToPractice}
            className="min-h-[42px] px-5 py-2.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold inline-flex items-center gap-2 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Practice</span>
          </button>
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
      await approveAudioContribution(item, customBangla);
      setFeedbackBanner({
        type: 'success',
        text: `Accepted "${item.word}" from ${item.contributorName}! General App Audio is now updated for all users who haven't set their own personal audio for "${item.word}".`,
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
      <div className="grid grid-cols-3 gap-1.5 p-1.5 rounded-2xl bg-[#0b1812] border border-[#1d382b]">
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

      {/* TAB 1: PENDING CONTRIBUTIONS QUEUE */}
      {activeAdminTab === 'pending' && (
        <section className="rounded-3xl bg-[#0d1d16] border border-[#1f3b2e] p-4 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base sm:text-lg font-bold text-white">
              Pending User Audio Contributions ({pendingList.length})
            </h2>
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

                return (
                  <div
                    key={item.id}
                    className="rounded-2xl bg-[#08130e] border border-[#224434] p-4 sm:p-5 space-y-4"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-lg font-extrabold text-white">
                            {item.word}
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

                    {/* Editable Bangla Meaning before Approving */}
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <label className="text-xs font-semibold text-[#8ba89a] shrink-0">
                        Bangla Meaning:
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
                        className="flex-1 min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#0d1d16] border border-[#1f3d2f] focus:border-[#10b981] focus:outline-none text-sm text-white"
                      />
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
    </main>
  );
};
