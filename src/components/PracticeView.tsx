import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Volume2,
  RotateCcw,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Mic,
  Eye,
  EyeOff,
  Award,
  Gauge,
  ListMusic,
} from 'lucide-react';
import { WORDS_CATALOG, CATEGORIES, type WordItem } from '../data/words';
import type {
  CloudRecording,
  PracticeSessionRecord,
} from '../services/recordingsService';
import { savePracticeSession } from '../services/recordingsService';
import { playWordAudio } from '../utils/audioUtils';

interface PracticeViewProps {
  recordingsMap: Record<string, CloudRecording>;
  onOpenRecordingsManager: (wordId?: string) => void;
  recentSessions: PracticeSessionRecord[];
}

export const PracticeView: React.FC<PracticeViewProps> = ({
  recordingsMap,
  onOpenRecordingsManager,
  recentSessions,
}) => {
  const [selectedCategory, setSelectedCategory] =
    useState<string>('All Categories');
  const [deckMode, setDeckMode] = useState<'all' | 'uploads' | 'missing'>('all');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [userInput, setUserInput] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [showBanglaHint, setShowBanglaHint] = useState(true);
  const [sessionStats, setSessionStats] = useState({ attempted: 0, correct: 0 });
  const [isPlaying, setIsPlaying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredDeck: WordItem[] = useMemo(() => {
    return WORDS_CATALOG.filter((item) => {
      if (
        selectedCategory !== 'All Categories' &&
        item.category !== selectedCategory
      ) {
        return false;
      }
      const hasCustom = Boolean(recordingsMap[item.id]);
      if (deckMode === 'uploads') return hasCustom;
      if (deckMode === 'missing') return !item.hasBundledAudio && !hasCustom;
      return true;
    });
  }, [selectedCategory, deckMode, recordingsMap]);

  const currentWord: WordItem | undefined =
    filteredDeck[currentIndex % Math.max(1, filteredDeck.length)];

  const activeRecording = currentWord ? recordingsMap[currentWord.id] : undefined;
  const displayBangla =
    activeRecording?.banglaMeaning || currentWord?.bangla || '';

  useEffect(() => {
    setCurrentIndex(0);
    setUserInput('');
    setSubmitted(false);
  }, [selectedCategory, deckMode]);

  const handlePlay = async (rate = 1.0) => {
    if (!currentWord) return;
    setIsPlaying(true);
    try {
      await playWordAudio({
        word: currentWord.word,
        audioDataUrl: activeRecording?.audioDataUrl,
        playbackRate: rate,
      });
    } finally {
      setTimeout(() => setIsPlaying(false), 650);
    }
  };

  const isCorrect =
    currentWord &&
    userInput.trim().toLowerCase() === currentWord.word.trim().toLowerCase();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentWord) return;

    if (!submitted) {
      if (!userInput.trim()) {
        void handlePlay(1.0);
        return;
      }
      setSubmitted(true);
      const nextAttempted = sessionStats.attempted + 1;
      const nextCorrect = sessionStats.correct + (isCorrect ? 1 : 0);
      setSessionStats({ attempted: nextAttempted, correct: nextCorrect });

      if (nextAttempted % 5 === 0) {
        void savePracticeSession({
          category: selectedCategory,
          totalWords: 5,
          correctCount: isCorrect ? 1 : 0,
        });
      }
    } else {
      handleNextWord();
    }
  };

  const handleNextWord = () => {
    setSubmitted(false);
    setUserInput('');
    setCurrentIndex((prev) => (prev + 1) % Math.max(1, filteredDeck.length));
  };

  const accuracyPct =
    sessionStats.attempted > 0
      ? Math.round((sessionStats.correct / sessionStats.attempted) * 100)
      : 100;

  return (
    <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 pt-5 pb-28 md:py-8 space-y-6">
      {/* Mobile Quick Switch Banner to Pronunciation Recordings Manager */}
      <div className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-[#0e2219] border border-[#1f4433]">
        <div className="min-w-0">
          <div className="text-xs font-bold text-[#10b981]">
            Want to upload or manage word recordings?
          </div>
          <div className="text-[11px] text-[#9ab5a7] truncate">
            782 Bundled · {Object.keys(recordingsMap).length} Cloud Uploads
          </div>
        </div>
        <button
          type="button"
          onClick={() => onOpenRecordingsManager(currentWord?.id)}
          className="min-h-[44px] px-4 py-2 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          <ListMusic className="w-4 h-4" />
          <span>Open Recordings</span>
        </button>
      </div>

      {/* Top Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-[#183126]">
        <div>
          <h1 className="text-xl sm:text-3xl font-bold text-white tracking-tight">
            IELTS Listening &amp; Spelling Practice
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-[#8ba89a]">
            Listen to each word and type the exact IELTS spelling. Custom Cloud uploads automatically take priority.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
          {/* Segmented Deck Filter */}
          <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[#0d1d16] border border-[#1c382b]">
            <button
              type="button"
              onClick={() => setDeckMode('all')}
              className={`min-h-[40px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                deckMode === 'all'
                  ? 'bg-[#183529] text-[#10b981]'
                  : 'text-[#8ba89a] hover:text-white'
              }`}
            >
              All ({WORDS_CATALOG.length})
            </button>
            <button
              type="button"
              onClick={() => setDeckMode('uploads')}
              className={`min-h-[40px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                deckMode === 'uploads'
                  ? 'bg-[#183529] text-[#fbbf24]'
                  : 'text-[#8ba89a] hover:text-white'
              }`}
            >
              Uploads ({Object.keys(recordingsMap).length})
            </button>
            <button
              type="button"
              onClick={() => setDeckMode('missing')}
              className={`min-h-[40px] px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                deckMode === 'missing'
                  ? 'bg-[#183529] text-[#f87171]'
                  : 'text-[#8ba89a] hover:text-white'
              }`}
            >
              Missing
            </button>
          </div>

          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#0d1d16] border border-[#1c382b] text-xs font-medium text-white focus:outline-none focus:border-[#10b981]"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Two-Zone Practice Sandbox */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left Interactive Stage (8 cols) */}
        <div className="lg:col-span-8 rounded-2xl bg-[#0d1d16] border border-[#1d382b] p-4 sm:p-8 space-y-5">
          {!currentWord ? (
            <div className="py-12 text-center space-y-3">
              <p className="text-base text-[#9ab5a7]">
                No words match this filter yet.
              </p>
              <button
                type="button"
                onClick={() => {
                  setDeckMode('all');
                  setSelectedCategory('All Categories');
                }}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-[#10b981] text-[#04120c] text-xs font-bold"
              >
                Reset Filter
              </button>
            </div>
          ) : (
            <>
              {/* Word Metadata & Audio Source Line (Clean Mobile Single-Line Layout) */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-[#162d22] text-xs text-[#8ba89a]">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono tabular-nums font-semibold text-[#10b981] whitespace-nowrap">
                    Word {(currentIndex % filteredDeck.length) + 1} of{' '}
                    {filteredDeck.length}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="whitespace-nowrap">{currentWord.category}</span>
                  <span aria-hidden="true">·</span>
                  <span
                    className={`whitespace-nowrap ${
                      activeRecording
                        ? 'text-[#fbbf24] font-semibold'
                        : currentWord.hasBundledAudio
                        ? 'text-[#10b981]'
                        : 'text-[#f87171]'
                    }`}
                  >
                    {activeRecording
                      ? 'Cloud Upload Active'
                      : currentWord.hasBundledAudio
                      ? 'Bundled Voice'
                      : 'Browser Voice'}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => onOpenRecordingsManager(currentWord.id)}
                  className="self-start sm:self-auto min-h-[36px] text-xs font-semibold text-[#10b981] hover:underline flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Mic className="w-3.5 h-3.5" />
                  <span>
                    {activeRecording ? 'Edit / Replace Audio' : 'Upload Custom Audio'}
                  </span>
                </button>
              </div>

              {/* Audio Playback Controls (Thumb-Friendly Full Width on Mobile) */}
              <div className="space-y-2.5">
                <button
                  type="button"
                  onClick={() => handlePlay(1.0)}
                  className={`w-full min-h-[52px] py-3.5 px-5 rounded-xl font-bold text-sm flex items-center justify-center gap-2.5 transition-colors active:scale-[0.99] ${
                    isPlaying
                      ? 'bg-[#059669] text-white'
                      : 'bg-[#10b981] hover:bg-[#059669] text-[#04120c]'
                  }`}
                >
                  <Volume2 className="w-5 h-5 shrink-0" />
                  <span className="whitespace-nowrap">
                    Play Pronunciation (1.0x)
                  </span>
                </button>

                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => handlePlay(0.72)}
                    className="min-h-[46px] py-2.5 px-3 rounded-xl bg-[#13291f] hover:bg-[#1a372a] border border-[#234435] text-xs font-semibold text-[#d2e5dc] flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                  >
                    <Gauge className="w-4 h-4 text-[#10b981] shrink-0" />
                    <span>Slow (0.75x)</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowBanglaHint((v) => !v)}
                    className="min-h-[46px] py-2.5 px-3 rounded-xl bg-[#13291f] hover:bg-[#1a372a] border border-[#234435] text-xs font-semibold text-[#d2e5dc] flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                  >
                    {showBanglaHint ? (
                      <>
                        <EyeOff className="w-4 h-4 text-[#8ba89a] shrink-0" />
                        <span>Hide Meaning</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-4 h-4 text-[#10b981] shrink-0" />
                        <span>Show Meaning</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Bangla Meaning Box */}
              {showBanglaHint && (
                <div className="rounded-xl bg-[#11241b] border border-[#1f3d2f] px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] text-[#7ea090]">
                      Bangla Meaning / Clue
                    </div>
                    <div className="text-base font-medium text-white mt-0.5 break-words">
                      {displayBangla}
                    </div>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-[#7ea090] whitespace-nowrap shrink-0">
                    {currentWord.word.length} letters
                  </span>
                </div>
              )}

              {/* Spelling Input Form */}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="spelling-input"
                    className="block text-xs font-medium text-[#8ba89a] mb-2"
                  >
                    Type the exact word or phrase you hear:
                  </label>
                  <input
                    id="spelling-input"
                    ref={inputRef}
                    type="text"
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    disabled={submitted}
                    placeholder="Type the word you hear..."
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="done"
                    className="w-full min-h-[50px] px-4 py-3 rounded-xl bg-[#08130e] border border-[#224234] focus:border-[#10b981] focus:outline-none text-base sm:text-lg font-medium text-white placeholder-[#4c6b5c]"
                  />
                </div>

                {submitted && (
                  <div
                    className={`rounded-xl p-4 border flex items-start justify-between gap-4 ${
                      isCorrect
                        ? 'bg-[#0f291e] border-[#10b981]/50 text-[#a7f3d0]'
                        : 'bg-[#2a1215] border-[#f87171]/50 text-[#fecaca]'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {isCorrect ? (
                        <CheckCircle2 className="w-5 h-5 text-[#10b981] shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="w-5 h-5 text-[#f87171] shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="text-sm font-bold">
                          {isCorrect
                            ? 'Correct Spelling!'
                            : 'Check Spelling Carefully'}
                        </div>
                        <div className="mt-1 text-sm">
                          Correct Answer:{' '}
                          <strong className="font-mono text-white underline decoration-[#10b981]">
                            {currentWord.word}
                          </strong>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 sm:flex sm:items-center sm:justify-between gap-3 pt-1">
                  <button
                    type="button"
                    onClick={handleNextWord}
                    className="min-h-[48px] px-4 py-2.5 rounded-xl bg-[#13291f] hover:bg-[#1a372a] text-xs font-semibold text-[#9ab5a7] hover:text-white transition-colors"
                  >
                    Skip Word
                  </button>

                  <button
                    type="submit"
                    className="min-h-[48px] px-6 py-3 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-bold text-sm flex items-center justify-center gap-2 transition-colors"
                  >
                    <span>{submitted ? 'Next Word' : 'Check Spelling'}</span>
                    <ArrowRight className="w-4 h-4 shrink-0" />
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        {/* Right Session Telemetry & Progress Deck (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="rounded-2xl bg-[#0d1d16] border border-[#1d382b] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Award className="w-4 h-4 text-[#10b981]" />
                <span>Current Session Score</span>
              </h2>
              <button
                type="button"
                onClick={() => setSessionStats({ attempted: 0, correct: 0 })}
                className="min-h-[36px] px-2 text-xs text-[#8ba89a] hover:text-white flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset</span>
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 pt-1 text-center">
              <div className="p-3 rounded-xl bg-[#08130e] border border-[#183126]">
                <div className="text-xl font-bold font-mono tabular-nums text-[#10b981]">
                  {sessionStats.correct}
                </div>
                <div className="text-[11px] text-[#8ba89a] mt-0.5">Correct</div>
              </div>
              <div className="p-3 rounded-xl bg-[#08130e] border border-[#183126]">
                <div className="text-xl font-bold font-mono tabular-nums text-white">
                  {sessionStats.attempted}
                </div>
                <div className="text-[11px] text-[#8ba89a] mt-0.5">Attempted</div>
              </div>
              <div className="p-3 rounded-xl bg-[#08130e] border border-[#183126]">
                <div className="text-xl font-bold font-mono tabular-nums text-[#fbbf24]">
                  {accuracyPct}%
                </div>
                <div className="text-[11px] text-[#8ba89a] mt-0.5">Accuracy</div>
              </div>
            </div>
          </div>

          {/* Cloud-Synced Recent Practice History */}
          <div className="rounded-2xl bg-[#0d1d16] border border-[#1d382b] p-5 space-y-3">
            <h3 className="text-xs font-semibold text-[#8ba89a]">
              Recent Cloud Practice History
            </h3>
            {recentSessions.length === 0 ? (
              <p className="text-xs text-[#698778]">
                Complete 5 words while signed in to save your spelling accuracy across devices.
              </p>
            ) : (
              <div className="space-y-2">
                {recentSessions.slice(0, 5).map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between text-xs py-2 border-b border-[#162d22] last:border-0"
                  >
                    <span className="text-[#d2e5dc] truncate max-w-[160px]">
                      {s.category}
                    </span>
                    <span className="font-mono tabular-nums text-[#10b981]">
                      {s.correctCount}/{s.totalWords} ({s.accuracy}%)
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
