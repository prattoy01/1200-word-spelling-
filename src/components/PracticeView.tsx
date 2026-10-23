import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
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
  Timer,
  Lock,
  Play,
  Layers,
  FolderOpen,
  ShieldAlert,
  Trophy,
  Check,
  ChevronRight,
  X,
  FileText,
} from 'lucide-react';
import { WORDS_CATALOG, CATEGORIES, type WordItem } from '../data/words';
import type {
  CloudRecording,
  PracticeSessionRecord,
  SessionWordResult,
} from '../services/recordingsService';
import { savePracticeSession } from '../services/recordingsService';
import { playWordAudio } from '../utils/audioUtils';

interface PracticeViewProps {
  recordingsMap: Record<string, CloudRecording>;
  onOpenRecordingsManager: (wordId?: string) => void;
  recentSessions: PracticeSessionRecord[];
  activeSubMode?: 'practice' | 'test';
  onSubModeChange?: (mode: 'practice' | 'test') => void;
}

type PageFilter = 'page1' | 'page2' | 'all';
type PracticeSubMode = 'practice' | 'test';
type ExamState = 'setup' | 'running' | 'finished';

interface ExamAnswerItem {
  wordItem: WordItem;
  userAnswer: string;
  isCorrect: boolean;
  allocatedSec: number;
}

/**
 * Calculates total strict exam time for a single word:
 * - Plays 3 times with pauses (~2.2s pause between plays)
 * - Plus writing time (at least 10 seconds total, or longer for multi-word / long pronunciation)
 */
function computeStrictWordExamTiming(
  word: WordItem,
  recording?: CloudRecording,
  baseWritingSec = 10
) {
  const singlePlayDurationMs = recording?.durationMs
    ? Math.max(900, Math.min(4500, recording.durationMs))
    : Math.max(950, Math.min(3200, word.word.length * 105));

  const pauseBetweenPlaysMs = 2100;
  // Time when Play 1, Play 2, Play 3 start (in ms from word start)
  const play1AtMs = 150;
  const play2AtMs = play1AtMs + singlePlayDurationMs + pauseBetweenPlaysMs;
  const play3AtMs = play2AtMs + singlePlayDurationMs + pauseBetweenPlaysMs;
  const threePlaysTotalSec = Math.ceil(
    (play3AtMs + singlePlayDurationMs) / 1000
  );

  // Extra writing time based on word length + user base setting (minimum 10s total window, typically 12s-18s covering all 3 plays + writing)
  const extraCharSec = Math.max(0, Math.ceil((word.word.length - 7) * 0.45));
  const totalWindowSec = Math.max(
    baseWritingSec,
    threePlaysTotalSec + Math.max(4, Math.floor(baseWritingSec * 0.55)) + extraCharSec
  );

  return {
    singlePlayDurationMs,
    play1AtMs,
    play2AtMs,
    play3AtMs,
    totalWindowSec,
  };
}

const SPELLING_ALTERNATIVE_GROUPS: string[][] = [
  ['colour', 'color'],
  ['grey', 'gray'],
  ['aluminum', 'aluminium'],
  ['fiberglass', 'fibreglass'],
  ['dialog', 'dialogue'],
  ['encyclopedia', 'encyclopaedia'],
  ['theatre', 'theater'],
  ['centre', 'center'],
  ['computer centre', 'computer center'],
  ['fulfilment', 'fulfillment'],
  ['personal fulfilment', 'personal fulfillment'],
  ['driving licence', 'driving license'],
  ['fund-raising event', 'fundraising event'],
];

function normalizeSpelling(s: string): string {
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑–—]/g, '-')
    .trim()
    .replace(/\s+/g, ' ');
}

function checkSpellingCorrect(answer: string, targetWord: string): boolean {
  const normAns = normalizeSpelling(answer);
  if (!normAns) return false;
  const normTarget = normalizeSpelling(targetWord);
  const slashAlternatives = normTarget.split(/\s*\/\s*/);
  const group = SPELLING_ALTERNATIVE_GROUPS.find((g) => g.includes(normTarget));
  const accepted = group || slashAlternatives;
  return accepted.includes(normAns);
}

/**
 * Finds matching catalog words for legacy history entries that were saved before per-word results existed.
 */
function findCatalogWordsForSessionCategory(categoryLabel: string): WordItem[] {
  const clean = categoryLabel
    .replace(/^Exam\s*\(/i, '')
    .replace(/\)$/, '')
    .trim();
  const parts = clean.split('·').map((s) => s.trim());
  let pageNum: 1 | 2 | null = null;
  let catPart = clean;

  if (parts.length >= 2) {
    if (/^PAGE1$/i.test(parts[0])) pageNum = 1;
    else if (/^PAGE2$/i.test(parts[0])) pageNum = 2;
    catPart = parts.slice(1).join(' · ').trim();
  }

  const selectedCatNames = catPart
    .split(/\s*\+\s*|\s*,\s*/)
    .map((s) => s.replace(/\+\d+\s*more$/i, '').trim())
    .filter((s) => s && s.toLowerCase() !== 'all categories');

  return WORDS_CATALOG.filter((w) => {
    if (pageNum && w.page !== pageNum) return false;
    if (
      selectedCatNames.length > 0 &&
      !selectedCatNames.some((c) => w.category.toLowerCase() === c.toLowerCase())
    ) {
      return false;
    }
    return true;
  });
}

export const PracticeView: React.FC<PracticeViewProps> = ({
  recordingsMap,
  onOpenRecordingsManager,
  recentSessions,
  activeSubMode,
  onSubModeChange,
}) => {
  // Shared Page 1 / Page 2 & Multi-Category Selection (empty array = All Categories)
  const [pageFilter, setPageFilter] = useState<PageFilter>('page1');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [deckMode, setDeckMode] = useState<'all' | 'uploads' | 'missing'>('all');
  const [subMode, setSubMode] = useState<PracticeSubMode>(
    activeSubMode || 'practice'
  );

  // Selected session for the "Recent Practice & Exam History" Details Modal
  const [selectedHistorySession, setSelectedHistorySession] =
    useState<PracticeSessionRecord | null>(null);
  const [historyFilterMode, setHistoryFilterMode] = useState<
    'all' | 'mistakes' | 'correct'
  >('all');

  const toggleCategory = (cat: string) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const handlePageFilterChange = (nextPage: PageFilter) => {
    setPageFilter(nextPage);
    if (nextPage === 'all') return;
    const targetPageNum = nextPage === 'page1' ? 1 : 2;
    const validCategoriesOnPage = new Set(
      WORDS_CATALOG.filter((w) => w.page === targetPageNum).map(
        (w) => w.category
      )
    );
    setSelectedCategories((prev) =>
      prev.filter((c) => validCategoriesOnPage.has(c))
    );
  };

  const selectedCategoriesLabel = useMemo(() => {
    if (selectedCategories.length === 0) return 'All Categories';
    if (selectedCategories.length <= 2) return selectedCategories.join(' + ');
    return `${selectedCategories.slice(0, 2).join(', ')} +${selectedCategories.length - 2} more`;
  }, [selectedCategories]);

  useEffect(() => {
    if (activeSubMode && activeSubMode !== subMode) {
      setSubMode(activeSubMode);
      setExamState('setup');
    }
  }, [activeSubMode]);

  const handleSwitchSubMode = (nextMode: PracticeSubMode) => {
    setSubMode(nextMode);
    setExamState('setup');
    onSubModeChange?.(nextMode);
  };

  // Free Practice State
  const [currentIndex, setCurrentIndex] = useState(0);
  const [userInput, setUserInput] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [showBanglaHint, setShowBanglaHint] = useState(true);
  const [sessionStats, setSessionStats] = useState({ attempted: 0, correct: 0 });
  const [practiceBatchResults, setPracticeBatchResults] = useState<
    SessionWordResult[]
  >([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const practiceInputRef = useRef<HTMLInputElement>(null);

  // Strict Exam ("Take Test") State
  const [examState, setExamState] = useState<ExamState>('setup');
  const [examWordCountPreset, setExamWordCountPreset] = useState<
    10 | 20 | 30 | 50 | 'custom'
  >(10);
  const [customWordCountInput, setCustomWordCountInput] = useState<string>('15');
  const [baseExamSeconds, setBaseExamSeconds] = useState<number>(12);
  const [shuffleExamWords, setShuffleExamWords] = useState<boolean>(true);
  const [showBanglaInExam, setShowBanglaInExam] = useState<boolean>(true);

  const [examDeck, setExamDeck] = useState<WordItem[]>([]);
  const [examIndex, setExamIndex] = useState<number>(0);
  const [examInput, setExamInput] = useState<string>('');
  const [examAnswers, setExamAnswers] = useState<ExamAnswerItem[]>([]);
  const [examRemainingMs, setExamRemainingMs] = useState<number>(12000);
  const [examTotalMs, setExamTotalMs] = useState<number>(12000);
  const [examPlayCount, setExamPlayCount] = useState<number>(0); // 1, 2, or 3
  const examInputRef = useRef<HTMLInputElement>(null);
  const latestExamInputRef = useRef<string>('');
  latestExamInputRef.current = examInput;

  // Compute Page 1 and Page 2 counts
  const pageCounts = useMemo(() => {
    let p1 = 0;
    let p2 = 0;
    for (const w of WORDS_CATALOG) {
      if (w.page === 1) p1++;
      else p2++;
    }
    return { page1: p1, page2: p2, all: WORDS_CATALOG.length };
  }, []);

  // Compute Category counts within the selected Page (Page 1, Page 2, or All)
  const categoryStats = useMemo(() => {
    const map: Record<string, number> = { 'All Categories': 0 };
    for (const cat of CATEGORIES) {
      if (cat !== 'All Categories') map[cat] = 0;
    }
    for (const item of WORDS_CATALOG) {
      if (pageFilter === 'page1' && item.page !== 1) continue;
      if (pageFilter === 'page2' && item.page !== 2) continue;
      const hasCustom = Boolean(recordingsMap[item.id]);
      if (deckMode === 'uploads' && !hasCustom) continue;
      if (deckMode === 'missing' && (item.hasBundledAudio || hasCustom)) continue;

      map['All Categories'] = (map['All Categories'] || 0) + 1;
      map[item.category] = (map[item.category] || 0) + 1;
    }
    return map;
  }, [pageFilter, deckMode, recordingsMap]);

  // Filtered words matching Page + Multiple Categories + Audio Source
  const filteredDeck: WordItem[] = useMemo(() => {
    return WORDS_CATALOG.filter((item) => {
      if (pageFilter === 'page1' && item.page !== 1) return false;
      if (pageFilter === 'page2' && item.page !== 2) return false;
      if (
        selectedCategories.length > 0 &&
        !selectedCategories.includes(item.category)
      ) {
        return false;
      }
      const hasCustom = Boolean(recordingsMap[item.id]);
      if (deckMode === 'uploads') return hasCustom;
      if (deckMode === 'missing') return !item.hasBundledAudio && !hasCustom;
      return true;
    });
  }, [pageFilter, selectedCategories, deckMode, recordingsMap]);

  const currentWord: WordItem | undefined =
    filteredDeck[currentIndex % Math.max(1, filteredDeck.length)];
  const activeRecording = currentWord ? recordingsMap[currentWord.id] : undefined;
  const displayBangla =
    activeRecording?.banglaMeaning || currentWord?.bangla || '';

  useEffect(() => {
    setCurrentIndex(0);
    setUserInput('');
    setSubmitted(false);
  }, [pageFilter, selectedCategories, deckMode]);

  // Free Practice Play Handler
  const handlePlay = async (rate = 1.0) => {
    if (!currentWord) return;
    setIsPlaying(true);
    try {
      await playWordAudio({
        word: currentWord.word,
        audioDataUrl: activeRecording?.audioDataUrl,
        bundledAudioFile: currentWord.bundledAudioFile,
        playbackRate: rate,
      });
    } finally {
      setTimeout(() => setIsPlaying(false), 650);
    }
  };

  const isCorrect =
    Boolean(currentWord) &&
    checkSpellingCorrect(userInput, currentWord.word);

  const handleSubmitPractice = (e: React.FormEvent) => {
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

      const newResultItem: SessionWordResult = {
        wordId: currentWord.id,
        word: currentWord.word,
        userAnswer: userInput.trim(),
        isCorrect,
        bangla: displayBangla,
        category: currentWord.category,
        page: currentWord.page,
      };
      const updatedBatch = [...practiceBatchResults, newResultItem];

      if (updatedBatch.length >= 5) {
        const batchCorrect = updatedBatch.filter((r) => r.isCorrect).length;
        void savePracticeSession({
          category: `Practice (${pageFilter.toUpperCase()} · ${selectedCategoriesLabel})`,
          totalWords: updatedBatch.length,
          correctCount: batchCorrect,
          results: updatedBatch,
        });
        setPracticeBatchResults([]);
      } else {
        setPracticeBatchResults(updatedBatch);
      }
    } else {
      handleNextPracticeWord();
    }
  };

  const handleNextPracticeWord = () => {
    setSubmitted(false);
    setUserInput('');
    setCurrentIndex((prev) => (prev + 1) % Math.max(1, filteredDeck.length));
  };

  // ============================================================================
  // STRICT EXAM ("TAKE TEST") ENGINE
  // - Plays word 3 times automatically with pauses
  // - Dynamic timer (10s+ based on pronunciation length)
  // - Auto-advances to next word when timer hits 0
  // - Strict Exam Lock: NO Play Again, NO Move Back, write-only
  // ============================================================================

  const requestedExamCount = useMemo(() => {
    const maxAvail = Math.max(1, filteredDeck.length);
    if (examWordCountPreset === 'custom') {
      const parsed = parseInt(customWordCountInput, 10);
      if (Number.isFinite(parsed) && parsed >= 1) {
        return Math.min(maxAvail, parsed);
      }
      return Math.min(maxAvail, 10);
    }
    return Math.min(maxAvail, examWordCountPreset);
  }, [examWordCountPreset, customWordCountInput, filteredDeck.length]);

  const startStrictExam = (customPool?: WordItem[]) => {
    const sourcePool =
      customPool && customPool.length > 0 ? [...customPool] : [...filteredDeck];
    if (sourcePool.length === 0) return;

    if (shuffleExamWords && !customPool) {
      for (let i = sourcePool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sourcePool[i], sourcePool[j]] = [sourcePool[j], sourcePool[i]];
      }
    }

    const chosen = customPool
      ? sourcePool
      : sourcePool.slice(0, requestedExamCount);

    setSelectedHistorySession(null);
    setSubMode('test');
    onSubModeChange?.('test');
    setExamDeck(chosen);
    setExamAnswers([]);
    setExamIndex(0);
    setExamInput('');
    latestExamInputRef.current = '';
    setExamState('running');
  };

  const advanceStrictExamWord = useCallback(
    (typedValue: string) => {
      const currentExamWord = examDeck[examIndex];
      if (!currentExamWord) return;

      const rec = recordingsMap[currentExamWord.id];
      const timing = computeStrictWordExamTiming(
        currentExamWord,
        rec,
        baseExamSeconds
      );

      const cleanTyped = typedValue.trim();
      const matched = checkSpellingCorrect(cleanTyped, currentExamWord.word);

      const newEntry: ExamAnswerItem = {
        wordItem: currentExamWord,
        userAnswer: cleanTyped,
        isCorrect: matched,
        allocatedSec: timing.totalWindowSec,
      };

      setExamAnswers((prev) => {
        const updated = [...prev, newEntry];
        if (examIndex + 1 >= examDeck.length) {
          // Exam finished! Save score and per-word breakdown to Cloud Firestore + Local Storage
          const correctTotal = updated.filter((a) => a.isCorrect).length;
          const detailedResults: SessionWordResult[] = updated.map((a) => ({
            wordId: a.wordItem.id,
            word: a.wordItem.word,
            userAnswer: a.userAnswer,
            isCorrect: a.isCorrect,
            bangla:
              recordingsMap[a.wordItem.id]?.banglaMeaning || a.wordItem.bangla,
            category: a.wordItem.category,
            page: a.wordItem.page,
          }));
          void savePracticeSession({
            category: `Exam (${pageFilter.toUpperCase()} · ${selectedCategoriesLabel})`,
            totalWords: updated.length,
            correctCount: correctTotal,
            results: detailedResults,
          });
        }
        return updated;
      });

      if (examIndex + 1 >= examDeck.length) {
        setExamState('finished');
      } else {
        setExamInput('');
        latestExamInputRef.current = '';
        setExamIndex((idx) => idx + 1);
      }
    },
    [
      examDeck,
      examIndex,
      recordingsMap,
      baseExamSeconds,
      pageFilter,
      selectedCategoriesLabel,
    ]
  );

  // Schedule 3 automatic audio plays with pauses + strict countdown timer for the active exam word
  useEffect(() => {
    if (subMode !== 'test' || examState !== 'running') return;
    const wordObj = examDeck[examIndex];
    if (!wordObj) return;

    const rec = recordingsMap[wordObj.id];
    const timing = computeStrictWordExamTiming(wordObj, rec, baseExamSeconds);
    const totalMs = timing.totalWindowSec * 1000;

    setExamTotalMs(totalMs);
    setExamRemainingMs(totalMs);
    setExamPlayCount(1);

    setTimeout(() => {
      examInputRef.current?.focus();
    }, 40);

    // Schedule Play 1, Play 2, Play 3 with pauses
    const tPlay1 = window.setTimeout(() => {
      setExamPlayCount(1);
      void playWordAudio({
        word: wordObj.word,
        audioDataUrl: rec?.audioDataUrl,
        bundledAudioFile: wordObj.bundledAudioFile,
        playbackRate: 1.0,
      });
    }, timing.play1AtMs);

    const tPlay2 = window.setTimeout(() => {
      setExamPlayCount(2);
      void playWordAudio({
        word: wordObj.word,
        audioDataUrl: rec?.audioDataUrl,
        bundledAudioFile: wordObj.bundledAudioFile,
        playbackRate: 0.95,
      });
    }, timing.play2AtMs);

    const tPlay3 = window.setTimeout(() => {
      setExamPlayCount(3);
      void playWordAudio({
        word: wordObj.word,
        audioDataUrl: rec?.audioDataUrl,
        bundledAudioFile: wordObj.bundledAudioFile,
        playbackRate: 0.9,
      });
    }, timing.play3AtMs);

    const startTime = Date.now();
    const interval = window.setInterval(() => {
      const elapsed = Date.now() - startTime;
      const left = Math.max(0, totalMs - elapsed);
      setExamRemainingMs(left);
      if (left <= 0) {
        window.clearInterval(interval);
        advanceStrictExamWord(latestExamInputRef.current);
      }
    }, 100);

    return () => {
      window.clearTimeout(tPlay1);
      window.clearTimeout(tPlay2);
      window.clearTimeout(tPlay3);
      window.clearInterval(interval);
    };
  }, [
    subMode,
    examState,
    examIndex,
    examDeck,
    recordingsMap,
    baseExamSeconds,
    advanceStrictExamWord,
  ]);

  const accuracyPct =
    sessionStats.attempted > 0
      ? Math.round((sessionStats.correct / sessionStats.attempted) * 100)
      : 100;

  const activeExamWord = examDeck[examIndex];
  const activeExamRec = activeExamWord
    ? recordingsMap[activeExamWord.id]
    : undefined;
  const activeExamBangla =
    activeExamRec?.banglaMeaning || activeExamWord?.bangla || '';

  const examCorrectCount = examAnswers.filter((a) => a.isCorrect).length;
  const examScorePct =
    examAnswers.length > 0
      ? Math.round((examCorrectCount / examAnswers.length) * 100)
      : 0;

  return (
    <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 pt-5 pb-28 md:py-8 space-y-6">
      {/* Top Banner: Switch to Recordings Manager */}
      <div className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-[#0e2219] border border-[#1f4433]">
        <div className="min-w-0">
          <div className="text-xs font-bold text-[#10b981]">
            Pronunciation Audio Studio
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
          <span>Manage Recordings</span>
        </button>
      </div>

      {/* Mode Switcher: Free Practice vs. Take Strict Exam Test */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#183126]">
        <div>
          <h1 className="text-xl sm:text-3xl font-bold text-white tracking-tight">
            {subMode === 'test'
              ? 'Strict IELTS Spelling Exam (Take Test)'
              : 'IELTS Listening & Spelling Practice'}
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-[#8ba89a]">
            {subMode === 'test'
              ? 'Each word plays 3 times with pauses, then automatically advances. No replay or going back.'
              : 'Select Page 1 or Page 2, choose any category, and practice at your own pace.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-1.5 p-1.5 rounded-2xl bg-[#0b1812] border border-[#1d382b] shrink-0">
          <button
            type="button"
            onClick={() => handleSwitchSubMode('practice')}
            className={`min-h-[42px] px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-2 whitespace-nowrap ${
              subMode === 'practice'
                ? 'bg-[#10b981] text-[#04120c]'
                : 'text-[#8ba89a] hover:text-white'
            }`}
          >
            <Volume2 className="w-4 h-4 shrink-0" />
            <span>Practice by Category</span>
          </button>

          <button
            type="button"
            onClick={() => handleSwitchSubMode('test')}
            className={`min-h-[42px] px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-2 whitespace-nowrap ${
              subMode === 'test'
                ? 'bg-[#fbbf24] text-[#08120e]'
                : 'text-[#8ba89a] hover:text-white'
            }`}
          >
            <Timer className="w-4 h-4 shrink-0" />
            <span>Take Strict Test</span>
          </button>
        </div>
      </div>

      {/* Page 1 / Page 2 Selector + Category Selector Cards (Hidden while Strict Exam is actively running) */}
      {!(subMode === 'test' && examState === 'running') && (
        <section className="rounded-2xl bg-[#0d1d16] border border-[#1d382b] p-4 sm:p-6 space-y-5">
          {/* Row 1: Page 1 | Page 2 | All Pages + Audio Deck Filter */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-[#8ba89a] flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-[#10b981]" />
                <span>Select Word Book Page (Page 1 &amp; Page 2)</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-[#08120e] border border-[#1a3327]">
                <button
                  type="button"
                  onClick={() => handlePageFilterChange('page1')}
                  className={`min-h-[42px] px-3 py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap ${
                    pageFilter === 'page1'
                      ? 'bg-[#10b981] text-[#04120c]'
                      : 'text-[#9ab5a7] hover:text-white'
                  }`}
                >
                  <span>Page 1</span>
                  <span className="font-mono tabular-nums text-[11px] opacity-85">
                    ({pageCounts.page1})
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => handlePageFilterChange('page2')}
                  className={`min-h-[42px] px-3 py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap ${
                    pageFilter === 'page2'
                      ? 'bg-[#10b981] text-[#04120c]'
                      : 'text-[#9ab5a7] hover:text-white'
                  }`}
                >
                  <span>Page 2</span>
                  <span className="font-mono tabular-nums text-[11px] opacity-85">
                    ({pageCounts.page2})
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => handlePageFilterChange('all')}
                  className={`min-h-[42px] px-3 py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap ${
                    pageFilter === 'all'
                      ? 'bg-[#10b981] text-[#04120c]'
                      : 'text-[#9ab5a7] hover:text-white'
                  }`}
                >
                  <span>All Pages</span>
                  <span className="font-mono tabular-nums text-[11px] opacity-85">
                    ({pageCounts.all})
                  </span>
                </button>
              </div>
            </div>

            {/* Audio Source Filter */}
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-[#8ba89a]">
                Audio Filter
              </div>
              <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[#08120e] border border-[#1a3327]">
                <button
                  type="button"
                  onClick={() => setDeckMode('all')}
                  className={`min-h-[42px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    deckMode === 'all'
                      ? 'bg-[#183529] text-[#10b981]'
                      : 'text-[#8ba89a] hover:text-white'
                  }`}
                >
                  All Words
                </button>
                <button
                  type="button"
                  onClick={() => setDeckMode('uploads')}
                  className={`min-h-[42px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
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
                  className={`min-h-[42px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                    deckMode === 'missing'
                      ? 'bg-[#183529] text-[#f87171]'
                      : 'text-[#8ba89a] hover:text-white'
                  }`}
                >
                  Missing
                </button>
              </div>
            </div>
          </div>

          {/* Row 2: Visual Multi-Category Selection Grid */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-[#8ba89a] flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5 text-[#10b981]" />
                <span>
                  Select Multiple Categories ({pageFilter === 'page1' ? 'Page 1' : pageFilter === 'page2' ? 'Page 2' : 'All Pages'}) — tap one or more:
                </span>
              </span>

              <div className="flex items-center gap-3">
                {selectedCategories.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedCategories([])}
                    className="text-xs font-semibold text-[#fbbf24] hover:underline"
                  >
                    Clear ({selectedCategories.length} selected)
                  </button>
                )}
                <span className="font-mono tabular-nums text-[#10b981] font-semibold">
                  {filteredDeck.length} words ready
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {/* "All Categories" Card */}
              <button
                type="button"
                onClick={() => setSelectedCategories([])}
                className={`min-h-[44px] px-3 py-2 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors ${
                  selectedCategories.length === 0
                    ? 'bg-[#143325] border-[#10b981] text-white font-bold'
                    : 'bg-[#09140f] border-[#183126] text-[#9ab5a7] hover:border-[#254b3a] hover:text-white'
                }`}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <span
                    className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 ${
                      selectedCategories.length === 0
                        ? 'bg-[#10b981] border-[#10b981] text-[#04120c]'
                        : 'border-[#2d5442]'
                    }`}
                  >
                    {selectedCategories.length === 0 && (
                      <Check className="w-3 h-3 stroke-[3]" />
                    )}
                  </span>
                  <span className="text-xs truncate">All Categories</span>
                </span>
                <span
                  className={`text-[11px] font-mono tabular-nums shrink-0 ${
                    selectedCategories.length === 0
                      ? 'text-[#10b981]'
                      : 'text-[#6c8a7b]'
                  }`}
                >
                  {categoryStats['All Categories'] || 0}
                </span>
              </button>

              {CATEGORIES.filter((cat) => (categoryStats[cat] || 0) > 0).map(
                (cat) => {
                  const count = categoryStats[cat] || 0;
                  const active = selectedCategories.includes(cat);
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => toggleCategory(cat)}
                      className={`min-h-[44px] px-3 py-2 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors ${
                        active
                          ? 'bg-[#143325] border-[#10b981] text-white font-bold'
                          : 'bg-[#09140f] border-[#183126] text-[#9ab5a7] hover:border-[#254b3a] hover:text-white'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 ${
                            active
                              ? 'bg-[#10b981] border-[#10b981] text-[#04120c]'
                              : 'border-[#2d5442]'
                          }`}
                        >
                          {active && <Check className="w-3 h-3 stroke-[3]" />}
                        </span>
                        <span className="text-xs truncate">{cat}</span>
                      </span>
                      <span
                        className={`text-[11px] font-mono tabular-nums shrink-0 ${
                          active ? 'text-[#10b981]' : 'text-[#6c8a7b]'
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                }
              )}
            </div>
          </div>
        </section>
      )}

      {/* ===================================================================== */}
      {/* SUB-MODE 1: STRICT EXAM ("TAKE TEST")                                 */}
      {/* ===================================================================== */}
      {subMode === 'test' ? (
        examState === 'setup' ? (
          <section className="rounded-3xl bg-[#0d1d16] border border-[#244737] p-5 sm:p-8 space-y-6 shadow-2xl">
            <div className="flex items-start gap-3.5">
              <div className="w-11 h-11 rounded-2xl bg-[#fbbf24]/15 border border-[#fbbf24]/40 flex items-center justify-center text-[#fbbf24] shrink-0">
                <Lock className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-lg sm:text-xl font-bold text-white">
                  Configure Strict IELTS Listening Exam
                </h2>
                <p className="text-xs sm:text-sm text-[#8ba89a] mt-1 leading-relaxed">
                  In Strict Exam mode, each word automatically plays <strong>3 times with pauses</strong>. After the countdown timer finishes, the exam <strong>automatically moves to the next word</strong>. You cannot replay audio or go back to previous words.
                </p>
              </div>
            </div>

            {/* Word Count Selection: 10, 20, 30, 50, or Custom Number */}
            <div className="space-y-2.5">
              <label className="block text-xs font-semibold text-[#c4d9ce]">
                How many words do you want in this test? (Available in{' '}
                {pageFilter === 'page1'
                  ? 'Page 1'
                  : pageFilter === 'page2'
                  ? 'Page 2'
                  : 'All Pages'}{' '}
                · {selectedCategoriesLabel}:{' '}
                <span className="font-mono text-[#10b981]">
                  {filteredDeck.length}
                </span>
                )
              </label>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                {([10, 20, 30, 50] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setExamWordCountPreset(preset)}
                    className={`min-h-[48px] px-4 py-2.5 rounded-xl border text-xs sm:text-sm font-bold font-mono tabular-nums transition-colors ${
                      examWordCountPreset === preset
                        ? 'bg-[#fbbf24] border-[#fbbf24] text-[#08120e]'
                        : 'bg-[#08130e] border-[#1d382b] text-[#d2e5dc] hover:border-[#fbbf24]/50'
                    }`}
                  >
                    {preset} Words
                  </button>
                ))}

                <button
                  type="button"
                  onClick={() => setExamWordCountPreset('custom')}
                  className={`min-h-[48px] px-4 py-2.5 rounded-xl border text-xs sm:text-sm font-bold transition-colors ${
                    examWordCountPreset === 'custom'
                      ? 'bg-[#fbbf24] border-[#fbbf24] text-[#08120e]'
                      : 'bg-[#08130e] border-[#1d382b] text-[#d2e5dc] hover:border-[#fbbf24]/50'
                  }`}
                >
                  Custom Count
                </button>
              </div>

              {examWordCountPreset === 'custom' && (
                <div className="pt-2 flex flex-wrap items-center gap-3">
                  <label
                    htmlFor="custom-word-count"
                    className="text-xs text-[#8ba89a]"
                  >
                    Enter exact number of words (1 to {filteredDeck.length}):
                  </label>
                  <input
                    id="custom-word-count"
                    type="number"
                    min={1}
                    max={Math.max(1, filteredDeck.length)}
                    value={customWordCountInput}
                    onChange={(e) => setCustomWordCountInput(e.target.value)}
                    className="w-28 min-h-[44px] px-3.5 py-2 rounded-xl bg-[#08130e] border border-[#fbbf24] text-sm font-mono font-bold text-white focus:outline-none"
                  />
                </div>
              )}
            </div>

            {/* Timer & Exam Options */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
              <div className="rounded-xl bg-[#09140f] border border-[#193327] p-3.5 space-y-1.5">
                <div className="text-xs font-semibold text-[#8ba89a]">
                  Minimum Time Per Word
                </div>
                <div className="flex items-center gap-1.5 pt-1">
                  {[10, 12, 15].map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      onClick={() => setBaseExamSeconds(sec)}
                      className={`flex-1 min-h-[38px] rounded-lg text-xs font-mono font-bold transition-colors ${
                        baseExamSeconds === sec
                          ? 'bg-[#10b981] text-[#04120c]'
                          : 'bg-[#11241b] text-[#9ab5a7]'
                      }`}
                    >
                      {sec}s+
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-[#6d8c7d]">
                  Auto-extends for longer multi-word pronunciations.
                </p>
              </div>

              <div className="rounded-xl bg-[#09140f] border border-[#193327] p-3.5 flex flex-col justify-between">
                <div className="text-xs font-semibold text-[#8ba89a]">
                  Word Order
                </div>
                <div className="grid grid-cols-2 gap-1.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setShuffleExamWords(true)}
                    className={`min-h-[38px] rounded-lg text-xs font-bold ${
                      shuffleExamWords
                        ? 'bg-[#10b981] text-[#04120c]'
                        : 'bg-[#11241b] text-[#9ab5a7]'
                    }`}
                  >
                    Shuffle
                  </button>
                  <button
                    type="button"
                    onClick={() => setShuffleExamWords(false)}
                    className={`min-h-[38px] rounded-lg text-xs font-bold ${
                      !shuffleExamWords
                        ? 'bg-[#10b981] text-[#04120c]'
                        : 'bg-[#11241b] text-[#9ab5a7]'
                    }`}
                  >
                    In Order
                  </button>
                </div>
              </div>

              <div className="rounded-xl bg-[#09140f] border border-[#193327] p-3.5 flex flex-col justify-between">
                <div className="text-xs font-semibold text-[#8ba89a]">
                  Bangla Meaning Clue
                </div>
                <div className="grid grid-cols-2 gap-1.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowBanglaInExam(true)}
                    className={`min-h-[38px] rounded-lg text-xs font-bold ${
                      showBanglaInExam
                        ? 'bg-[#10b981] text-[#04120c]'
                        : 'bg-[#11241b] text-[#9ab5a7]'
                    }`}
                  >
                    Show Bangla
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowBanglaInExam(false)}
                    className={`min-h-[38px] rounded-lg text-xs font-bold ${
                      !showBanglaInExam
                        ? 'bg-[#10b981] text-[#04120c]'
                        : 'bg-[#11241b] text-[#9ab5a7]'
                    }`}
                  >
                    Audio Only
                  </button>
                </div>
              </div>
            </div>

            {/* Start Strict Exam CTA */}
            <button
              type="button"
              disabled={filteredDeck.length === 0}
              onClick={() => startStrictExam()}
              className="w-full min-h-[54px] py-4 px-6 rounded-2xl bg-[#fbbf24] hover:bg-[#f59e0b] disabled:opacity-40 text-[#08120e] font-extrabold text-sm sm:text-base flex items-center justify-center gap-2.5 transition-colors shadow-lg"
            >
              <Play className="w-5 h-5 fill-current" />
              <span>
                START STRICT EXAM ({requestedExamCount} WORDS · 3x AUTO-PLAY)
              </span>
            </button>

            {/* Recent Exam History inside Setup View so user can inspect past exams directly */}
            {recentSessions.length > 0 && (
              <div className="pt-4 border-t border-[#1b3629] space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-[#8ba89a] flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-[#10b981]" />
                    <span>
                      Recent Practice &amp; Exam History (Tap any exam to see full word details)
                    </span>
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {recentSessions.slice(0, 6).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setHistoryFilterMode('all');
                        setSelectedHistorySession(s);
                      }}
                      className="w-full p-3 rounded-xl bg-[#09140f] hover:bg-[#11261c] border border-[#193327] hover:border-[#10b981]/60 text-left flex items-center justify-between gap-2 transition-colors group"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-[#d2e5dc] truncate group-hover:text-white">
                          {s.category}
                        </div>
                        <div className="text-[11px] text-[#6d8c7d] mt-0.5 flex items-center gap-1.5">
                          <span>
                            {s.results && s.results.length > 0
                              ? `${s.results.length} words reviewed`
                              : 'Tap to view words & retake'}
                          </span>
                          <span>·</span>
                          <span className="text-[#10b981] font-semibold">
                            View Details
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="font-mono tabular-nums text-xs font-bold text-[#10b981]">
                          {s.correctCount}/{s.totalWords} ({s.accuracy}%)
                        </span>
                        <ChevronRight className="w-4 h-4 text-[#6d8c7d] group-hover:text-[#10b981]" />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        ) : examState === 'running' && activeExamWord ? (
          /* ACTIVE STRICT EXAM STAGE (Write-only, 3x auto-play, no replay, no back button) */
          <section className="rounded-3xl bg-[#0d1d16] border-2 border-[#fbbf24]/50 p-5 sm:p-8 space-y-6 shadow-2xl">
            {/* Top Exam Header Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[#1c382b]">
              <div className="flex items-center gap-2.5">
                <span className="px-3 py-1 rounded-lg bg-[#fbbf24]/15 text-[#fbbf24] font-mono font-bold text-xs">
                  STRICT EXAM
                </span>
                <span className="font-mono tabular-nums text-sm font-bold text-white">
                  Word {examIndex + 1} of {examDeck.length}
                </span>
                <span className="text-xs text-[#8ba89a]">
                  · {activeExamWord.category}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <span className="text-xs font-mono tabular-nums font-bold text-[#fbbf24]">
                  Auto-next in {(examRemainingMs / 1000).toFixed(1)}s
                </span>
                <button
                  type="button"
                  onClick={() => setExamState('setup')}
                  className="text-xs text-[#f87171] hover:underline"
                >
                  Quit Exam
                </button>
              </div>
            </div>

            {/* Countdown Progress Bar */}
            <div className="w-full h-2.5 rounded-full bg-[#07110c] overflow-hidden border border-[#1a3528]">
              <div
                className="h-full bg-[#fbbf24] transition-transform duration-100 origin-left"
                style={{
                  transform: `scaleX(${Math.max(
                    0,
                    Math.min(1, examRemainingMs / Math.max(1, examTotalMs))
                  )})`,
                }}
              />
            </div>

            {/* 3x Automatic Playback Status Indicator (NO Manual Replay Button Allowed) */}
            <div className="rounded-2xl bg-[#09140f] border border-[#1b3629] p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-[#10b981]/15 border border-[#10b981]/40 flex items-center justify-center text-[#10b981] shrink-0">
                  <Volume2 className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-bold text-white">
                    Automatic Audio Playback ({examPlayCount} of 3)
                  </div>
                  <div className="text-xs text-[#8ba89a] mt-0.5">
                    Listening strictly: Plays 3 times with pauses. Replay &amp; Move Back are locked.
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {[1, 2, 3].map((step) => (
                  <div
                    key={step}
                    className={`px-3 py-1.5 rounded-xl font-mono text-xs font-bold border ${
                      examPlayCount >= step
                        ? 'bg-[#10b981] border-[#10b981] text-[#04120c]'
                        : 'bg-[#0d1d16] border-[#1f3b2e] text-[#6d8a7b]'
                    }`}
                  >
                    Play {step}/3
                  </div>
                ))}
              </div>
            </div>

            {/* Optional Bangla Clue */}
            {showBanglaInExam && (
              <div className="rounded-xl bg-[#11241b] border border-[#1f3d2f] px-4 py-3 flex items-center justify-between">
                <div>
                  <div className="text-[11px] text-[#7ea090]">
                    Bangla Meaning
                  </div>
                  <div className="text-base font-medium text-white mt-0.5">
                    {activeExamBangla}
                  </div>
                </div>
                <span className="text-xs font-mono text-[#7ea090]">
                  {activeExamWord.word.length} letters
                </span>
              </div>
            )}

            {/* Write-Only Exam Input Box */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                advanceStrictExamWord(examInput);
              }}
              className="space-y-4"
            >
              <div>
                <label
                  htmlFor="strict-exam-input"
                  className="block text-xs font-semibold text-[#c4d9ce] mb-2"
                >
                  Write your answer before the timer reaches 0.0s:
                </label>
                <input
                  id="strict-exam-input"
                  ref={examInputRef}
                  type="text"
                  value={examInput}
                  onChange={(e) => setExamInput(e.target.value)}
                  placeholder="Write spelling here..."
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="next"
                  className="w-full min-h-[54px] px-4 py-3.5 rounded-xl bg-[#07110c] border-2 border-[#264d3b] focus:border-[#fbbf24] focus:outline-none text-lg font-medium text-white placeholder-[#4c6b5c]"
                />
              </div>

              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-1.5 text-xs text-[#8ba89a]">
                  <ShieldAlert className="w-4 h-4 text-[#fbbf24] shrink-0" />
                  <span>
                    Cannot go back or replay. Auto-submits when timer ends.
                  </span>
                </div>

                <button
                  type="submit"
                  className="min-h-[48px] px-6 py-3 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-extrabold text-xs sm:text-sm flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Lock Answer &amp; Next</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </form>
          </section>
        ) : (
          /* STRICT EXAM RESULTS & REVIEW SHEET */
          <section className="rounded-3xl bg-[#0d1d16] border border-[#1f3b2e] p-5 sm:p-8 space-y-6 shadow-2xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-[#193327]">
              <div className="flex items-center gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-[#10b981]/15 border border-[#10b981]/40 flex items-center justify-center text-[#10b981]">
                  <Trophy className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-xl sm:text-2xl font-extrabold text-white">
                    Strict Exam Completed!
                  </h2>
                  <p className="text-xs text-[#8ba89a]">
                    Score &amp; word details saved to History · Review your answers below
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="px-4 py-2.5 rounded-2xl bg-[#08130e] border border-[#1d382b] text-center">
                  <div className="text-2xl font-extrabold font-mono tabular-nums text-[#10b981]">
                    {examCorrectCount} / {examAnswers.length} ({examScorePct}%)
                  </div>
                  <div className="text-[10px] text-[#8ba89a] uppercase tracking-wider">
                    Final Score
                  </div>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => startStrictExam()}
                className="min-h-[46px] px-5 py-2.5 rounded-xl bg-[#fbbf24] hover:bg-[#f59e0b] text-[#08120e] text-xs font-extrabold flex items-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Take New Exam ({requestedExamCount} Words)</span>
              </button>

              {examAnswers.some((a) => !a.isCorrect) && (
                <button
                  type="button"
                  onClick={() =>
                    startStrictExam(
                      examAnswers
                        .filter((a) => !a.isCorrect)
                        .map((a) => a.wordItem)
                    )
                  }
                  className="min-h-[46px] px-5 py-2.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold flex items-center gap-2"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>
                    Retake Missed Words Only (
                    {examAnswers.filter((a) => !a.isCorrect).length})
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setExamState('setup')}
                className="min-h-[46px] px-4 py-2.5 rounded-xl bg-[#13291f] hover:bg-[#1a372a] text-xs font-semibold text-[#c4d9ce]"
              >
                Change Exam Settings
              </button>
            </div>

            {/* Detailed Answer Breakdown Table */}
            <div className="rounded-2xl bg-[#08130e] border border-[#1a3327] divide-y divide-[#14291f] max-h-96 overflow-y-auto">
              {examAnswers.map((ans, idx) => {
                const rec = recordingsMap[ans.wordItem.id];
                return (
                  <div
                    key={`${ans.wordItem.id}-${idx}`}
                    className="p-3.5 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                  >
                    <div className="flex items-start gap-3">
                      {ans.isCorrect ? (
                        <CheckCircle2 className="w-5 h-5 text-[#10b981] shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="w-5 h-5 text-[#f87171] shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-[#6d8a7b]">
                            #{idx + 1}
                          </span>
                          <span className="font-bold text-sm text-white">
                            {ans.wordItem.word}
                          </span>
                          <span className="text-xs text-[#8ba89a]">
                            ({rec?.banglaMeaning || ans.wordItem.bangla})
                          </span>
                        </div>
                        <div className="text-xs mt-1">
                          Your answer:{' '}
                          <span
                            className={`font-mono font-semibold ${
                              ans.isCorrect
                                ? 'text-[#10b981]'
                                : 'text-[#f87171] line-through'
                            }`}
                          >
                            {ans.userAnswer || '(blank / time expired)'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        playWordAudio({
                          word: ans.wordItem.word,
                          audioDataUrl: rec?.audioDataUrl,
                          bundledAudioFile: ans.wordItem.bundledAudioFile,
                        })
                      }
                      className="self-start sm:self-center min-h-[38px] px-3 py-1.5 rounded-lg bg-[#12281e] hover:bg-[#19382a] text-xs font-semibold text-[#10b981] flex items-center gap-1.5 shrink-0"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                      <span>Listen</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )
      ) : (
        /* =================================================================== */
        /* SUB-MODE 2: FREE PRACTICE BY PAGE & CATEGORY                        */
        /* =================================================================== */
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
                    setSelectedCategories([]);
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-[#10b981] text-[#04120c] text-xs font-bold"
                >
                  Reset Filter
                </button>
              </div>
            ) : (
              <>
                {/* Word Metadata & Audio Source Line */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-[#162d22] text-xs text-[#8ba89a]">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono tabular-nums font-semibold text-[#10b981] whitespace-nowrap">
                      Word {(currentIndex % filteredDeck.length) + 1} of{' '}
                      {filteredDeck.length}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="whitespace-nowrap">
                      Page {currentWord.page}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="whitespace-nowrap">
                      {currentWord.category}
                    </span>
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
                      {activeRecording
                        ? 'Edit / Replace Audio'
                        : 'Upload Custom Audio'}
                    </span>
                  </button>
                </div>

                {/* Audio Playback Controls */}
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
                <form onSubmit={handleSubmitPractice} className="space-y-4">
                  <div>
                    <label
                      htmlFor="spelling-input"
                      className="block text-xs font-medium text-[#8ba89a] mb-2"
                    >
                      Type the exact word or phrase you hear:
                    </label>
                    <input
                      id="spelling-input"
                      ref={practiceInputRef}
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
                      onClick={handleNextPracticeWord}
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
                  onClick={() => {
                    setSessionStats({ attempted: 0, correct: 0 });
                    setPracticeBatchResults([]);
                  }}
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

            {/* Cloud-Synced Recent Practice & Exam History (Interactive: Click any row for full exam details) */}
            <div className="rounded-2xl bg-[#0d1d16] border border-[#1d382b] p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-[#8ba89a]">
                  Recent Practice &amp; Exam History
                </h3>
                <span className="text-[10px] text-[#10b981] font-semibold">
                  Tap for Details
                </span>
              </div>
              {recentSessions.length === 0 ? (
                <p className="text-xs text-[#698778]">
                  Complete a Strict Exam or 5 practice words to record your accuracy history.
                </p>
              ) : (
                <div className="space-y-2">
                  {recentSessions.slice(0, 8).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        setHistoryFilterMode('all');
                        setSelectedHistorySession(s);
                      }}
                      className="w-full p-2.5 rounded-xl bg-[#09140f] hover:bg-[#12261c] border border-[#173024] hover:border-[#10b981]/60 text-left flex items-center justify-between gap-2 transition-colors group"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-[#d2e5dc] truncate group-hover:text-white">
                          {s.category}
                        </div>
                        <div className="text-[10px] text-[#7ea090] mt-0.5 flex items-center gap-1.5">
                          <span className="text-[#10b981] font-semibold group-hover:underline">
                            View Exam Details
                          </span>
                          <span>·</span>
                          <span>
                            {new Date(s.createdAtMs).toLocaleDateString(
                              undefined,
                              { month: 'short', day: 'numeric' }
                            )}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="font-mono tabular-nums text-xs font-bold text-[#10b981]">
                          {s.correctCount}/{s.totalWords} ({s.accuracy}%)
                        </span>
                        <ChevronRight className="w-4 h-4 text-[#6d8a7b] group-hover:text-[#10b981]" />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* SESSION HISTORY DETAILS MODAL (Shows full exam/practice review sheet) */}
      {/* ===================================================================== */}
      {selectedHistorySession && (() => {
        const hasDetailedResults =
          Array.isArray(selectedHistorySession.results) &&
          selectedHistorySession.results.length > 0;
        const detailedList = selectedHistorySession.results || [];
        const mistakeCount = detailedList.filter((r) => !r.isCorrect).length;
        const correctListCount = detailedList.filter((r) => r.isCorrect).length;

        const filteredDetailedList = detailedList.filter((r) => {
          if (historyFilterMode === 'mistakes') return !r.isCorrect;
          if (historyFilterMode === 'correct') return r.isCorrect;
          return true;
        });

        const fallbackCategoryWords = !hasDetailedResults
          ? findCatalogWordsForSessionCategory(selectedHistorySession.category)
          : [];

        const missedWordItemsForRetake: WordItem[] = hasDetailedResults
          ? detailedList
              .filter((r) => !r.isCorrect)
              .map(
                (r): WordItem =>
                  WORDS_CATALOG.find(
                    (w) =>
                      w.id === r.wordId ||
                      w.word.toLowerCase() === r.word.toLowerCase()
                  ) || {
                    id: r.wordId || r.word,
                    originalId: r.wordId || r.word,
                    word: r.word,
                    bangla: r.bangla || '',
                    category: r.category || 'General IELTS',
                    page: (r.page === 2 ? 2 : 1) as 1 | 2,
                    example: '',
                    hasBundledAudio: false,
                  }
              )
          : [];

        const allWordItemsForRetake: WordItem[] = hasDetailedResults
          ? detailedList.map(
              (r): WordItem =>
                WORDS_CATALOG.find(
                  (w) =>
                    w.id === r.wordId ||
                    w.word.toLowerCase() === r.word.toLowerCase()
                ) || {
                  id: r.wordId || r.word,
                  originalId: r.wordId || r.word,
                  word: r.word,
                  bangla: r.bangla || '',
                  category: r.category || 'General IELTS',
                  page: (r.page === 2 ? 2 : 1) as 1 | 2,
                  example: '',
                  hasBundledAudio: false,
                }
            )
          : fallbackCategoryWords.slice(
              0,
              Math.max(1, selectedHistorySession.totalWords)
            );

        return (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
            <div className="w-full max-w-3xl rounded-3xl bg-[#0d1d16] border border-[#244737] p-4 sm:p-7 space-y-5 shadow-2xl max-h-[90vh] flex flex-col">
              {/* Modal Header */}
              <div className="flex items-start justify-between gap-3 pb-4 border-b border-[#193327] shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-11 h-11 rounded-2xl bg-[#10b981]/15 border border-[#10b981]/40 flex items-center justify-center text-[#10b981] shrink-0">
                    <Trophy className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-base sm:text-xl font-extrabold text-white truncate">
                      {selectedHistorySession.category}
                    </h2>
                    <p className="text-xs text-[#8ba89a] mt-0.5">
                      Completed on{' '}
                      {new Date(
                        selectedHistorySession.createdAtMs
                      ).toLocaleString()}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedHistorySession(null)}
                  className="min-h-[40px] min-w-[40px] rounded-xl bg-[#13291f] hover:bg-[#1c3b2d] text-[#9ab5a7] hover:text-white flex items-center justify-center shrink-0"
                  aria-label="Close session details"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Score Summary Strip */}
              <div className="grid grid-cols-3 gap-2.5 text-center shrink-0">
                <div className="p-3 rounded-2xl bg-[#08130e] border border-[#183126]">
                  <div className="text-lg sm:text-2xl font-extrabold font-mono tabular-nums text-[#10b981]">
                    {selectedHistorySession.correctCount} /{' '}
                    {selectedHistorySession.totalWords}
                  </div>
                  <div className="text-[11px] text-[#8ba89a]">Correct Score</div>
                </div>
                <div className="p-3 rounded-2xl bg-[#08130e] border border-[#183126]">
                  <div className="text-lg sm:text-2xl font-extrabold font-mono tabular-nums text-[#f87171]">
                    {Math.max(
                      0,
                      selectedHistorySession.totalWords -
                        selectedHistorySession.correctCount
                    )}
                  </div>
                  <div className="text-[11px] text-[#8ba89a]">Mistakes</div>
                </div>
                <div className="p-3 rounded-2xl bg-[#08130e] border border-[#183126]">
                  <div className="text-lg sm:text-2xl font-extrabold font-mono tabular-nums text-[#fbbf24]">
                    {selectedHistorySession.accuracy}%
                  </div>
                  <div className="text-[11px] text-[#8ba89a]">Accuracy</div>
                </div>
              </div>

              {/* Retake & Filter Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 shrink-0">
                <div className="flex flex-wrap items-center gap-2">
                  {missedWordItemsForRetake.length > 0 && (
                    <button
                      type="button"
                      onClick={() => startStrictExam(missedWordItemsForRetake)}
                      className="min-h-[42px] px-4 py-2 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>
                        Retake Missed Words ({missedWordItemsForRetake.length})
                      </span>
                    </button>
                  )}

                  {allWordItemsForRetake.length > 0 && (
                    <button
                      type="button"
                      onClick={() => startStrictExam(allWordItemsForRetake)}
                      className="min-h-[42px] px-4 py-2 rounded-xl bg-[#fbbf24] hover:bg-[#f59e0b] text-[#08120e] text-xs font-extrabold flex items-center gap-1.5"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>
                        Retake Full Exam ({allWordItemsForRetake.length} Words)
                      </span>
                    </button>
                  )}
                </div>

                {hasDetailedResults && (
                  <div className="flex items-center gap-1 p-1 rounded-xl bg-[#08130e] border border-[#193327]">
                    <button
                      type="button"
                      onClick={() => setHistoryFilterMode('all')}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-bold ${
                        historyFilterMode === 'all'
                          ? 'bg-[#183529] text-[#10b981]'
                          : 'text-[#8ba89a] hover:text-white'
                      }`}
                    >
                      All ({detailedList.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryFilterMode('mistakes')}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-bold ${
                        historyFilterMode === 'mistakes'
                          ? 'bg-[#2a1215] text-[#f87171]'
                          : 'text-[#8ba89a] hover:text-white'
                      }`}
                    >
                      Mistakes ({mistakeCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryFilterMode('correct')}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-bold ${
                        historyFilterMode === 'correct'
                          ? 'bg-[#183529] text-[#10b981]'
                          : 'text-[#8ba89a] hover:text-white'
                      }`}
                    >
                      Correct ({correctListCount})
                    </button>
                  </div>
                )}
              </div>

              {/* Scrollable Word-by-Word Breakdown List */}
              <div className="rounded-2xl bg-[#08130e] border border-[#1a3327] divide-y divide-[#14291f] overflow-y-auto flex-1 min-h-[220px]">
                {hasDetailedResults ? (
                  filteredDetailedList.length === 0 ? (
                    <div className="p-8 text-center text-xs text-[#8ba89a]">
                      No words in this filter.
                    </div>
                  ) : (
                    filteredDetailedList.map((item, idx) => {
                      const catalogMatch = WORDS_CATALOG.find(
                        (w) =>
                          w.id === item.wordId ||
                          w.word.toLowerCase() === item.word.toLowerCase()
                      );
                      const rec =
                        recordingsMap[item.wordId] ||
                        (catalogMatch ? recordingsMap[catalogMatch.id] : undefined);
                      const banglaText =
                        rec?.banglaMeaning ||
                        item.bangla ||
                        catalogMatch?.bangla ||
                        '';

                      return (
                        <div
                          key={`${item.wordId}-${idx}`}
                          className="p-3.5 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                        >
                          <div className="flex items-start gap-3">
                            {item.isCorrect ? (
                              <CheckCircle2 className="w-5 h-5 text-[#10b981] shrink-0 mt-0.5" />
                            ) : (
                              <XCircle className="w-5 h-5 text-[#f87171] shrink-0 mt-0.5" />
                            )}
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-xs text-[#6d8a7b]">
                                  #{idx + 1}
                                </span>
                                <span className="font-bold text-sm text-white">
                                  {item.word}
                                </span>
                                {banglaText && (
                                  <span className="text-xs text-[#8ba89a]">
                                    ({banglaText})
                                  </span>
                                )}
                              </div>
                              <div className="text-xs mt-1">
                                Your answer:{' '}
                                <span
                                  className={`font-mono font-semibold ${
                                    item.isCorrect
                                      ? 'text-[#10b981]'
                                      : 'text-[#f87171] line-through'
                                  }`}
                                >
                                  {item.userAnswer || '(blank / time expired)'}
                                </span>
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() =>
                              playWordAudio({
                                word: item.word,
                                audioDataUrl: rec?.audioDataUrl,
                                bundledAudioFile: catalogMatch?.bundledAudioFile,
                              })
                            }
                            className="self-start sm:self-center min-h-[38px] px-3 py-1.5 rounded-lg bg-[#12281e] hover:bg-[#19382a] text-xs font-semibold text-[#10b981] flex items-center gap-1.5 shrink-0"
                          >
                            <Volume2 className="w-3.5 h-3.5" />
                            <span>Listen</span>
                          </button>
                        </div>
                      );
                    })
                  )
                ) : (
                  /* Fallback for legacy sessions recorded before per-word history was added */
                  <>
                    <div className="p-3.5 sm:px-5 bg-[#10231a] text-xs text-[#9ab5a7]">
                      This session was recorded before individual typed answers were stored. Below are the{' '}
                      <strong className="text-white">
                        {fallbackCategoryWords.length} words
                      </strong>{' '}
                      from <strong className="text-[#10b981]">{selectedHistorySession.category}</strong> so you can review and listen to each word or retake the exam:
                    </div>
                    {fallbackCategoryWords.map((w, idx) => {
                      const rec = recordingsMap[w.id];
                      return (
                        <div
                          key={w.id}
                          className="p-3.5 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                        >
                          <div className="flex items-center gap-2.5">
                            <span className="font-mono text-xs text-[#6d8a7b]">
                              #{idx + 1}
                            </span>
                            <span className="font-bold text-sm text-white">
                              {w.word}
                            </span>
                            <span className="text-xs text-[#8ba89a]">
                              ({rec?.banglaMeaning || w.bangla})
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              playWordAudio({
                                word: w.word,
                                audioDataUrl: rec?.audioDataUrl,
                                bundledAudioFile: w.bundledAudioFile,
                              })
                            }
                            className="self-start sm:self-center min-h-[38px] px-3 py-1.5 rounded-lg bg-[#12281e] hover:bg-[#19382a] text-xs font-semibold text-[#10b981] flex items-center gap-1.5 shrink-0"
                          >
                            <Volume2 className="w-3.5 h-3.5" />
                            <span>Listen</span>
                          </button>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
