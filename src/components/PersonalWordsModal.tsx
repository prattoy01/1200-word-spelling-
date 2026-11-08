import React, { useState, useRef, useMemo } from 'react';
import {
  X,
  Plus,
  Star,
  Volume2,
  Trash2,
  Mic,
  Square,
  Upload,
  Play,
  Lock,
  CheckCircle2,
  AlertCircle,
  BookOpenCheck,
  Timer,
  RefreshCw,
  CloudCheck,
  LogIn,
  Search,
} from 'lucide-react';
import {
  type PersonalWordRecord,
  type CloudRecording,
  addOrUpdatePersonalWord,
  removePersonalWord,
  personalWordToWordItem,
  syncPersonalWordsNow,
} from '../services/recordingsService';
import {
  type ProcessedAudio,
  processAudioBlob,
  combineAudioBlobsOrDataUrls,
  playWordAudio,
} from '../utils/audioUtils';
import { WORDS_CATALOG, type WordItem } from '../data/words';
import { auth } from '../firebase';
import { MultiWordAudioBuilder } from './MultiWordAudioBuilder';

interface PersonalWordsModalProps {
  isOpen: boolean;
  onClose: () => void;
  personalWords: PersonalWordRecord[];
  recordingsMap: Record<string, CloudRecording>;
  onSelectPersonalCategoryForPractice: () => void;
  onSelectPersonalCategoryForTest: () => void;
  onRefreshRecordings: () => Promise<void>;
  onSyncPersonalWords?: (words: PersonalWordRecord[]) => void;
  onRequestSignIn?: () => void;
}

export const PersonalWordsModal: React.FC<PersonalWordsModalProps> = ({
  isOpen,
  onClose,
  personalWords,
  recordingsMap,
  onSelectPersonalCategoryForPractice,
  onSelectPersonalCategoryForTest,
  onRefreshRecordings,
  onSyncPersonalWords,
  onRequestSignIn,
}) => {
  const [activeTab, setActiveTab] = useState<'favourites' | 'catalog' | 'custom'>('favourites');
  const [favSearchQuery, setFavSearchQuery] = useState('');
  const [catalogSearchQuery, setCatalogSearchQuery] = useState('');
  const [wordInput, setWordInput] = useState('');
  const [banglaInput, setBanglaInput] = useState('');
  const [exampleInput, setExampleInput] = useState('');
  const [pendingAudio, setPendingAudio] = useState<ProcessedAudio | null>(null);
  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncingAccount, setIsSyncingAccount] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const favWordIdsSet = useMemo(
    () => new Set(personalWords.map((w) => w.wordId)),
    [personalWords]
  );

  const filteredFavourites = useMemo(() => {
    const q = favSearchQuery.trim().toLowerCase();
    if (!q) return personalWords;
    return personalWords.filter(
      (w) =>
        w.word.toLowerCase().includes(q) ||
        (w.bangla || '').toLowerCase().includes(q) ||
        (w.example || '').toLowerCase().includes(q)
    );
  }, [personalWords, favSearchQuery]);

  const filteredCatalogWords = useMemo(() => {
    const q = catalogSearchQuery.trim().toLowerCase();
    if (!q) return WORDS_CATALOG.slice(0, 60);
    return WORDS_CATALOG.filter((item) => {
      const bangla = recordingsMap[item.id]?.banglaMeaning || item.bangla;
      return (
        item.word.toLowerCase().includes(q) ||
        bangla.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    }).slice(0, 80);
  }, [catalogSearchQuery, recordingsMap]);

  if (!isOpen) return null;

  const handleToggleCatalogFavourite = async (item: WordItem) => {
    const isFav = favWordIdsSet.has(item.id);
    try {
      if (isFav) {
        await removePersonalWord(item.id);
        setFeedback({
          type: 'success',
          text: `Removed "${item.word}" from your Favourite Words.`,
        });
      } else {
        const rec = recordingsMap[item.id];
        await addOrUpdatePersonalWord({
          word: item.word,
          bangla: rec?.banglaMeaning || item.bangla,
          example: item.example,
        });
        setFeedback({
          type: 'success',
          text: `Added "${item.word}" to your Favourite Words!`,
        });
      }
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not update favourite word.',
      });
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setFeedback(null);
    try {
      const processed =
        files.length >= 2
          ? await combineAudioBlobsOrDataUrls(
              Array.from(files),
              wordInput.trim() || 'combined-word',
              180
            )
          : await processAudioBlob(files[0], files[0].name);
      setPendingAudio(processed);
      await playWordAudio({
        word: wordInput.trim() || 'preview',
        audioDataUrl: processed.audioDataUrl,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to process audio file.',
      });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleToggleMic = async () => {
    if (isRecordingMic) {
      mediaRecorderRef.current?.stop();
      setIsRecordingMic(false);
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      return;
    }

    setFeedback(null);
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
        try {
          const processed = await processAudioBlob(
            blob,
            `${wordInput.trim() || 'favourite-word'}-mic.wav`
          );
          setPendingAudio(processed);
          await playWordAudio({
            word: wordInput.trim() || 'preview',
            audioDataUrl: processed.audioDataUrl,
          });
        } catch (err) {
          setFeedback({
            type: 'error',
            text:
              err instanceof Error
                ? err.message
                : 'Failed to process microphone audio.',
          });
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
            if (timerIntervalRef.current)
              window.clearInterval(timerIntervalRef.current);
          }
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      setFeedback({
        type: 'error',
        text:
          err instanceof Error
            ? `Microphone access error: ${err.message}`
            : 'Could not access microphone.',
      });
    }
  };

  const handleAddWordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedWord = wordInput.trim();
    if (!trimmedWord) return;

    setIsSaving(true);
    setFeedback(null);
    try {
      const saved = await addOrUpdatePersonalWord({
        word: trimmedWord,
        bangla: banglaInput.trim(),
        example: exampleInput.trim(),
        audio: pendingAudio,
      });
      if (pendingAudio) {
        await onRefreshRecordings();
      }
      setWordInput('');
      setBanglaInput('');
      setExampleInput('');
      setPendingAudio(null);
      setActiveTab('favourites');
      setFeedback({
        type: 'success',
        text: `Added "${saved.word}" to your Favourite Words!`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not add favourite word.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteWord = async (rec: PersonalWordRecord) => {
    try {
      await removePersonalWord(rec.wordId);
      setFeedback({
        type: 'success',
        text: `Removed "${rec.word}" from your Favourite Words.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not remove word.',
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-3xl bg-[#0d1f18] border border-[#224837] shadow-2xl overflow-hidden my-4">
        {/* Header */}
        <div className="px-4 sm:px-6 py-4 border-b border-[#193529] flex items-center justify-between gap-2 bg-[#091510]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-[#fbbf24]/15 border border-[#fbbf24]/40 flex items-center justify-center text-[#fbbf24] shrink-0">
              <Star className="w-5 h-5 fill-[#fbbf24]" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base sm:text-lg font-extrabold text-white truncate">
                  My Favourite Words ({personalWords.length})
                </h2>
                <span className="px-2 py-0.5 rounded-md bg-[#fbbf24]/15 border border-[#fbbf24]/30 text-[10px] font-bold text-[#fde68a] flex items-center gap-1 shrink-0">
                  <Lock className="w-2.5 h-2.5" />
                  <span>Saved to Account</span>
                </span>
              </div>
              <p className="text-xs text-[#8ba89a] mt-0.5 truncate">
                {auth.currentUser
                  ? `Synced for ${
                      auth.currentUser.email || auth.currentUser.displayName
                    }`
                  : 'Mark any word with ★ or add custom words to practice anytime.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={isSyncingAccount}
              onClick={async () => {
                if (!auth.currentUser && onRequestSignIn) {
                  onClose();
                  onRequestSignIn();
                  return;
                }
                setIsSyncingAccount(true);
                setFeedback(null);
                try {
                  const synced = await syncPersonalWordsNow();
                  onSyncPersonalWords?.(synced);
                  setFeedback({
                    type: 'success',
                    text: `Synced ${synced.length} favourite word${
                      synced.length === 1 ? '' : 's'
                    } with your cloud account!`,
                  });
                } catch {
                  setFeedback({
                    type: 'error',
                    text: 'Could not sync right now. Words are safely saved locally.',
                  });
                } finally {
                  setIsSyncingAccount(false);
                }
              }}
              className="min-h-[36px] px-2.5 sm:px-3 py-1.5 rounded-xl bg-[#11281e] hover:bg-[#173528] border border-[#1f4735] text-xs font-bold text-[#10b981] flex items-center gap-1.5 transition-colors"
            >
              {auth.currentUser ? (
                <>
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${
                      isSyncingAccount ? 'animate-spin' : ''
                    }`}
                  />
                  <span className="hidden sm:inline">
                    {isSyncingAccount ? 'Syncing...' : 'Sync'}
                  </span>
                </>
              ) : (
                <>
                  <LogIn className="w-3.5 h-3.5" />
                  <span>Sign In</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-9 h-9 rounded-xl bg-[#132a20] text-[#9bb8aa] hover:text-white flex items-center justify-center transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-4 sm:p-6 space-y-4 max-h-[82vh] overflow-y-auto">
          {/* Quick Practice / Exam Launch Banner */}
          {personalWords.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2.5 p-3.5 rounded-2xl bg-[#141d0f] border border-[#fbbf24]/40">
              <div className="text-xs text-[#e6f2ed]">
                You have{' '}
                <strong className="text-[#fbbf24] font-mono">
                  {personalWords.length}
                </strong>{' '}
                favourite word{personalWords.length === 1 ? '' : 's'} ready for practice or strict testing.
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onSelectPersonalCategoryForPractice();
                    onClose();
                  }}
                  className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold flex items-center gap-1.5 transition-colors"
                >
                  <BookOpenCheck className="w-3.5 h-3.5" />
                  <span>Practice Favourites</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onSelectPersonalCategoryForTest();
                    onClose();
                  }}
                  className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#fbbf24] hover:bg-[#f59e0b] text-[#08120e] text-xs font-extrabold flex items-center gap-1.5 transition-colors"
                >
                  <Timer className="w-3.5 h-3.5" />
                  <span>Exam on Favourites</span>
                </button>
              </div>
            </div>
          )}

          {/* 3-Tab Switcher: My Favourites | Mark from 921 Words | + Add Custom Word */}
          <div className="grid grid-cols-3 gap-1.5 p-1 rounded-2xl bg-[#08130e] border border-[#1a3529]">
            <button
              type="button"
              onClick={() => setActiveTab('favourites')}
              className={`min-h-[40px] px-2 py-1.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                activeTab === 'favourites'
                  ? 'bg-[#fbbf24] text-[#08120e]'
                  : 'text-[#9bb8aa] hover:text-white'
              }`}
            >
              <Star
                className={`w-3.5 h-3.5 shrink-0 ${
                  activeTab === 'favourites' ? 'fill-[#08120e]' : 'text-[#fbbf24]'
                }`}
              />
              <span className="truncate">Favourites ({personalWords.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('catalog')}
              className={`min-h-[40px] px-2 py-1.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                activeTab === 'catalog'
                  ? 'bg-[#10b981] text-[#04120c]'
                  : 'text-[#9bb8aa] hover:text-white'
              }`}
            >
              <Search className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Mark from 921</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('custom')}
              className={`min-h-[40px] px-2 py-1.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                activeTab === 'custom'
                  ? 'bg-[#38bdf8] text-[#04120c]'
                  : 'text-[#9bb8aa] hover:text-white'
              }`}
            >
              <Plus className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">+ Custom Word</span>
            </button>
          </div>

          {feedback && (
            <div
              className={`p-3 rounded-2xl border text-xs flex items-start justify-between gap-2.5 ${
                feedback.type === 'success'
                  ? 'bg-[#0e291e] border-[#10b981]/40 text-[#a7f3d0]'
                  : 'bg-[#2a1215] border-[#f87171]/40 text-[#fecaca]'
              }`}
            >
              <div className="flex items-start gap-2">
                {feedback.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-[#10b981] shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-[#f87171] shrink-0 mt-0.5" />
                )}
                <span>{feedback.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="text-[11px] underline opacity-80 hover:opacity-100 shrink-0"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* TAB 1: MY FAVOURITE WORDS LIST */}
          {activeTab === 'favourites' && (
            <div className="space-y-3">
              {personalWords.length > 3 && (
                <div className="relative">
                  <Search className="w-4 h-4 text-[#668576] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={favSearchQuery}
                    onChange={(e) => setFavSearchQuery(e.target.value)}
                    placeholder="Search your favourite words..."
                    className="w-full min-h-[42px] pl-10 pr-4 py-2 rounded-xl bg-[#08130e] border border-[#1d3b2d] text-xs sm:text-sm text-white placeholder-[#5a7a6b] focus:outline-none focus:border-[#fbbf24]"
                  />
                </div>
              )}

              {personalWords.length === 0 ? (
                <div className="rounded-2xl bg-[#08130e] border border-[#183327] py-10 px-4 text-center space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-[#fbbf24]/15 border border-[#fbbf24]/30 flex items-center justify-center text-[#fbbf24] mx-auto">
                    <Star className="w-6 h-6" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-white">
                      No Favourite Words Marked Yet
                    </p>
                    <p className="text-xs text-[#8ba89a] max-w-md mx-auto">
                      Tap the <strong className="text-[#fbbf24]">★ Favourite</strong> star button on any word while practicing, browse the 921 IELTS words, or add your own custom word.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setActiveTab('catalog')}
                      className="min-h-[38px] px-4 py-2 rounded-xl bg-[#10b981] text-[#04120c] text-xs font-extrabold flex items-center gap-1.5"
                    >
                      <Search className="w-3.5 h-3.5" />
                      <span>Browse &amp; Mark from 921 Words</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('custom')}
                      className="min-h-[38px] px-4 py-2 rounded-xl bg-[#13291f] border border-[#244b39] text-[#7dd3fc] text-xs font-bold flex items-center gap-1.5"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Custom Word</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl bg-[#08130e] border border-[#1a3529] divide-y divide-[#142920] max-h-80 overflow-y-auto">
                  {filteredFavourites.map((item) => {
                    const wordItem = personalWordToWordItem(item);
                    const customRec = recordingsMap[item.wordId];
                    return (
                      <div
                        key={item.id}
                        className="p-3.5 sm:px-4 flex items-center justify-between gap-3 hover:bg-[#0d1f18] transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Star className="w-3.5 h-3.5 fill-[#fbbf24] text-[#fbbf24] shrink-0" />
                            <span className="font-bold font-mono text-sm sm:text-base text-white break-words">
                              {item.word}
                            </span>
                            {item.bangla && (
                              <span className="text-xs text-[#10b981] font-medium">
                                ({item.bangla})
                              </span>
                            )}
                            {customRec?.isPersonalOverride && (
                              <span className="px-2 py-0.5 rounded bg-[#38bdf8]/15 text-[#38bdf8] text-[10px] font-bold">
                                Custom Voice
                              </span>
                            )}
                          </div>
                          {item.example && (
                            <p className="text-[11px] text-[#7ea090] mt-0.5 truncate">
                              {item.example}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              playWordAudio({
                                word: wordItem.word,
                                audioDataUrl: customRec?.audioDataUrl,
                                bundledAudioFile: wordItem.bundledAudioFile,
                              })
                            }
                            className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#12281e] hover:bg-[#19382a] border border-[#234b39] text-xs font-bold text-[#10b981] flex items-center gap-1"
                          >
                            <Volume2 className="w-3.5 h-3.5" />
                            <span>Listen</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleDeleteWord(item)}
                            title="Remove from Favourite Words"
                            className="min-h-[36px] px-2.5 py-1.5 rounded-xl bg-[#2a1215] hover:bg-[#3b181c] text-[#f87171] text-xs flex items-center justify-center"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: QUICK-MARK FROM 921 IELTS CATALOG WORDS */}
          {activeTab === 'catalog' && (
            <div className="space-y-3">
              <div className="relative">
                <Search className="w-4 h-4 text-[#668576] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={catalogSearchQuery}
                  onChange={(e) => setCatalogSearchQuery(e.target.value)}
                  placeholder="Search 921 IELTS words by English, Bangla, or Category..."
                  className="w-full min-h-[42px] pl-10 pr-4 py-2 rounded-xl bg-[#08130e] border border-[#1d3b2d] text-xs sm:text-sm text-white placeholder-[#5a7a6b] focus:outline-none focus:border-[#10b981]"
                />
              </div>

              <div className="rounded-2xl bg-[#08130e] border border-[#1a3529] divide-y divide-[#142920] max-h-80 overflow-y-auto">
                {filteredCatalogWords.map((item) => {
                  const isFav = favWordIdsSet.has(item.id);
                  const customRec = recordingsMap[item.id];
                  const bangla = customRec?.banglaMeaning || item.bangla;
                  return (
                    <div
                      key={item.id}
                      className="p-3 sm:px-4 flex items-center justify-between gap-2.5 hover:bg-[#0d1f18] transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold font-mono text-sm text-white">
                            {item.word}
                          </span>
                          <span className="text-xs text-[#10b981]">
                            ({bangla})
                          </span>
                        </div>
                        <div className="text-[11px] text-[#6d8c7d]">
                          Page {item.page} · {item.category}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            playWordAudio({
                              word: item.word,
                              audioDataUrl: customRec?.audioDataUrl,
                              bundledAudioFile: item.bundledAudioFile,
                            })
                          }
                          className="min-h-[36px] px-2.5 py-1.5 rounded-xl bg-[#12281e] hover:bg-[#19382a] border border-[#234b39] text-xs font-bold text-[#10b981] flex items-center gap-1"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleToggleCatalogFavourite(item)}
                          className={`min-h-[36px] px-3 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 transition-colors ${
                            isFav
                              ? 'bg-[#29200e] border-[#fbbf24] text-[#fbbf24]'
                              : 'bg-[#12281e] hover:bg-[#19382a] border-[#234b39] text-[#d2e5dc]'
                          }`}
                        >
                          <Star
                            className={`w-3.5 h-3.5 shrink-0 ${
                              isFav ? 'fill-[#fbbf24] text-[#fbbf24]' : ''
                            }`}
                          />
                          <span>{isFav ? 'Favourited' : 'Add Favourite'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 3: ADD NEW CUSTOM WORD TO FAVOURITES */}
          {activeTab === 'custom' && (
            <form
              onSubmit={handleAddWordSubmit}
              className="rounded-2xl bg-[#08130e] border border-[#1d3b2d] p-4 sm:p-5 space-y-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Plus className="w-4 h-4 text-[#10b981]" />
                  <span>Add Any Custom Word to Favourites</span>
                </h3>
                <span className="text-[11px] text-[#7ea090]">
                  Saved to your Favourites
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9bb8aa] mb-1">
                    English Word or Phrase *
                  </label>
                  <input
                    type="text"
                    required
                    value={wordInput}
                    onChange={(e) => setWordInput(e.target.value)}
                    placeholder="e.g. accommodation, questionnaire..."
                    className="w-full min-h-[42px] px-3.5 py-2 rounded-xl bg-[#0d1f18] border border-[#224736] text-sm text-white placeholder-[#5a7a6b] focus:outline-none focus:border-[#10b981]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9bb8aa] mb-1">
                    Bangla Meaning (Optional)
                  </label>
                  <input
                    type="text"
                    value={banglaInput}
                    onChange={(e) => setBanglaInput(e.target.value)}
                    placeholder="বাংলা অর্থ (ঐচ্ছিক)..."
                    className="w-full min-h-[42px] px-3.5 py-2 rounded-xl bg-[#0d1f18] border border-[#224736] text-sm text-white placeholder-[#5a7a6b] focus:outline-none focus:border-[#10b981]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[#9bb8aa] mb-1">
                  Spelling Hint / Example Note (Optional)
                </label>
                <input
                  type="text"
                  value={exampleInput}
                  onChange={(e) => setExampleInput(e.target.value)}
                  placeholder="e.g. Double C and Double M (ac-com-mo-da-tion)"
                  className="w-full min-h-[40px] px-3.5 py-2 rounded-xl bg-[#0d1f18] border border-[#224736] text-xs text-white placeholder-[#5a7a6b] focus:outline-none focus:border-[#10b981]"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleToggleMic}
                    className={`min-h-[38px] px-3.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 border transition-colors ${
                      isRecordingMic
                        ? 'bg-[#dc2626] border-[#f87171] text-white'
                        : 'bg-[#12281e] hover:bg-[#19382a] border-[#234b39] text-[#d2e5dc]'
                    }`}
                  >
                    {isRecordingMic ? (
                      <>
                        <Square className="w-3.5 h-3.5 fill-current" />
                        <span>Stop Mic ({recordingSeconds}s)</span>
                      </>
                    ) : (
                      <>
                        <Mic className="w-3.5 h-3.5 text-[#10b981]" />
                        <span>Record Voice (Optional)</span>
                      </>
                    )}
                  </button>

                  <label className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#12281e] hover:bg-[#19382a] border border-[#234b39] text-xs font-semibold text-[#d2e5dc] flex items-center gap-1.5 cursor-pointer transition-colors">
                    <Upload className="w-3.5 h-3.5 text-[#fbbf24]" />
                    <span>Upload Audio (1 or Multiple Files)</span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="audio/*"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </label>

                  {pendingAudio && (
                    <button
                      type="button"
                      onClick={() =>
                        playWordAudio({
                          word: wordInput.trim() || 'preview',
                          audioDataUrl: pendingAudio.audioDataUrl,
                        })
                      }
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#10b981]/15 border border-[#10b981]/40 text-xs font-bold text-[#10b981] flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Custom Audio Ready</span>
                    </button>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={isSaving || !wordInput.trim()}
                  className="min-h-[42px] px-5 py-2 rounded-xl bg-[#fbbf24] hover:bg-[#f59e0b] text-[#08120e] text-xs sm:text-sm font-extrabold flex items-center gap-1.5 transition-colors disabled:opacity-50"
                >
                  <Star className="w-4 h-4 fill-current" />
                  <span>
                    {isSaving ? 'Saving...' : 'Save to Favourite Words'}
                  </span>
                </button>
              </div>

              {wordInput.trim().length > 0 && (
                <MultiWordAudioBuilder
                  phrase={wordInput.trim()}
                  recordingsMap={recordingsMap}
                  saveButtonLabel="Combine & Attach to This Custom Word"
                  onCombinedAudioReady={async (combinedAudio, partsCount) => {
                    setPendingAudio(combinedAudio);
                    setFeedback({
                      type: 'success',
                      text: `Combined ${partsCount} word clips for "${wordInput.trim()}"! Now click "Save to Favourite Words" above.`,
                    });
                    await playWordAudio({
                      word: wordInput.trim() || 'preview',
                      audioDataUrl: combinedAudio.audioDataUrl,
                    });
                  }}
                />
              )}
            </form>
          )}

          {/* Account Sync Footer */}
          <div className="rounded-2xl bg-[#091712] border border-[#1d3d2f] px-4 py-2.5 flex items-center gap-2 text-xs text-[#a7f3d0]">
            <CloudCheck className="w-4 h-4 text-[#10b981] shrink-0" />
            <span>
              {auth.currentUser ? (
                <>
                  <strong>Account Sync Active:</strong> Your favourite words sync automatically across all your devices.
                </>
              ) : (
                <>
                  <strong>Local + Cloud Sync:</strong> Sign in anytime to sync your favourite words across phone and PC.
                </>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
