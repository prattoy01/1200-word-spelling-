import React, { useState, useRef } from 'react';
import {
  X,
  Plus,
  Bookmark,
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
} from 'lucide-react';
import {
  type PersonalWordRecord,
  type CloudRecording,
  addOrUpdatePersonalWord,
  removePersonalWord,
  personalWordToWordItem,
} from '../services/recordingsService';
import {
  type ProcessedAudio,
  processAudioBlob,
  playWordAudio,
} from '../utils/audioUtils';

interface PersonalWordsModalProps {
  isOpen: boolean;
  onClose: () => void;
  personalWords: PersonalWordRecord[];
  recordingsMap: Record<string, CloudRecording>;
  onSelectPersonalCategoryForPractice: () => void;
  onSelectPersonalCategoryForTest: () => void;
  onRefreshRecordings: () => Promise<void>;
}

export const PersonalWordsModal: React.FC<PersonalWordsModalProps> = ({
  isOpen,
  onClose,
  personalWords,
  recordingsMap,
  onSelectPersonalCategoryForPractice,
  onSelectPersonalCategoryForTest,
  onRefreshRecordings,
}) => {
  const [wordInput, setWordInput] = useState('');
  const [banglaInput, setBanglaInput] = useState('');
  const [exampleInput, setExampleInput] = useState('');
  const [pendingAudio, setPendingAudio] = useState<ProcessedAudio | null>(null);
  const [isRecordingMic, setIsRecordingMic] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFeedback(null);
    try {
      const processed = await processAudioBlob(file, file.name);
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
            `${wordInput.trim() || 'personal-word'}-mic.wav`
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
      setFeedback({
        type: 'success',
        text: `Added "${saved.word}" to your private Struggling Words list! Only you can see and practice this word.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not add personal word.',
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
        text: `Removed "${rec.word}" from your personal struggling words.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not remove word.',
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-3xl bg-[#0d1f18] border border-[#224837] shadow-2xl overflow-hidden my-6">
        {/* Header */}
        <div className="px-5 sm:px-6 py-4 border-b border-[#193529] flex items-center justify-between bg-[#091510]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#38bdf8]/15 border border-[#38bdf8]/40 flex items-center justify-center text-[#38bdf8] shrink-0">
              <Bookmark className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-extrabold text-white">
                  My Personal Struggling Words ({personalWords.length})
                </h2>
                <span className="px-2 py-0.5 rounded-full bg-[#38bdf8]/15 border border-[#38bdf8]/30 text-[10px] font-bold text-[#7dd3fc] flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5" />
                  <span>Private to You</span>
                </span>
              </div>
              <p className="text-xs text-[#8ba89a] mt-0.5">
                Add any new spelling word you struggle with. It stays strictly private to your account/device only.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-9 h-9 rounded-xl bg-[#132a20] text-[#9bb8aa] hover:text-white flex items-center justify-center transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 sm:p-6 space-y-5 max-h-[80vh] overflow-y-auto">
          {feedback && (
            <div
              className={`p-3.5 rounded-2xl border text-xs flex items-start justify-between gap-2.5 ${
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

          {/* Add New Personal Struggling Word Form */}
          <form
            onSubmit={handleAddWordSubmit}
            className="rounded-2xl bg-[#08130e] border border-[#1d3b2d] p-4 sm:p-5 space-y-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Plus className="w-4 h-4 text-[#10b981]" />
                <span>Add a New Struggling Spelling Word</span>
              </h3>
              <span className="text-[11px] text-[#7ea090]">
                Visible only to you
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

            {/* Optional Personal Pronunciation Audio */}
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
                  <span>Upload Audio</span>
                  <input
                    ref={fileInputRef}
                    type="file"
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
                className="min-h-[42px] px-5 py-2 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs sm:text-sm font-extrabold flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                <Plus className="w-4 h-4 stroke-[2.5]" />
                <span>
                  {isSaving ? 'Saving...' : 'Save to My Struggling Words'}
                </span>
              </button>
            </div>
          </form>

          {/* Quick Practice / Test Buttons if user has personal words */}
          {personalWords.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2.5 p-3.5 rounded-2xl bg-[#0a1913] border border-[#1f4433]">
              <div className="text-xs text-[#b7d1c4]">
                Ready to practice your{' '}
                <strong className="text-white">{personalWords.length}</strong>{' '}
                personal struggling word{personalWords.length === 1 ? '' : 's'}?
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
                  <span>Practice My Words</span>
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
                  <span>Test My Words</span>
                </button>
              </div>
            </div>
          )}

          {/* List of User's Private Struggling Words */}
          <div className="space-y-2.5">
            <div className="text-xs font-bold uppercase tracking-wider text-[#8ba89a]">
              Your Private Struggling Word List ({personalWords.length})
            </div>

            {personalWords.length === 0 ? (
              <div className="rounded-2xl bg-[#08130e] border border-[#183327] py-10 px-4 text-center space-y-2">
                <p className="text-sm font-semibold text-[#c4d9ce]">
                  You haven&apos;t added any personal struggling words yet.
                </p>
                <p className="text-xs text-[#6d8c7d] max-w-md mx-auto">
                  Add any tricky word above (or click the &ldquo;Struggling?&rdquo; button while practicing any word) to build your own private practice deck.
                </p>
              </div>
            ) : (
              <div className="rounded-2xl bg-[#08130e] border border-[#1a3529] divide-y divide-[#142920] max-h-72 overflow-y-auto">
                {personalWords.map((item) => {
                  const wordItem = personalWordToWordItem(item);
                  const customRec = recordingsMap[item.wordId];
                  return (
                    <div
                      key={item.id}
                      className="p-3.5 sm:px-4 flex items-center justify-between gap-3 hover:bg-[#0d1f18] transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-sm sm:text-base text-white break-words">
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
                          title="Remove from My Struggling Words"
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
        </div>
      </div>
    </div>
  );
};
