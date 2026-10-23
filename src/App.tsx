/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Play,
  Upload,
  Mic,
  Square,
  Search,
  Trash2,
  CloudCheck,
  Sparkles,
  Check,
  Volume2,
  Smartphone,
  Copy,
  LogIn,
  LogOut,
  ArrowLeft,
  ListMusic,
  BookOpenCheck,
  Timer,
  Layers,
  ShieldCheck,
  Send,
} from 'lucide-react';
import {
  auth,
  onAuthStateChanged,
  signInWithGoogle,
  signOutUser,
  type User,
} from './firebase';
import { WORDS_CATALOG, type WordItem } from './data/words';
import {
  type CloudRecording,
  type AudioContributionRecord,
  type PracticeSessionRecord,
  subscribeToPublishedRecordings,
  subscribeToAudioContributions,
  saveWordRecording,
  submitAudioContribution,
  updateRecordingBanglaMeaning,
  deleteWordRecording,
  removePersonalRecordingOverride,
  syncLocalRecordingsToCloud,
  seedScreenshot14RecordingsToCloud,
  subscribeToUserPracticeSessions,
} from './services/recordingsService';
import {
  processAudioBlob,
  playWordAudio,
  getAllLocalCachedRecordings,
} from './utils/audioUtils';
import { NetlifyFixModal, getActiveAppUrl } from './components/NetlifyFixModal';
import { PracticeView } from './components/PracticeView';
import { AdminPanelView } from './components/AdminPanelView';
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';

type FilterTab = 'missing' | 'uploads' | 'all';
type ActiveScreen = 'recordings' | 'practice' | 'admin';
type RecordingsPageFilter = 'all' | 'page1' | 'page2';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>('practice');
  const [practiceSubMode, setPracticeSubMode] = useState<'practice' | 'test'>('practice');
  const [activeTab, setActiveTab] = useState<FilterTab>('missing');
  const [recordingsPageFilter, setRecordingsPageFilter] = useState<RecordingsPageFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedWordId, setSelectedWordId] = useState<string>('weekdays');

  // Effective recordingsMap: User's Personal Audio Override > General Cloud Audio
  const [recordingsMap, setRecordingsMap] = useState<Record<string, CloudRecording>>({});
  // Raw General Cloud Audio Map (Admin-approved general audio for all users)
  const [generalRecordingsMap, setGeneralRecordingsMap] = useState<Record<string, CloudRecording>>({});
  // Community contributions queue for Admin Panel
  const [contributions, setContributions] = useState<AudioContributionRecord[]>([]);
  const [recentSessions, setRecentSessions] = useState<PracticeSessionRecord[]>([]);

  // Contribution options when uploading/recording personal audio
  const [contributeOnSave, setContributeOnSave] = useState<boolean>(true);
  const [contributorNameInput, setContributorNameInput] = useState<string>('');
  const [isSubmittingContribution, setIsSubmittingContribution] = useState<boolean>(false);

  // Selected word editable Bangla input
  const [banglaInput, setBanglaInput] = useState<string>('কর্মদিবস');
  const [banglaSavedToast, setBanglaSavedToast] = useState(false);
  const [copiedQuickLink, setCopiedQuickLink] = useState(false);

  // Audio upload / live microphone recording states
  const [isUploading, setIsUploading] = useState(false);
  const [statusBanner, setStatusBanner] = useState<{
    type: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cloud Sync & Migration Modal
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isRestoring14, setIsRestoring14] = useState(false);
  const [restoreProgressText, setRestoreProgressText] = useState('');

  // 1. Track Firebase Auth state
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);
      if (currentUser) {
        if (!contributorNameInput && currentUser.displayName) {
          setContributorNameInput(currentUser.displayName);
        }
        try {
          await syncLocalRecordingsToCloud();
        } catch (err) {
          console.error('Auto-sync error:', err);
        }
      }
    });
    return () => unsubAuth();
  }, []);

  // 2. Load initial local IndexedDB cache immediately, then attach real-time Firestore subscription
  const refreshLocalAndCloudState = async (
    generalSnapshotMap?: Record<string, CloudRecording>
  ) => {
    const localMap = await getAllLocalCachedRecordings();
    const baseGeneral = generalSnapshotMap || generalRecordingsMap;
    const merged: Record<string, CloudRecording> = { ...baseGeneral };

    for (const [id, item] of Object.entries(localMap)) {
      if (item.isPersonalOverride || !baseGeneral[id]) {
        merged[id] = {
          wordId: item.wordId,
          word: item.word,
          banglaMeaning: item.banglaMeaning,
          audioDataUrl: item.audioDataUrl,
          mimeType: item.mimeType,
          fileName: item.fileName,
          fileSize: item.fileSize,
          durationMs: item.durationMs,
          ownerId: item.ownerId,
          ownerName: item.ownerName,
          status: 'published',
          updatedAtMs: item.updatedAtMs,
          source: item.isPersonalOverride
            ? 'personal'
            : item.syncedToCloud
            ? 'cloud'
            : 'local-unsynced',
          isPersonalOverride: Boolean(item.isPersonalOverride),
          contributedToAdmin: Boolean(item.contributedToAdmin),
        };
      }
    }
    setRecordingsMap(merged);
  };

  useEffect(() => {
    let isMounted = true;
    void refreshLocalAndCloudState();

    const unsubRecordings = subscribeToPublishedRecordings(
      (cloudAndLocalMap) => {
        if (isMounted) {
          setRecordingsMap(cloudAndLocalMap);
        }
      },
      (generalOnlyMap) => {
        if (isMounted) {
          setGeneralRecordingsMap(generalOnlyMap);
        }
      }
    );

    const unsubContributions = subscribeToAudioContributions((list) => {
      if (isMounted) {
        setContributions(list);
      }
    });

    return () => {
      isMounted = false;
      unsubRecordings();
      unsubContributions();
    };
  }, []);

  // 3. Subscribe to user's practice & exam history (works with or without Google login)
  useEffect(() => {
    if (!authReady) return;
    const unsubSessions = subscribeToUserPracticeSessions(
      user?.uid || 'cloud_studio_shared',
      (sessions) => {
        setRecentSessions(sessions);
      }
    );
    return () => unsubSessions();
  }, [authReady, user]);

  // Compute exact counts:
  // Total catalog = 921 (782 Bundled + Custom Personal/General Uploads + Missing)
  const counts = useMemo(() => {
    let bundledCount = 0;
    let uploadsCount = 0;
    let personalCount = 0;
    let missingCount = 0;

    for (const item of WORDS_CATALOG) {
      const rec = recordingsMap[item.id];
      const hasUpload = Boolean(rec);
      if (item.hasBundledAudio) {
        bundledCount++;
      }
      if (hasUpload) {
        uploadsCount++;
        if (rec?.isPersonalOverride) {
          personalCount++;
        }
      } else if (!item.hasBundledAudio) {
        missingCount++;
      }
    }

    return {
      bundled: bundledCount,
      uploads: uploadsCount,
      personal: personalCount,
      missing: missingCount,
      all: WORDS_CATALOG.length,
    };
  }, [recordingsMap]);

  const pendingContributionsCount = useMemo(
    () => contributions.filter((c) => c.status === 'pending').length,
    [contributions]
  );

  // Filtered words for the active tab, Page 1/Page 2 filter & search bar
  const filteredWords: WordItem[] = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return WORDS_CATALOG.filter((item) => {
      if (recordingsPageFilter === 'page1' && item.page !== 1) return false;
      if (recordingsPageFilter === 'page2' && item.page !== 2) return false;
      const hasUpload = Boolean(recordingsMap[item.id]);
      if (activeTab === 'missing' && (item.hasBundledAudio || hasUpload)) {
        return false;
      }
      if (activeTab === 'uploads' && !hasUpload) {
        return false;
      }
      if (q) {
        const customBangla = recordingsMap[item.id]?.banglaMeaning || item.bangla;
        return (
          item.word.toLowerCase().includes(q) ||
          customBangla.toLowerCase().includes(q) ||
          item.category.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [activeTab, recordingsPageFilter, searchQuery, recordingsMap]);

  // Keep selectedWord in sync
  const selectedWord: WordItem = useMemo(() => {
    const found = WORDS_CATALOG.find((w) => w.id === selectedWordId);
    if (found) return found;
    return filteredWords[0] || WORDS_CATALOG[0];
  }, [selectedWordId, filteredWords]);

  const selectedRecording: CloudRecording | undefined = recordingsMap[selectedWord.id];
  const selectedGeneralRecording: CloudRecording | undefined =
    generalRecordingsMap[selectedWord.id];

  // Update Bangla input field whenever selected word changes
  useEffect(() => {
    const customBangla = recordingsMap[selectedWord.id]?.banglaMeaning;
    setBanglaInput(customBangla !== undefined ? customBangla : selectedWord.bangla);
  }, [selectedWord, recordingsMap]);

  const handleSelectTab = (tab: FilterTab) => {
    setActiveTab(tab);
    const firstMatch = WORDS_CATALOG.find((item) => {
      const hasUpload = Boolean(recordingsMap[item.id]);
      if (tab === 'missing') return !item.hasBundledAudio && !hasUpload;
      if (tab === 'uploads') return hasUpload;
      return true;
    });
    if (firstMatch) {
      setSelectedWordId(firstMatch.id);
    }
  };

  const handleSignIn = async () => {
    try {
      await signInWithGoogle();
      setStatusBanner({
        type: 'success',
        text: 'Signed in with Google!',
      });
    } catch (err) {
      setStatusBanner({
        type: 'error',
        text: `Google Sign-In did not complete: ${err instanceof Error ? err.message : 'Popup closed'}`,
      });
    }
  };

  const handleCopyQuickLink = () => {
    navigator.clipboard.writeText(getActiveAppUrl());
    setCopiedQuickLink(true);
    setTimeout(() => setCopiedQuickLink(false), 2000);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setStatusBanner(null);
    try {
      const processed = await processAudioBlob(file, file.name);
      const { contributedToAdmin } = await saveWordRecording({
        wordId: selectedWord.id,
        word: selectedWord.word,
        banglaMeaning: banglaInput.trim() || selectedWord.bangla,
        audio: processed,
        contributeToAdmin: contributeOnSave,
        contributorName:
          contributorNameInput.trim() ||
          user?.displayName ||
          user?.email?.split('@')[0] ||
          'Community Member',
      });

      await refreshLocalAndCloudState();

      await playWordAudio({
        word: selectedWord.word,
        audioDataUrl: processed.audioDataUrl,
        bundledAudioFile: selectedWord.bundledAudioFile,
      });

      setStatusBanner({
        type: 'success',
        text: contributedToAdmin
          ? `Saved "${selectedWord.word}" as your Personal Audio AND submitted to the Admin Panel for review!`
          : `Saved "${selectedWord.word}" as your Personal Audio! Your app will always use this audio for you and won't be overwritten by general updates.`,
      });
    } catch (err) {
      setStatusBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to upload recording.',
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleStartStopMicRecording = async () => {
    if (isRecordingMic) {
      mediaRecorderRef.current?.stop();
      setIsRecordingMic(false);
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) {
          recordedChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        if (blob.size === 0) return;

        setIsUploading(true);
        try {
          const processed = await processAudioBlob(
            blob,
            `${selectedWord.id}-mic.wav`
          );
          const { contributedToAdmin } = await saveWordRecording({
            wordId: selectedWord.id,
            word: selectedWord.word,
            banglaMeaning: banglaInput.trim() || selectedWord.bangla,
            audio: processed,
            contributeToAdmin: contributeOnSave,
            contributorName:
              contributorNameInput.trim() ||
              user?.displayName ||
              user?.email?.split('@')[0] ||
              'Community Member',
          });

          await refreshLocalAndCloudState();

          await playWordAudio({
            word: selectedWord.word,
            audioDataUrl: processed.audioDataUrl,
          });

          setStatusBanner({
            type: 'success',
            text: contributedToAdmin
              ? `Recorded "${selectedWord.word}" as your Personal Audio AND sent to the Admin Panel for review!`
              : `Recorded "${selectedWord.word}" as your Personal Audio! It will never be overwritten by general updates.`,
          });
        } catch (err) {
          setStatusBanner({
            type: 'error',
            text: err instanceof Error ? err.message : 'Failed to save microphone recording.',
          });
        } finally {
          setIsUploading(false);
        }
      };

      recorder.start();
      setIsRecordingMic(true);
      setRecordingSeconds(0);
      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((s) => {
          if (s >= 9) {
            recorder.stop();
            setIsRecordingMic(false);
            if (timerIntervalRef.current) window.clearInterval(timerIntervalRef.current);
          }
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      setStatusBanner({
        type: 'error',
        text:
          err instanceof Error
            ? `Microphone access error: ${err.message}`
            : 'Could not access microphone.',
      });
    }
  };

  const handleSubmitExistingPersonalToAdmin = async () => {
    if (!selectedRecording) return;
    setIsSubmittingContribution(true);
    setStatusBanner(null);
    try {
      await submitAudioContribution({
        wordId: selectedWord.id,
        word: selectedWord.word,
        banglaMeaning: banglaInput.trim() || selectedRecording.banglaMeaning || selectedWord.bangla,
        audio: {
          audioDataUrl: selectedRecording.audioDataUrl,
          mimeType: selectedRecording.mimeType,
          fileName: selectedRecording.fileName,
          fileSize: selectedRecording.fileSize,
          durationMs: selectedRecording.durationMs,
        },
        contributorNameOverride:
          contributorNameInput.trim() ||
          user?.displayName ||
          user?.email?.split('@')[0] ||
          selectedRecording.ownerName ||
          'Community Member',
      });
      await refreshLocalAndCloudState();
      setStatusBanner({
        type: 'success',
        text: `Submitted "${selectedWord.word}" to the Admin Panel! Once Admin accepts it, it will update the General Audio for all users who don't have their own personal audio.`,
      });
    } catch (err) {
      setStatusBanner({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Failed to submit contribution to Admin Panel.',
      });
    } finally {
      setIsSubmittingContribution(false);
    }
  };

  const handleBanglaBlurOrSave = async () => {
    if (!selectedRecording) return;
    if (banglaInput.trim() === selectedRecording.banglaMeaning) return;
    try {
      await updateRecordingBanglaMeaning({
        recording: selectedRecording,
        newBanglaMeaning: banglaInput,
      });
      await refreshLocalAndCloudState();
      setBanglaSavedToast(true);
      setTimeout(() => setBanglaSavedToast(false), 1800);
    } catch (err) {
      console.error('Failed to update Bangla meaning:', err);
    }
  };

  const handleDeleteRecording = async () => {
    if (!selectedRecording) return;
    try {
      if (selectedRecording.isPersonalOverride) {
        await removePersonalRecordingOverride(selectedWord.id);
        await refreshLocalAndCloudState();
        setStatusBanner({
          type: 'success',
          text: `Removed your Personal Audio override for "${selectedWord.word}". Now using General App Audio.`,
        });
      } else {
        await deleteWordRecording(selectedWord.id, selectedRecording.ownerId, true);
        await refreshLocalAndCloudState();
        setStatusBanner({
          type: 'success',
          text: `Removed General Audio for "${selectedWord.word}".`,
        });
      }
    } catch (err) {
      setStatusBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not delete recording.',
      });
    }
  };

  const handleRestore14Uploads = async () => {
    setIsRestoring14(true);
    setStatusBanner(null);
    try {
      const count = await seedScreenshot14RecordingsToCloud((curr, total, w) => {
        setRestoreProgressText(`Syncing ${curr}/${total}: ${w}...`);
      });
      handleSelectTab('uploads');
      setStatusBanner({
        type: 'success',
        text: `Restored & Cloud-Synced all ${count} General Audios (orienteering, caving, scuba-diving, snorkeling, etc.)!`,
      });
    } catch (err) {
      setStatusBanner({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to restore 14 recordings.',
      });
    } finally {
      setIsRestoring14(false);
      setRestoreProgressText('');
    }
  };

  return (
    <div className="min-h-screen bg-[#08120e] text-[#e6f2ed] flex flex-col">
      <OfflineIndicator />

      {/* Top Bar Contract: 3 Zones (Brand Wordmark — Single-line Nav Links — Primary Action) */}
      <header className="flex items-center justify-between gap-4 sm:gap-8 px-4 sm:px-8 py-3.5 border-b border-[#142920] bg-[#08120e]/95 sticky top-0 z-30 backdrop-blur-md">
        {/* Zone 1: Brand Title */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveScreen('practice');
            setPracticeSubMode('practice');
          }}
          className="flex items-center gap-2.5 text-base sm:text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          <span className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-[#10b981] flex items-center justify-center text-[#051a11] font-extrabold shadow-sm shrink-0">
            <Volume2 className="w-4 h-4 sm:w-5 sm:h-5" />
          </span>
          <span>
            Listen <span className="font-normal text-[#8ba89a]">&amp;</span> Write
          </span>
        </a>

        {/* Zone 2: Clean Single-Line Navigation Links (Desktop) */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-[#9bb8aa]">
          <button
            type="button"
            onClick={() => {
              setActiveScreen('practice');
              setPracticeSubMode('practice');
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeScreen === 'practice' && practiceSubMode === 'practice'
                ? 'text-[#10b981] underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Practice &amp; Categories
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveScreen('practice');
              setPracticeSubMode('test');
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeScreen === 'practice' && practiceSubMode === 'test'
                ? 'text-[#fbbf24] underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Take Strict Test
          </button>
          <button
            type="button"
            onClick={() => setActiveScreen('recordings')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeScreen === 'recordings'
                ? 'text-[#10b981] underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Recordings ({counts.uploads})
          </button>
          <button
            type="button"
            onClick={() => setActiveScreen('admin')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
              activeScreen === 'admin'
                ? 'text-[#10b981] underline underline-offset-8 decoration-2 font-bold'
                : ''
            }`}
          >
            <ShieldCheck className="w-4 h-4 text-[#10b981]" />
            <span>Admin Panel</span>
            {pendingContributionsCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-[#fbbf24] text-[#08120e] text-[10px] font-extrabold font-mono">
                {pendingContributionsCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setIsSyncModalOpen(true)}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Mobile App &amp; Link
          </button>
        </nav>

        {/* Zone 3: 1 Primary Action */}
        <div className="flex items-center gap-2 shrink-0">
          {user ? (
            <button
              type="button"
              onClick={() => signOutUser()}
              title={`Signed in as ${user.email} — Tap to sign out`}
              className="min-h-[40px] px-3 py-1.5 text-xs font-semibold text-[#10b981] bg-[#11281e] border border-[#1f4735] rounded-xl hover:bg-[#173528] transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <CloudCheck className="w-4 h-4 shrink-0" />
              <span className="max-w-[130px] sm:max-w-none truncate">
                {user.displayName || user.email?.split('@')[0] || 'Synced'}
              </span>
              <LogOut className="w-3.5 h-3.5 text-[#7ea090] ml-0.5 shrink-0" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSignIn}
              className="min-h-[40px] px-3.5 py-1.5 text-xs font-bold text-[#04120c] bg-[#10b981] rounded-xl hover:bg-[#059669] transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <LogIn className="w-4 h-4 shrink-0" />
              <span>Sign in</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      {activeScreen === 'practice' ? (
        <PracticeView
          recordingsMap={recordingsMap}
          onOpenRecordingsManager={(wordId) => {
            if (wordId) setSelectedWordId(wordId);
            setActiveScreen('recordings');
          }}
          recentSessions={recentSessions}
          activeSubMode={practiceSubMode}
          onSubModeChange={(mode) => setPracticeSubMode(mode)}
        />
      ) : activeScreen === 'admin' ? (
        <AdminPanelView
          contributions={contributions}
          generalRecordingsMap={generalRecordingsMap}
          personalRecordingsMap={recordingsMap}
          userEmail={user?.email}
          onBackToPractice={() => setActiveScreen('practice')}
          onRestore14General={handleRestore14Uploads}
          isRestoring14={isRestoring14}
        />
      ) : (
        <main className="flex-1 max-w-3xl w-full mx-auto px-4 sm:px-6 pt-5 pb-28 md:py-6 space-y-5">
          {/* Top Back Link & Admin Panel / Mobile App Quick Actions */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <button
              type="button"
              onClick={() => setActiveScreen('practice')}
              className="min-h-[42px] text-xs sm:text-sm font-semibold text-[#10b981] hover:text-[#34d399] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to home (IELTS Practice)</span>
            </button>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveScreen('admin')}
                className="min-h-[40px] px-3 py-2 rounded-xl bg-[#10b981]/15 hover:bg-[#10b981]/25 border border-[#10b981]/40 text-xs font-bold text-[#10b981] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>
                  Admin Panel
                  {pendingContributionsCount > 0
                    ? ` (${pendingContributionsCount} Pending)`
                    : ''}
                </span>
              </button>

              <PWAInstallButton
                onOpenMobileLinkModal={() => setIsSyncModalOpen(true)}
              />

              <button
                type="button"
                onClick={handleCopyQuickLink}
                className="min-h-[40px] px-3 py-2 rounded-xl bg-[#11261d] hover:bg-[#173327] border border-[#214233] text-xs font-semibold text-[#d2e5dc] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                {copiedQuickLink ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#10b981]" />
                    <span className="text-[#10b981]">Link Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-[#10b981]" />
                    <span>Copy Link</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Status Notification Banner */}
          {statusBanner && (
            <div
              className={`rounded-xl px-4 py-3 border text-xs flex items-center justify-between gap-3 ${
                statusBanner.type === 'success'
                  ? 'bg-[#0e291e] border-[#10b981]/40 text-[#a7f3d0]'
                  : statusBanner.type === 'warning'
                  ? 'bg-[#29200e] border-[#fbbf24]/40 text-[#fde68a]'
                  : 'bg-[#2c1215] border-[#f87171]/40 text-[#fecaca]'
              }`}
            >
              <span>{statusBanner.text}</span>
              <button
                type="button"
                onClick={() => setStatusBanner(null)}
                className="text-xs underline opacity-80 hover:opacity-100 shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Main Pronunciation Recordings Card */}
          <section className="rounded-3xl bg-[#0d1b15] border border-[#1c3529] p-4 sm:p-7 space-y-4 sm:space-y-5 shadow-2xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
                  Personal Audio &amp; Community Contributions
                </h1>
                <p className="mt-1 text-xs sm:text-sm text-[#8ca89a] leading-relaxed">
                  Upload or record any word for <strong>yourself</strong> (your personal audio will never be overwritten by general updates), and optionally <strong>contribute it to the Admin Panel</strong> to help update the General Audio for other users!
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsSyncModalOpen(true)}
                className="self-start sm:self-center min-h-[40px] px-3 py-2 rounded-xl bg-[#12281e] hover:bg-[#19382a] border border-[#234b39] text-xs font-semibold text-[#10b981] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span>Web &harr; Mobile Sync</span>
              </button>
            </div>

            {/* 3-Column KPI Counter Strip: 782 BUNDLED | CUSTOM / GENERAL | MISSING */}
            <div className="grid grid-cols-3 rounded-2xl bg-[#0a1611] border border-[#1d362a] divide-x divide-[#1d362a] overflow-hidden">
              <div className="py-3.5 sm:py-4 px-2 text-center">
                <div className="text-xl sm:text-3xl font-bold font-mono tabular-nums text-[#10b981]">
                  {counts.bundled}
                </div>
                <div className="mt-1 text-[10px] sm:text-[11px] font-semibold tracking-wider text-[#6e8c7d]">
                  BUNDLED
                </div>
              </div>

              <div className="py-3.5 sm:py-4 px-2 text-center">
                <div className="text-xl sm:text-3xl font-bold font-mono tabular-nums text-[#fbbf24]">
                  {counts.uploads}
                </div>
                <div className="mt-1 text-[10px] sm:text-[11px] font-semibold tracking-wider text-[#6e8c7d]">
                  CUSTOM ({counts.personal} PERSONAL)
                </div>
              </div>

              <div className="py-3.5 sm:py-4 px-2 text-center">
                <div className="text-xl sm:text-3xl font-bold font-mono tabular-nums text-[#f87171]">
                  {counts.missing}
                </div>
                <div className="mt-1 text-[10px] sm:text-[11px] font-semibold tracking-wider text-[#6e8c7d]">
                  MISSING
                </div>
              </div>
            </div>

            {/* Page 1 / Page 2 Selector inside Recordings Manager */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <span className="text-xs font-semibold text-[#8ca89a] flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-[#10b981]" />
                <span>Filter by Word Book Page:</span>
              </span>
              <div className="inline-flex rounded-xl bg-[#09140f] border border-[#193025] p-1 gap-1">
                {(
                  [
                    { id: 'page1', label: 'Page 1 (447)' },
                    { id: 'page2', label: 'Page 2 (474)' },
                    { id: 'all', label: 'All (921)' },
                  ] as const
                ).map((pg) => (
                  <button
                    key={pg.id}
                    type="button"
                    onClick={() => setRecordingsPageFilter(pg.id)}
                    className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${
                      recordingsPageFilter === pg.id
                        ? 'bg-[#10b981] text-[#04120c]'
                        : 'text-[#8ca89a] hover:text-white'
                    }`}
                  >
                    {pg.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 3-Tab Segmented Filter Bar: Missing | Custom & General | All 921 */}
            <div className="grid grid-cols-3 gap-1 p-1 rounded-2xl bg-[#09140f] border border-[#193025]">
              <button
                type="button"
                onClick={() => handleSelectTab('missing')}
                className={`min-h-[44px] py-2 px-2 rounded-xl text-xs sm:text-sm font-semibold transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
                  activeTab === 'missing'
                    ? 'bg-[#152e23] text-white border border-[#244c3a]'
                    : 'text-[#8ca89a] hover:text-white'
                }`}
              >
                <span>Missing</span>
                <span className="font-mono tabular-nums text-xs text-[#10b981]">
                  {counts.missing}
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleSelectTab('uploads')}
                className={`min-h-[44px] py-2 px-2 rounded-xl text-xs sm:text-sm font-semibold transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
                  activeTab === 'uploads'
                    ? 'bg-[#152e23] text-white border border-[#244c3a]'
                    : 'text-[#8ca89a] hover:text-white'
                }`}
              >
                <span>Custom / General</span>
                <span className="font-mono tabular-nums text-xs text-[#10b981]">
                  {counts.uploads}
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleSelectTab('all')}
                className={`min-h-[44px] py-2 px-2 rounded-xl text-xs sm:text-sm font-semibold transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
                  activeTab === 'all'
                    ? 'bg-[#152e23] text-white border border-[#244c3a]'
                    : 'text-[#8ca89a] hover:text-white'
                }`}
              >
                <span>All</span>
                <span className="font-mono tabular-nums text-xs text-[#8ca89a]">
                  {counts.all}
                </span>
              </button>
            </div>

            {/* Search Input */}
            <div className="relative">
              <Search className="w-4 h-4 text-[#668576] absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search words..."
                className="w-full min-h-[46px] pl-10 pr-4 py-2.5 rounded-2xl bg-[#0a1611] border border-[#1d362a] focus:border-[#10b981] focus:outline-none text-sm text-white placeholder-[#668576]"
              />
            </div>

            {/* Scrollable Word List */}
            <div className="rounded-2xl bg-[#0a1611] border border-[#1d362a] max-h-64 overflow-y-auto divide-y divide-[#152920]">
              {filteredWords.length === 0 ? (
                <div className="py-10 px-4 text-center space-y-3">
                  <p className="text-sm text-[#8ca89a]">
                    {activeTab === 'uploads'
                      ? 'No custom or general recordings uploaded yet.'
                      : 'No words match your search.'}
                  </p>
                  {activeTab === 'uploads' && (
                    <button
                      type="button"
                      onClick={handleRestore14Uploads}
                      disabled={isRestoring14}
                      className="min-h-[44px] px-4 py-2 rounded-xl bg-[#fbbf24] text-[#09140f] text-xs font-bold hover:bg-[#f59e0b] transition-colors inline-flex items-center gap-2"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>Restore 14 Default General Uploads</span>
                    </button>
                  )}
                </div>
              ) : (
                filteredWords.slice(0, 150).map((item) => {
                  const isSelected = item.id === selectedWord.id;
                  const rec = recordingsMap[item.id];
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedWordId(item.id)}
                      className={`w-full min-h-[48px] px-4 py-3 text-left flex items-center justify-between transition-colors ${
                        isSelected
                          ? 'bg-[#143325] text-[#10b981] font-semibold'
                          : 'text-[#b5cfc2] hover:bg-[#10241b] hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate text-sm">{item.word}</span>
                        {rec && (
                          <span className="text-xs text-[#7ea090] truncate hidden sm:inline">
                            · {rec.banglaMeaning || item.bangla}
                          </span>
                        )}
                      </div>

                      <div className="shrink-0 ml-3 text-xs font-medium whitespace-nowrap">
                        {rec ? (
                          rec.isPersonalOverride ? (
                            <span className="text-[#38bdf8] font-bold">
                              My Personal Audio
                            </span>
                          ) : (
                            <span className="text-[#fbbf24]">
                              General App Audio
                            </span>
                          )
                        ) : item.hasBundledAudio ? (
                          <span className="text-[#10b981]">Bundled</span>
                        ) : (
                          <span className="text-[#f87171]">Missing</span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {/* Bottom Active Word Inspector & Personal Upload + Contribute to Admin Panel */}
          <section className="rounded-3xl bg-[#0d1b15] border border-[#1f3b2e] p-4 sm:p-7 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl sm:text-3xl font-extrabold text-white tracking-tight truncate">
                {selectedWord.word}
              </h2>

              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={`text-xs font-semibold whitespace-nowrap ${
                    selectedRecording?.isPersonalOverride
                      ? 'text-[#38bdf8]'
                      : selectedRecording
                      ? 'text-[#fbbf24]'
                      : selectedWord.hasBundledAudio
                      ? 'text-[#10b981]'
                      : 'text-[#f87171]'
                  }`}
                >
                  {selectedRecording
                    ? selectedRecording.isPersonalOverride
                      ? 'My Personal Audio (Locked for You)'
                      : 'General App Audio (Admin Approved)'
                    : selectedWord.hasBundledAudio
                    ? 'Bundled'
                    : 'Missing'}
                </span>

                {selectedRecording && (
                  <button
                    type="button"
                    onClick={handleDeleteRecording}
                    title={
                      selectedRecording.isPersonalOverride
                        ? 'Remove Personal Audio override (revert to General Audio)'
                        : 'Remove General Audio'
                    }
                    className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-[#8ca89a] hover:text-[#f87171] hover:bg-[#2a1417] transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Editable Bangla Meaning Box */}
            <div className="relative">
              <input
                type="text"
                value={banglaInput}
                onChange={(e) => setBanglaInput(e.target.value)}
                onBlur={handleBanglaBlurOrSave}
                placeholder="বাংলা অর্থ লিখুন..."
                className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-[#11241c] border border-[#224535] focus:border-[#10b981] focus:outline-none text-base text-white"
              />
              {banglaSavedToast && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#10b981] flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" />
                  <span>Saved</span>
                </span>
              )}
            </div>

            {/* Contribute to Admin Panel Toggle Box */}
            <div className="rounded-2xl bg-[#09140f] border border-[#1c382b] p-3.5 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <label className="flex items-start gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={contributeOnSave}
                    onChange={(e) => setContributeOnSave(e.target.checked)}
                    className="mt-0.5 w-4 h-4 accent-[#10b981] rounded"
                  />
                  <div className="text-xs">
                    <span className="font-bold text-white block">
                      Contribute new recording to Admin Panel for General Audio
                    </span>
                    <span className="text-[#8ca89a]">
                      Your recording is always saved as <strong>your Personal Audio</strong> first. If checked, it is also sent to the Admin Panel so the Admin can accept it for users who haven&apos;t set a personal audio.
                    </span>
                  </div>
                </label>

                {selectedRecording?.isPersonalOverride && (
                  <button
                    type="button"
                    disabled={isSubmittingContribution}
                    onClick={handleSubmitExistingPersonalToAdmin}
                    className="self-start sm:self-center min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#fbbf24] hover:bg-[#f59e0b] text-[#08120e] text-xs font-extrabold flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>
                      {isSubmittingContribution
                        ? 'Sending...'
                        : selectedRecording.contributedToAdmin
                        ? 'Resend to Admin Panel'
                        : 'Contribute to Admin Panel'}
                    </span>
                  </button>
                )}
              </div>

              {contributeOnSave && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-1 border-t border-[#152b21]">
                  <label className="text-[11px] font-semibold text-[#8ca89a] shrink-0">
                    Your Name (shown to Admin):
                  </label>
                  <input
                    type="text"
                    value={contributorNameInput}
                    onChange={(e) => setContributorNameInput(e.target.value)}
                    placeholder={
                      user?.displayName ||
                      user?.email?.split('@')[0] ||
                      'Enter your name (optional)...'
                    }
                    className="flex-1 min-h-[36px] px-3 py-1 rounded-lg bg-[#0d1b15] border border-[#1f3d2f] text-xs text-white focus:outline-none focus:border-[#10b981]"
                  />
                </div>
              )}
            </div>

            {/* Recording Metadata Description */}
            <p className="text-xs text-[#8ca89a]">
              {selectedRecording ? (
                selectedRecording.isPersonalOverride ? (
                  <>
                    <strong className="text-[#38bdf8]">Personal Audio Active</strong> (
                    {selectedRecording.fileName} ·{' '}
                    {Math.max(1, Math.round(selectedRecording.fileSize / 1024))} KB). Your app will always play this personal recording for you, even if the Admin updates the General Audio.
                    {selectedGeneralRecording && (
                      <>
                        {' '}
                        (A General App Audio also exists — click the trash icon if you ever want to switch back to General Audio.)
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <strong className="text-[#fbbf24]">General App Audio Active</strong> (
                    {selectedRecording.fileName} ·{' '}
                    {Math.max(1, Math.round(selectedRecording.fileSize / 1024))} KB · Approved by Admin). Upload or record below if you want to set your own Personal Audio for this word.
                  </>
                )
              ) : selectedWord.bundledAudioFile ? (
                <>
                  Original bundled recording active (
                  <code className="text-[#10b981] font-mono">
                    {`audio-${selectedWord.originalId}.${selectedWord.bundledAudioFile.endsWith('.ogg') ? 'ogg' : 'mp3'}`}
                  </code>
                  ). Tap Preview to listen, or upload/record to set your Personal Audio &amp; contribute to Admin.
                </>
              ) : (
                'No custom upload yet (uses dictionary audio fallback). Upload a clear MP3, M4A, OGG or WAV file, or record with your microphone to set your Personal Audio & contribute to Admin.'
              )}
            </p>

            {/* Action Buttons Row: Preview | Upload Recording | Record Mic */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() =>
                  playWordAudio({
                    word: selectedWord.word,
                    audioDataUrl: selectedRecording?.audioDataUrl,
                    bundledAudioFile: selectedWord.bundledAudioFile,
                  })
                }
                className="min-h-[48px] sm:w-40 py-3 px-5 rounded-2xl bg-[#0a1611] hover:bg-[#132920] border border-[#214233] text-sm font-semibold text-[#10b981] flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Preview</span>
              </button>

              <label
                className={`min-h-[48px] flex-1 py-3 px-5 rounded-2xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-extrabold text-sm flex items-center justify-center gap-2 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                  isUploading ? 'opacity-60 pointer-events-none' : ''
                }`}
              >
                <Upload className="w-4 h-4 stroke-[2.5]" />
                <span>
                  {isUploading
                    ? 'SAVING AUDIO...'
                    : selectedRecording?.isPersonalOverride
                    ? 'REPLACE PERSONAL AUDIO'
                    : 'SET PERSONAL AUDIO'}
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/mp3,audio/mpeg,audio/mp4,audio/x-m4a,audio/m4a,audio/ogg,audio/wav,audio/webm,audio/*"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>

              <button
                type="button"
                onClick={handleStartStopMicRecording}
                className={`min-h-[48px] py-3 px-5 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 border transition-colors whitespace-nowrap shrink-0 ${
                  isRecordingMic
                    ? 'bg-[#dc2626] border-[#f87171] text-white'
                    : 'bg-[#11241c] hover:bg-[#183328] border-[#244938] text-[#d5e8de]'
                }`}
              >
                {isRecordingMic ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Stop ({recordingSeconds}s)</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-4 h-4 text-[#10b981]" />
                    <span>Record Mic</span>
                  </>
                )}
              </button>
            </div>
          </section>
        </main>
      )}

      {/* Fixed Mobile Bottom Navigation Bar (Visible on Phone Viewports) */}
      <nav
        aria-label="Mobile navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#08120e]/95 backdrop-blur-md border-t border-[#183327] grid grid-cols-4 items-center h-16 px-2"
      >
        <button
          type="button"
          onClick={() => {
            setActiveScreen('practice');
            setPracticeSubMode('practice');
          }}
          className={`flex flex-col items-center justify-center h-full rounded-xl transition-colors ${
            activeScreen === 'practice' && practiceSubMode === 'practice'
              ? 'text-[#10b981] font-bold'
              : 'text-[#8ba89a]'
          }`}
        >
          <BookOpenCheck className="w-5 h-5" />
          <span className="text-[10px] mt-1 whitespace-nowrap">
            Practice
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveScreen('practice');
            setPracticeSubMode('test');
          }}
          className={`flex flex-col items-center justify-center h-full rounded-xl transition-colors ${
            activeScreen === 'practice' && practiceSubMode === 'test'
              ? 'text-[#fbbf24] font-bold'
              : 'text-[#8ba89a]'
          }`}
        >
          <Timer className="w-5 h-5" />
          <span className="text-[10px] mt-1 whitespace-nowrap">
            Take Test
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveScreen('recordings')}
          className={`flex flex-col items-center justify-center h-full rounded-xl transition-colors ${
            activeScreen === 'recordings'
              ? 'text-[#10b981] font-bold'
              : 'text-[#8ba89a]'
          }`}
        >
          <ListMusic className="w-5 h-5" />
          <span className="text-[10px] mt-1 whitespace-nowrap">
            Recordings ({counts.uploads})
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveScreen('admin')}
          className={`relative flex flex-col items-center justify-center h-full rounded-xl transition-colors ${
            activeScreen === 'admin'
              ? 'text-[#10b981] font-bold'
              : 'text-[#8ba89a]'
          }`}
        >
          <ShieldCheck className="w-5 h-5" />
          <span className="text-[10px] mt-1 whitespace-nowrap">
            Admin {pendingContributionsCount > 0 ? `(${pendingContributionsCount})` : ''}
          </span>
        </button>
      </nav>

      {/* Web <-> Mobile Link & Cloud Sync Modal */}
      <NetlifyFixModal
        isOpen={isSyncModalOpen}
        onClose={() => setIsSyncModalOpen(false)}
        recordingsMap={recordingsMap}
        isSignedIn={Boolean(user)}
        onSignIn={handleSignIn}
        onRestore14Uploads={handleRestore14Uploads}
        isRestoring14={isRestoring14}
        restoreProgressText={restoreProgressText}
      />
    </div>
  );
}
