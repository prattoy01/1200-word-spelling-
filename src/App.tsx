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
  type PracticeSessionRecord,
  subscribeToPublishedRecordings,
  saveWordRecording,
  updateRecordingBanglaMeaning,
  deleteWordRecording,
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
import { PWAInstallButton } from './components/PWAInstallButton';
import { OfflineIndicator } from './components/OfflineIndicator';

type FilterTab = 'missing' | 'uploads' | 'all';
type ActiveScreen = 'recordings' | 'practice';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>('recordings');
  const [activeTab, setActiveTab] = useState<FilterTab>('missing');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedWordId, setSelectedWordId] = useState<string>('weekdays');
  const [recordingsMap, setRecordingsMap] = useState<Record<string, CloudRecording>>({});
  const [recentSessions, setRecentSessions] = useState<PracticeSessionRecord[]>([]);

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

  // 1. Track Firebase Auth state and auto-sync any local recordings when user signs in
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);
      if (currentUser) {
        try {
          const syncedCount = await syncLocalRecordingsToCloud();
          if (syncedCount > 0) {
            setStatusBanner({
              type: 'success',
              text: `Synced ${syncedCount} browser recording(s) to Firebase Cloud! Now available across Web, Mobile App, and Incognito.`,
            });
          }
        } catch (err) {
          console.error('Auto-sync error:', err);
        }
      }
    });
    return () => unsubAuth();
  }, []);

  // 2. Load initial local IndexedDB cache immediately, then attach real-time Firestore subscription
  useEffect(() => {
    let isMounted = true;
    getAllLocalCachedRecordings().then((localMap) => {
      if (!isMounted) return;
      const initial: Record<string, CloudRecording> = {};
      for (const [id, item] of Object.entries(localMap)) {
        initial[id] = {
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
          source: item.syncedToCloud ? 'cloud' : 'local-unsynced',
        };
      }
      setRecordingsMap((prev) => ({ ...initial, ...prev }));
    });

    const unsubRecordings = subscribeToPublishedRecordings((cloudAndLocalMap) => {
      if (isMounted) {
        setRecordingsMap(cloudAndLocalMap);
      }
    });

    return () => {
      isMounted = false;
      unsubRecordings();
    };
  }, []);

  // 3. Subscribe to user's practice history when signed in
  useEffect(() => {
    if (!authReady || !user) {
      setRecentSessions([]);
      return;
    }
    const unsubSessions = subscribeToUserPracticeSessions(user.uid, (sessions) => {
      setRecentSessions(sessions);
    });
    return () => unsubSessions();
  }, [authReady, user]);

  // Compute exact counts matching the user's screenshots:
  // Total catalog = 921 (782 Bundled + 139 initially Missing)
  const counts = useMemo(() => {
    let bundledCount = 0;
    let uploadsCount = 0;
    let missingCount = 0;

    for (const item of WORDS_CATALOG) {
      const hasUpload = Boolean(recordingsMap[item.id]);
      if (item.hasBundledAudio) {
        bundledCount++;
      }
      if (hasUpload) {
        uploadsCount++;
      } else if (!item.hasBundledAudio) {
        missingCount++;
      }
    }

    return {
      bundled: bundledCount,
      uploads: uploadsCount,
      missing: missingCount,
      all: WORDS_CATALOG.length,
    };
  }, [recordingsMap]);

  // Filtered words for the active tab & search bar
  const filteredWords: WordItem[] = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return WORDS_CATALOG.filter((item) => {
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
  }, [activeTab, searchQuery, recordingsMap]);

  // Keep selectedWord in sync
  const selectedWord: WordItem = useMemo(() => {
    const found = WORDS_CATALOG.find((w) => w.id === selectedWordId);
    if (found) return found;
    return filteredWords[0] || WORDS_CATALOG[0];
  }, [selectedWordId, filteredWords]);

  const selectedRecording: CloudRecording | undefined = recordingsMap[selectedWord.id];

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
        text: 'Signed in with Google! All recordings you upload on Web or Mobile App now sync in real time.',
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
      if (!auth.currentUser) {
        try {
          await signInWithGoogle();
        } catch {
          // Will save locally if popup was dismissed
        }
      }

      const processed = await processAudioBlob(file, file.name);
      const { syncedToCloud } = await saveWordRecording({
        wordId: selectedWord.id,
        word: selectedWord.word,
        banglaMeaning: banglaInput.trim() || selectedWord.bangla,
        audio: processed,
      });

      await playWordAudio({
        word: selectedWord.word,
        audioDataUrl: processed.audioDataUrl,
      });

      setStatusBanner({
        type: syncedToCloud ? 'success' : 'warning',
        text: syncedToCloud
          ? `Uploaded "${selectedWord.word}" to Firebase Cloud! Immediately available on both Web and Mobile App.`
          : `Saved "${selectedWord.word}" locally. Sign in with Google (top right) so it also syncs to your Mobile App and Incognito!`,
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
      if (!auth.currentUser) {
        try {
          await signInWithGoogle();
        } catch {
          // Continue recording locally if user dismissed sign-in
        }
      }

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
          const ext = (recorder.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
          const processed = await processAudioBlob(
            blob,
            `${selectedWord.id}-mic.${ext}`
          );
          const { syncedToCloud } = await saveWordRecording({
            wordId: selectedWord.id,
            word: selectedWord.word,
            banglaMeaning: banglaInput.trim() || selectedWord.bangla,
            audio: processed,
          });

          await playWordAudio({
            word: selectedWord.word,
            audioDataUrl: processed.audioDataUrl,
          });

          setStatusBanner({
            type: syncedToCloud ? 'success' : 'warning',
            text: syncedToCloud
              ? `Recorded & synced "${selectedWord.word}" to Firebase Cloud! Available across Web, Mobile App, and Incognito.`
              : `Recorded "${selectedWord.word}" locally. Sign in with Google to sync across Web and Mobile App.`,
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

  const handleBanglaBlurOrSave = async () => {
    if (!selectedRecording) return;
    if (banglaInput.trim() === selectedRecording.banglaMeaning) return;
    try {
      await updateRecordingBanglaMeaning({
        recording: selectedRecording,
        newBanglaMeaning: banglaInput,
      });
      setBanglaSavedToast(true);
      setTimeout(() => setBanglaSavedToast(false), 1800);
    } catch (err) {
      console.error('Failed to update Bangla meaning:', err);
    }
  };

  const handleDeleteRecording = async () => {
    if (!selectedRecording) return;
    try {
      await deleteWordRecording(selectedWord.id, selectedRecording.ownerId);
      setStatusBanner({
        type: 'success',
        text: `Removed custom recording for "${selectedWord.word}".`,
      });
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
      if (!auth.currentUser) {
        try {
          await signInWithGoogle();
        } catch {
          // Will still restore locally if popup closed
        }
      }
      const count = await seedScreenshot14RecordingsToCloud((curr, total, w) => {
        setRestoreProgressText(`Syncing ${curr}/${total}: ${w}...`);
      });
      handleSelectTab('uploads');
      setStatusBanner({
        type: auth.currentUser ? 'success' : 'warning',
        text: auth.currentUser
          ? `Restored & Cloud-Synced all ${count} uploads (orienteering, caving, scuba-diving, snorkeling, etc.)! Open the Mobile App or Incognito and all 14 uploads are live!`
          : `Restored all ${count} uploads locally. Sign in with Google (top right) to sync them to your Mobile App and Incognito!`,
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

  const unsyncedLocalCount = useMemo(
    () =>
      Object.values(recordingsMap).filter((r) => r.source === 'local-unsynced')
        .length,
    [recordingsMap]
  );

  return (
    <div className="min-h-screen bg-[#08120e] text-[#e6f2ed] flex flex-col">
      <OfflineIndicator />

      {/* Top Bar Contract: 3 Zones (Brand Wordmark — 4 Single-line Nav Links — 1 Primary Action) */}
      <header className="flex items-center justify-between gap-8 px-4 sm:px-8 py-4 border-b border-[#142920] bg-[#08120e]/95 sticky top-0 z-30 backdrop-blur-md">
        {/* Zone 1: Brand Title */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveScreen('recordings');
          }}
          className="flex items-center gap-3 text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          <span className="w-9 h-9 rounded-full bg-[#10b981] flex items-center justify-center text-[#051a11] font-extrabold shadow-sm">
            <Volume2 className="w-5 h-5" />
          </span>
          <span>
            Listen <span className="font-normal text-[#8ba89a]">&amp;</span> Write
          </span>
        </a>

        {/* Zone 2: 4 Clean Single-Line Navigation Links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-[#9bb8aa]">
          <button
            onClick={() => setActiveScreen('recordings')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeScreen === 'recordings'
                ? 'text-[#10b981] underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Pronunciation Recordings
          </button>
          <button
            onClick={() => setActiveScreen('practice')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeScreen === 'practice'
                ? 'text-[#10b981] underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Spelling Practice
          </button>
          <button
            onClick={handleRestore14Uploads}
            disabled={isRestoring14}
            className="hover:text-[#fbbf24] transition-colors whitespace-nowrap shrink-0"
          >
            {isRestoring14 ? 'Syncing 14 Words...' : 'Restore 14 Uploads'}
          </button>
          <button
            onClick={() => setIsSyncModalOpen(true)}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Mobile App &amp; Link
          </button>
        </nav>

        {/* Zone 3: 1 Primary Action */}
        <div className="flex items-center gap-3 shrink-0">
          {user ? (
            <button
              onClick={() => signOutUser()}
              title={`Signed in as ${user.email} — Click to sign out`}
              className="px-3.5 py-2 text-xs font-semibold text-[#10b981] bg-[#11281e] border border-[#1f4735] rounded-xl hover:bg-[#173528] transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              <CloudCheck className="w-4 h-4" />
              <span>Cloud Synced ({user.displayName || user.email?.split('@')[0]})</span>
              <LogOut className="w-3.5 h-3.5 text-[#7ea090] ml-1" />
            </button>
          ) : (
            <button
              onClick={handleSignIn}
              className="px-4 py-2 text-xs font-bold text-[#04120c] bg-[#10b981] rounded-xl hover:bg-[#059669] transition-colors flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              <LogIn className="w-4 h-4" />
              <span>Sign in for Cloud Sync</span>
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
        />
      ) : (
        <main className="flex-1 max-w-3xl w-full mx-auto px-4 sm:px-6 py-6 space-y-5">
          {/* Top Back Link & Mobile App / Share Link Quick Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              onClick={() => setActiveScreen('practice')}
              className="text-sm font-medium text-[#10b981] hover:text-[#34d399] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to home (IELTS Practice)</span>
            </button>

            <div className="flex flex-wrap items-center gap-2">
              <PWAInstallButton
                onOpenMobileLinkModal={() => setIsSyncModalOpen(true)}
              />

              <button
                type="button"
                onClick={handleCopyQuickLink}
                className="px-3 py-2 rounded-xl bg-[#11261d] hover:bg-[#173327] border border-[#214233] text-xs font-semibold text-[#d2e5dc] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                {copiedQuickLink ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#10b981]" />
                    <span className="text-[#10b981]">App Link Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-[#10b981]" />
                    <span>Copy App Link</span>
                  </>
                )}
              </button>

              {counts.uploads === 0 && (
                <button
                  onClick={handleRestore14Uploads}
                  disabled={isRestoring14}
                  className="px-3 py-2 rounded-xl bg-[#fbbf24]/15 hover:bg-[#fbbf24]/25 border border-[#fbbf24]/40 text-xs font-semibold text-[#fbbf24] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>
                    {isRestoring14
                      ? restoreProgressText || 'Restoring 14 Uploads...'
                      : 'Restore My 14 Screenshot Uploads'}
                  </span>
                </button>
              )}
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
                onClick={() => setStatusBanner(null)}
                className="text-xs underline opacity-80 hover:opacity-100 shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Unsynced Local Recordings Prompt */}
          {!user && unsyncedLocalCount > 0 && (
            <div className="rounded-xl bg-[#1a2412] border border-[#fbbf24]/40 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-[#fde68a]">
                You have <strong>{unsyncedLocalCount}</strong> recording(s) saved only in this browser. Sign in with Google to sync them to <strong>Firebase Cloud</strong> so they appear on your Mobile App and Incognito!
              </div>
              <button
                onClick={handleSignIn}
                className="px-3 py-1.5 rounded-lg bg-[#fbbf24] text-[#08120e] text-xs font-bold hover:bg-[#f59e0b] transition-colors whitespace-nowrap shrink-0"
              >
                Sign in &amp; Sync to Cloud
              </button>
            </div>
          )}

          {/* Main Pronunciation Recordings Card */}
          <section className="rounded-3xl bg-[#0d1b15] border border-[#1c3529] p-5 sm:p-7 space-y-5 shadow-2xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
                  Pronunciation recordings
                </h1>
                <p className="mt-1.5 text-sm text-[#8ca89a] leading-relaxed">
                  Upload or record any word on Web or Mobile. Your recording syncs in real time via Firebase Cloud across your Mobile App, Web browsers, and Incognito.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsSyncModalOpen(true)}
                className="self-start sm:self-center px-3 py-2 rounded-xl bg-[#12281e] hover:bg-[#19382a] border border-[#234b39] text-xs font-semibold text-[#10b981] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span>Web &harr; Mobile Link</span>
              </button>
            </div>

            {/* 3-Column KPI Counter Strip: 782 BUNDLED | YOUR UPLOADS | MISSING */}
            <div className="grid grid-cols-3 rounded-2xl bg-[#0a1611] border border-[#1d362a] divide-x divide-[#1d362a] overflow-hidden">
              <div className="py-4 px-3 text-center">
                <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-[#10b981]">
                  {counts.bundled}
                </div>
                <div className="mt-1 text-[11px] font-semibold tracking-wider text-[#6e8c7d]">
                  BUNDLED
                </div>
              </div>

              <div className="py-4 px-3 text-center">
                <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-[#fbbf24]">
                  {counts.uploads}
                </div>
                <div className="mt-1 text-[11px] font-semibold tracking-wider text-[#6e8c7d]">
                  YOUR UPLOADS
                </div>
              </div>

              <div className="py-4 px-3 text-center">
                <div className="text-2xl sm:text-3xl font-bold font-mono tabular-nums text-[#f87171]">
                  {counts.missing}
                </div>
                <div className="mt-1 text-[11px] font-semibold tracking-wider text-[#6e8c7d]">
                  MISSING
                </div>
              </div>
            </div>

            {/* 3-Tab Segmented Filter Bar: Missing | My uploads | All 921 */}
            <div className="grid grid-cols-3 gap-1.5 p-1.5 rounded-2xl bg-[#09140f] border border-[#193025]">
              <button
                type="button"
                onClick={() => handleSelectTab('missing')}
                className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 ${
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
                className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 ${
                  activeTab === 'uploads'
                    ? 'bg-[#152e23] text-white border border-[#244c3a]'
                    : 'text-[#8ca89a] hover:text-white'
                }`}
              >
                <span>My uploads</span>
                <span className="font-mono tabular-nums text-xs text-[#10b981]">
                  {counts.uploads}
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleSelectTab('all')}
                className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-semibold transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0 ${
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
                className="w-full pl-10 pr-4 py-3 rounded-2xl bg-[#0a1611] border border-[#1d362a] focus:border-[#10b981] focus:outline-none text-sm text-white placeholder-[#668576]"
              />
            </div>

            {/* Scrollable Word List */}
            <div className="rounded-2xl bg-[#0a1611] border border-[#1d362a] max-h-64 overflow-y-auto divide-y divide-[#152920]">
              {filteredWords.length === 0 ? (
                <div className="py-10 px-4 text-center space-y-3">
                  <p className="text-sm text-[#8ca89a]">
                    {activeTab === 'uploads'
                      ? 'No custom recordings uploaded yet.'
                      : 'No words match your search.'}
                  </p>
                  {activeTab === 'uploads' && (
                    <button
                      onClick={handleRestore14Uploads}
                      disabled={isRestoring14}
                      className="px-4 py-2 rounded-xl bg-[#fbbf24] text-[#09140f] text-xs font-bold hover:bg-[#f59e0b] transition-colors inline-flex items-center gap-2"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>Restore &amp; Cloud-Sync Your 14 Screenshot Uploads</span>
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
                      className={`w-full px-4 py-3.5 text-left flex items-center justify-between transition-colors ${
                        isSelected
                          ? 'bg-[#143325] text-[#10b981] font-semibold'
                          : 'text-[#b5cfc2] hover:bg-[#10241b] hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="truncate text-sm">{item.word}</span>
                        {rec && (
                          <span className="text-xs text-[#7ea090] truncate hidden sm:inline">
                            · {rec.banglaMeaning || item.bangla}
                          </span>
                        )}
                      </div>

                      <div className="shrink-0 ml-3 text-xs font-medium">
                        {rec ? (
                          <span className="text-[#fbbf24]">
                            {rec.source === 'cloud' ? 'Your upload · Cloud' : 'Your upload · Local'}
                          </span>
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

          {/* Bottom Active Word Inspector & Upload / Record Panel */}
          <section className="rounded-3xl bg-[#0d1b15] border border-[#1f3b2e] p-5 sm:p-7 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                {selectedWord.word}
              </h2>

              <div className="flex items-center gap-3">
                <span
                  className={`text-xs font-semibold ${
                    selectedRecording
                      ? 'text-[#fbbf24]'
                      : selectedWord.hasBundledAudio
                      ? 'text-[#10b981]'
                      : 'text-[#f87171]'
                  }`}
                >
                  {selectedRecording
                    ? selectedRecording.source === 'cloud'
                      ? 'Your upload · Synced to Web & Mobile'
                      : 'Your upload · Saved in browser'
                    : selectedWord.hasBundledAudio
                    ? 'Bundled'
                    : 'Missing'}
                </span>

                {selectedRecording && (
                  <button
                    type="button"
                    onClick={handleDeleteRecording}
                    title="Delete custom upload"
                    className="p-1.5 rounded-lg text-[#8ca89a] hover:text-[#f87171] hover:bg-[#2a1417] transition-colors"
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
                className="w-full px-4 py-3 rounded-xl bg-[#11241c] border border-[#224535] focus:border-[#10b981] focus:outline-none text-base text-white"
              />
              {banglaSavedToast && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[#10b981] flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" />
                  <span>Saved</span>
                </span>
              )}
            </div>

            {/* Recording Metadata Description */}
            <p className="text-xs text-[#8ca89a]">
              {selectedRecording ? (
                <>
                  Custom recording active ({selectedRecording.fileName} ·{' '}
                  {Math.max(1, Math.round(selectedRecording.fileSize / 1024))} KB).{' '}
                  {selectedRecording.source === 'cloud'
                    ? 'Synced to Firebase Cloud — immediately available on your Mobile App, Web, and Incognito.'
                    : 'Saved locally — sign in with Google so it syncs to your Mobile App.'}
                </>
              ) : (
                'No recording yet. Upload a clear MP3, M4A, OGG or WAV file, or record directly with your phone/PC microphone.'
              )}
            </p>

            {/* Action Buttons Row: Preview | Upload Recording | Record Mic */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() =>
                  playWordAudio({
                    word: selectedWord.word,
                    audioDataUrl: selectedRecording?.audioDataUrl,
                  })
                }
                className="sm:w-44 py-3.5 px-5 rounded-2xl bg-[#0a1611] hover:bg-[#132920] border border-[#214233] text-sm font-semibold text-[#10b981] flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Preview</span>
              </button>

              <label
                className={`flex-1 py-3.5 px-6 rounded-2xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-extrabold text-sm flex items-center justify-center gap-2.5 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                  isUploading ? 'opacity-60 pointer-events-none' : ''
                }`}
              >
                <Upload className="w-4 h-4 stroke-[2.5]" />
                <span>
                  {isUploading
                    ? 'UPLOADING & SYNCING...'
                    : selectedRecording
                    ? 'REPLACE RECORDING'
                    : 'UPLOAD RECORDING'}
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
                className={`py-3.5 px-5 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 border transition-colors whitespace-nowrap shrink-0 ${
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

            <p className="text-[11px] text-[#6d8a7b] leading-relaxed">
              MP3, M4A, OGG or WAV · max 10 MB. Two-way Web &harr; Mobile App sync via Firebase Cloud — upload on Web and play on Mobile, or record on Mobile and play on Web.
            </p>
          </section>
        </main>
      )}

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
