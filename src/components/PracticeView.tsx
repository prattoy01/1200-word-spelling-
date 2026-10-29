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
  Bookmark,
  Plus,
  Download,
} from 'lucide-react';
import { WORDS_CATALOG, CATEGORIES, type WordItem } from '../data/words';
import {
  type CloudRecording,
  type PracticeSessionRecord,
  type SessionWordResult,
  type PersonalWordRecord,
  PERSONAL_STRUGGLING_CATEGORY,
  personalWordToWordItem,
  savePracticeSession,
} from '../services/recordingsService';
import {
  playWordAudio,
  preloadOriginalAudioForWords,
  getLocalOfflineAudioCount,
  isWordOriginalAudioSavedLocally,
  refreshOfflineOriginalAudioIndex,
} from '../utils/audioUtils';
import { NoSuggestSpellingInput } from './NoSuggestSpellingInput';

interface PracticeViewProps {
  recordingsMap: Record<string, CloudRecording>;
  onOpenRecordingsManager: (wordId?: string) => void;
  recentSessions: PracticeSessionRecord[];
  activeSubMode?: 'practice' | 'test';
  onSubModeChange?: (mode: 'practice' | 'test') => void;
  personalWords: PersonalWordRecord[];
  onOpenPersonalWordsModal: () => void;
  onTogglePersonalStrugglingWord: (wordItem: WordItem) => Promise<void>;
  focusPersonalTrigger?: number;
  onOpenContests?: () => void;
  liveContestsCount?: number;
}

type PageFilter = 'page1' | 'page2' | 'all' | 'personal';
type PracticeSubMode = 'practice' | 'test';
type ExamState = 'setup' | 'running' | 'finished';

interface ExamAnswerItem {
  wordItem: WordItem;
  userAnswer: string;
  isCorrect: boolean;
  allocatedSec: number;
}

interface WordAccuracyStats {
  attempts: number;
  correct: number;
  failed: number;
  accuracyPct: number;
  lastCorrect: boolean | null;
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
  personalWords,
  onOpenPersonalWordsModal,
  onTogglePersonalStrugglingWord,
  focusPersonalTrigger,
  onOpenContests,
  liveContestsCount = 0,
}) => {
  // Shared Page 1 / Page 2 & Multi-Category Selection (persisted across page reloads!)
  const [pageFilter, setPageFilter] = useState<PageFilter>(() => {
    try {
      const raw = localStorage.getItem('lw_practice_view_state_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          parsed?.pageFilter === 'page1' ||
          parsed?.pageFilter === 'page2' ||
          parsed?.pageFilter === 'all' ||
          parsed?.pageFilter === 'personal'
        ) {
          return parsed.pageFilter;
        }
      }
    } catch {
      // ignore
    }
    return 'page1';
  });
  const [selectedCategories, setSelectedCategories] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('lw_practice_view_state_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.selectedCategories)) {
          return parsed.selectedCategories.filter(
            (x: unknown) => typeof x === 'string'
          );
        }
      }
    } catch {
      // ignore
    }
    return [];
  });
  const [deckMode, setDeckMode] = useState<'all' | 'uploads' | 'missing'>(
    () => {
      try {
        const raw = localStorage.getItem('lw_practice_view_state_v1');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (
            parsed?.deckMode === 'all' ||
            parsed?.deckMode === 'uploads' ||
            parsed?.deckMode === 'missing'
          ) {
            return parsed.deckMode;
          }
        }
      } catch {
        // ignore
      }
      return 'all';
    }
  );
  const [subMode, setSubMode] = useState<PracticeSubMode>(
    activeSubMode || 'practice'
  );

  // Selected session for the "Recent Practice & Exam History" Details Modal
  const [selectedHistorySession, setSelectedHistorySession] =
    useState<PracticeSessionRecord | null>(null);
  const [historyFilterMode, setHistoryFilterMode] = useState<
    'all' | 'mistakes' | 'correct'
  >('all');

  const personalWordItems: WordItem[] = useMemo(
    () => personalWords.map((rec) => personalWordToWordItem(rec)),
    [personalWords]
  );

  const personalWordIdsSet = useMemo(
    () => new Set(personalWords.map((w) => w.wordId)),
    [personalWords]
  );
  const [isMobileFilterOpen, setIsMobileFilterOpen] = useState(false);
  const [mobilePracticeTab, setMobilePracticeTab] = useState<'card' | 'list'>(
    () => {
      try {
        const raw = localStorage.getItem('lw_practice_view_state_v1');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.mobilePracticeTab === 'list') return 'list';
        }
      } catch {
        // ignore
      }
      return 'card';
    }
  );

  const toggleCategory = (cat: string) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const handlePageFilterChange = (nextPage: PageFilter) => {
    setPageFilter(nextPage);
    if (nextPage === 'personal') {
      setSelectedCategories([PERSONAL_STRUGGLING_CATEGORY]);
      return;
    }
    if (nextPage === 'all') {
      setSelectedCategories((prev) =>
        prev.filter((c) => c !== PERSONAL_STRUGGLING_CATEGORY)
      );
      return;
    }
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
    if (pageFilter === 'personal') return PERSONAL_STRUGGLING_CATEGORY;
    if (selectedCategories.length === 0) return 'All Categories';
    if (selectedCategories.length <= 2) return selectedCategories.join(' + ');
    return `${selectedCategories.slice(0, 2).join(', ')} +${selectedCategories.length - 2} more`;
  }, [pageFilter, selectedCategories]);

  useEffect(() => {
    if (activeSubMode && activeSubMode !== subMode) {
      setSubMode(activeSubMode);
      setExamState('setup');
    }
  }, [activeSubMode]);

  useEffect(() => {
    if (focusPersonalTrigger && focusPersonalTrigger > 0) {
      setPageFilter('personal');
      setSelectedCategories([PERSONAL_STRUGGLING_CATEGORY]);
      setDeckMode('all');
      setCurrentIndex(0);
    }
  }, [focusPersonalTrigger]);

  const handleSwitchSubMode = (nextMode: PracticeSubMode) => {
    setSubMode(nextMode);
    setExamState('setup');
    onSubModeChange?.(nextMode);
  };

  // Free Practice & Study State (persisted across page reloads!)
  const [currentIndex, setCurrentIndex] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('lw_practice_view_state_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed?.currentIndex === 'number' &&
          parsed.currentIndex >= 0
        ) {
          return parsed.currentIndex;
        }
      }
    } catch {
      // ignore
    }
    return 0;
  });
  const [userInput, setUserInput] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [showBanglaHint, setShowBanglaHint] = useState(true);
  const [showStudyWord, setShowStudyWord] = useState(false);
  const [isPracticingBlur, setIsPracticingBlur] = useState(false);
  const [playingStudyWordId, setPlayingStudyWordId] = useState<string | null>(
    null
  );
  const [sessionStats, setSessionStats] = useState({ attempted: 0, correct: 0 });
  const [practiceBatchResults, setPracticeBatchResults] = useState<
    SessionWordResult[]
  >([]);
  const [studySortMode, setStudySortMode] = useState<
    'default' | 'weakest' | 'failedOnly'
  >(() => {
    try {
      const raw = localStorage.getItem('lw_practice_view_state_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          parsed?.studySortMode === 'weakest' ||
          parsed?.studySortMode === 'failedOnly'
        ) {
          return parsed.studySortMode;
        }
      }
    } catch {
      // ignore
    }
    return 'default';
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [offlineSavedCount, setOfflineSavedCount] = useState<number>(14);
  const [isDownloadingOfflineAudio, setIsDownloadingOfflineAudio] =
    useState<boolean>(false);
  const [offlineDownloadProgress, setOfflineDownloadProgress] =
    useState<string>('');
  const practiceInputRef = useRef<HTMLInputElement>(null);
  const isFirstFilterMountRef = useRef<boolean>(true);

  useEffect(() => {
    try {
      localStorage.setItem(
        'lw_practice_view_state_v1',
        JSON.stringify({
          pageFilter,
          selectedCategories,
          deckMode,
          studySortMode,
          mobilePracticeTab,
          currentIndex,
        })
      );
    } catch {
      // ignore
    }
  }, [
    pageFilter,
    selectedCategories,
    deckMode,
    studySortMode,
    mobilePracticeTab,
    currentIndex,
  ]);

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

  // Compute Category counts within the selected Page (Page 1, Page 2, All, or Personal)
  const categoryStats = useMemo(() => {
    const map: Record<string, number> = {
      'All Categories': 0,
      [PERSONAL_STRUGGLING_CATEGORY]: personalWordItems.length,
    };
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
  }, [pageFilter, deckMode, recordingsMap, personalWordItems]);

  // Aggregate per-word accuracy & failure stats from all user test/practice history + current live batch
  const wordAccuracyMap = useMemo(() => {
    const byKey: Record<
      string,
      { attempts: number; correct: number; lastCorrect: boolean | null }
    > = {};

    const recordAttempt = (
      wordId: string | undefined,
      wordText: string | undefined,
      isCorrectAttempt: boolean,
      isNewestFirst: boolean
    ) => {
      const keys = new Set<string>();
      if (wordId) keys.add(wordId.trim().toLowerCase());
      if (wordText) keys.add(normalizeSpelling(wordText));

      for (const key of keys) {
        if (!key) continue;
        if (!byKey[key]) {
          byKey[key] = { attempts: 0, correct: 0, lastCorrect: null };
        }
        byKey[key].attempts += 1;
        if (isCorrectAttempt) {
          byKey[key].correct += 1;
        }
        if (isNewestFirst) {
          if (byKey[key].lastCorrect === null) {
            byKey[key].lastCorrect = isCorrectAttempt;
          }
        } else {
          byKey[key].lastCorrect = isCorrectAttempt;
        }
      }
    };

    // 1. Live unsaved practice batch results (oldest to newest -> newest overwrites lastCorrect)
    for (let i = practiceBatchResults.length - 1; i >= 0; i--) {
      const r = practiceBatchResults[i];
      recordAttempt(r.wordId, r.word, Boolean(r.isCorrect), true);
    }

    // 2. Saved sessions in recentSessions (already sorted newest first)
    for (const session of recentSessions) {
      if (!Array.isArray(session.results)) continue;
      for (const r of session.results) {
        recordAttempt(r.wordId, r.word, Boolean(r.isCorrect), true);
      }
    }

    const finalMap: Record<string, WordAccuracyStats> = {};
    for (const [key, val] of Object.entries(byKey)) {
      const failed = Math.max(0, val.attempts - val.correct);
      const accuracyPct =
        val.attempts > 0 ? Math.round((val.correct / val.attempts) * 100) : 0;
      finalMap[key] = {
        attempts: val.attempts,
        correct: val.correct,
        failed,
        accuracyPct,
        lastCorrect: val.lastCorrect,
      };
    }

    return finalMap;
  }, [recentSessions, practiceBatchResults]);

  const getWordStats = useCallback(
    (item: WordItem | undefined): WordAccuracyStats => {
      if (!item) {
        return {
          attempts: 0,
          correct: 0,
          failed: 0,
          accuracyPct: 0,
          lastCorrect: null,
        };
      }
      const byId = wordAccuracyMap[item.id.toLowerCase()];
      if (byId) return byId;
      const byNorm = wordAccuracyMap[normalizeSpelling(item.word)];
      if (byNorm) return byNorm;
      return {
        attempts: 0,
        correct: 0,
        failed: 0,
        accuracyPct: 0,
        lastCorrect: null,
      };
    },
    [wordAccuracyMap]
  );

  // Base filtered words matching Page + Multiple Categories + Audio Source + Personal Struggling Words
  const baseFilteredDeck: WordItem[] = useMemo(() => {
    const wantsPersonalOnly =
      pageFilter === 'personal' ||
      (selectedCategories.length === 1 &&
        selectedCategories[0] === PERSONAL_STRUGGLING_CATEGORY);

    if (wantsPersonalOnly) {
      return personalWordItems.filter((item) => {
        const hasCustom = Boolean(recordingsMap[item.id]);
        if (deckMode === 'uploads') return hasCustom;
        if (deckMode === 'missing') return !item.hasBundledAudio && !hasCustom;
        return true;
      });
    }

    const combinedPool: WordItem[] = [];
    if (selectedCategories.includes(PERSONAL_STRUGGLING_CATEGORY)) {
      combinedPool.push(...personalWordItems);
    }

    for (const item of WORDS_CATALOG) {
      if (pageFilter === 'page1' && item.page !== 1) continue;
      if (pageFilter === 'page2' && item.page !== 2) continue;
      if (
        selectedCategories.length > 0 &&
        !selectedCategories.includes(item.category)
      ) {
        continue;
      }
      const hasCustom = Boolean(recordingsMap[item.id]);
      if (deckMode === 'uploads' && !hasCustom) continue;
      if (deckMode === 'missing' && (item.hasBundledAudio || hasCustom)) continue;
      combinedPool.push(item);
    }

    return combinedPool;
  }, [pageFilter, selectedCategories, deckMode, recordingsMap, personalWordItems]);

  const failedWordsInDeckCount = useMemo(
    () => baseFilteredDeck.filter((w) => getWordStats(w).failed > 0).length,
    [baseFilteredDeck, getWordStats]
  );

  const filteredDeck: WordItem[] = useMemo(() => {
    if (studySortMode === 'failedOnly') {
      const failedOnly = baseFilteredDeck.filter(
        (w) => getWordStats(w).failed > 0
      );
      return failedOnly.sort((a, b) => {
        const sa = getWordStats(a);
        const sb = getWordStats(b);
        if (sa.accuracyPct !== sb.accuracyPct) {
          return sa.accuracyPct - sb.accuracyPct;
        }
        return sb.failed - sa.failed;
      });
    }

    if (studySortMode === 'weakest') {
      return [...baseFilteredDeck].sort((a, b) => {
        const sa = getWordStats(a);
        const sb = getWordStats(b);
        // Words with failed attempts come first, sorted by lowest accuracy then highest fail count
        const aHasFails = sa.failed > 0 ? 1 : 0;
        const bHasFails = sb.failed > 0 ? 1 : 0;
        if (aHasFails !== bHasFails) return bHasFails - aHasFails;
        if (sa.attempts > 0 && sb.attempts > 0) {
          if (sa.accuracyPct !== sb.accuracyPct) {
            return sa.accuracyPct - sb.accuracyPct;
          }
          return sb.failed - sa.failed;
        }
        // Tested words before untested words when sorting by weakest
        if (sa.attempts !== sb.attempts) return sb.attempts - sa.attempts;
        return 0;
      });
    }

    return baseFilteredDeck;
  }, [baseFilteredDeck, studySortMode, getWordStats]);

  const currentWord: WordItem | undefined =
    filteredDeck[currentIndex % Math.max(1, filteredDeck.length)];
  const currentWordStats = getWordStats(currentWord);
  const activeRecording = currentWord ? recordingsMap[currentWord.id] : undefined;
  const displayBangla =
    activeRecording?.banglaMeaning || currentWord?.bangla || '';

  useEffect(() => {
    if (isFirstFilterMountRef.current) {
      isFirstFilterMountRef.current = false;
      return;
    }
    setCurrentIndex(0);
    setUserInput('');
    setSubmitted(false);
    setShowStudyWord(false);
    setIsPracticingBlur(false);
  }, [pageFilter, selectedCategories, deckMode, studySortMode]);

  // Refresh local offline audio count on mount & listen for newly cached original recordings
  useEffect(() => {
    void refreshOfflineOriginalAudioIndex().then((set) =>
      setOfflineSavedCount(set.size)
    );
    const onOfflineAudioUpdated = () => {
      void getLocalOfflineAudioCount().then((cnt) => setOfflineSavedCount(cnt));
    };
    window.addEventListener(
      'lw-offline-audio-updated',
      onOfflineAudioUpdated as EventListener
    );
    return () =>
      window.removeEventListener(
        'lw-offline-audio-updated',
        onOfflineAudioUpdated as EventListener
      );
  }, []);

  // Automatically save original spelling recordings for the active category deck in the background
  // so if the user loses internet connection while practicing, the original recordings play offline!
  useEffect(() => {
    if (filteredDeck.length === 0) return;
    const startIdx = currentIndex % Math.max(1, filteredDeck.length);
    const upcomingSlice = filteredDeck
      .slice(startIdx, startIdx + 25)
      .filter(
        (w) =>
          Boolean(w.bundledAudioFile) && !isWordOriginalAudioSavedLocally(w.word)
      );
    if (upcomingSlice.length === 0) return;

    const timer = window.setTimeout(() => {
      void preloadOriginalAudioForWords(upcomingSlice).then(async () => {
        const cnt = await getLocalOfflineAudioCount();
        setOfflineSavedCount(cnt);
      });
    }, 600);

    return () => window.clearTimeout(timer);
  }, [filteredDeck, currentIndex]);

  const handleSaveDeckOfflineNow = async () => {
    if (isDownloadingOfflineAudio) return;
    const targetWords = filteredDeck.length > 0 ? filteredDeck : WORDS_CATALOG;
    setIsDownloadingOfflineAudio(true);
    setOfflineDownloadProgress(`0/${targetWords.length}`);
    try {
      await preloadOriginalAudioForWords(targetWords, (done, total) => {
        setOfflineDownloadProgress(`${done}/${total}`);
      });
      const cnt = await getLocalOfflineAudioCount();
      setOfflineSavedCount(cnt);
    } finally {
      setIsDownloadingOfflineAudio(false);
      setOfflineDownloadProgress('');
    }
  };

  // Helper to play pronunciation for any specific word item
  const playSpecificWord = useCallback(
    async (wordObj: WordItem | undefined, rate = 1.0) => {
      if (!wordObj) return;
      const rec = recordingsMap[wordObj.id];
      setIsPlaying(true);
      try {
        await playWordAudio({
          word: wordObj.word,
          audioDataUrl: rec?.audioDataUrl,
          bundledAudioFile: wordObj.bundledAudioFile,
          playbackRate: rate,
        });
      } finally {
        setTimeout(() => setIsPlaying(false), 650);
      }
    },
    [recordingsMap]
  );

  // Free Practice Play Handler
  const handlePlay = async (rate = 1.0) => {
    await playSpecificWord(currentWord, rate);
  };

  // Play any word from the Selected Category Study List
  const handlePlayStudyItem = async (item: WordItem, rate = 1.0) => {
    const rec = recordingsMap[item.id];
    setPlayingStudyWordId(`${item.id}_${rate}`);
    try {
      await playWordAudio({
        word: item.word,
        audioDataUrl: rec?.audioDataUrl,
        bundledAudioFile: item.bundledAudioFile,
        playbackRate: rate,
      });
    } finally {
      setTimeout(() => setPlayingStudyWordId(null), 600);
    }
  };

  const isCorrect =
    Boolean(currentWord) &&
    checkSpellingCorrect(userInput, currentWord.word);

  const handlePracticeAgainWord = useCallback(() => {
    setSubmitted(false);
    setUserInput('');
    setShowStudyWord(false);
    setIsPracticingBlur(true);
    void playSpecificWord(currentWord, 1.0);
    setTimeout(() => {
      practiceInputRef.current?.focus();
    }, 50);
  }, [currentWord, playSpecificWord]);

  // When spelling result (Correct / Wrong) is shown, pressing Enter triggers Practice Again
  useEffect(() => {
    if (subMode !== 'practice' || !submitted || selectedHistorySession) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handlePracticeAgainWord();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [subMode, submitted, selectedHistorySession, handlePracticeAgainWord]);

  const handleSubmitPractice = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!currentWord) return;

    if (!submitted) {
      if (!userInput.trim()) {
        void handlePlay(1.0);
        return;
      }
      setSubmitted(true);
      setIsPracticingBlur(false);
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
      handlePracticeAgainWord();
    }
  };

  const handlePrevPracticeWord = () => {
    if (filteredDeck.length === 0) return;
    const prevIdx =
      currentIndex - 1 < 0 ? filteredDeck.length - 1 : currentIndex - 1;
    const prevWord = filteredDeck[prevIdx];
    setSubmitted(false);
    setUserInput('');
    setShowStudyWord(false);
    setIsPracticingBlur(false);
    setCurrentIndex(prevIdx);
    void playSpecificWord(prevWord, 1.0);
  };

  const handleNextPracticeWord = () => {
    if (filteredDeck.length === 0) return;
    const nextIdx = (currentIndex + 1) % filteredDeck.length;
    const nextWord = filteredDeck[nextIdx];
    setSubmitted(false);
    setUserInput('');
    setShowStudyWord(false);
    setIsPracticingBlur(false);
    setCurrentIndex(nextIdx);
    void playSpecificWord(nextWord, 1.0);
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

  const recordingsMapRef = useRef(recordingsMap);
  recordingsMapRef.current = recordingsMap;

  const advanceStrictExamWord = useCallback(
    (typedValue: string) => {
      const currentExamWord = examDeck[examIndex];
      if (!currentExamWord) return;

      const latestRecordings = recordingsMapRef.current;
      const rec = latestRecordings[currentExamWord.id];
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
              latestRecordings[a.wordItem.id]?.banglaMeaning ||
              a.wordItem.bangla,
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

    const rec = recordingsMapRef.current[wordObj.id];
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
        audioDataUrl: recordingsMapRef.current[wordObj.id]?.audioDataUrl,
        bundledAudioFile: wordObj.bundledAudioFile,
        playbackRate: 1.0,
      });
    }, timing.play1AtMs);

    const tPlay2 = window.setTimeout(() => {
      setExamPlayCount(2);
      void playWordAudio({
        word: wordObj.word,
        audioDataUrl: recordingsMapRef.current[wordObj.id]?.audioDataUrl,
        bundledAudioFile: wordObj.bundledAudioFile,
        playbackRate: 0.95,
      });
    }, timing.play2AtMs);

    const tPlay3 = window.setTimeout(() => {
      setExamPlayCount(3);
      void playWordAudio({
        word: wordObj.word,
        audioDataUrl: recordingsMapRef.current[wordObj.id]?.audioDataUrl,
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
    <div className="max-w-5xl w-full mx-auto px-3.5 sm:px-6 pt-3 pb-28 md:py-8 space-y-4 md:space-y-6">
      {/* Top Banner: Switch to Recordings Manager & Personal Struggling Words (Desktop/Tablet only; Mobile uses Bottom Nav) */}
      <div className="hidden md:flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-2xl bg-[#0e2219] border border-[#1f4433]">
        <div className="min-w-0">
          <div className="text-xs font-bold text-[#10b981]">
            Pronunciation Audio Studio &amp; Personal Words
          </div>
          <div className="text-[11px] text-[#9ab5a7] truncate">
            782 Bundled · {Object.keys(recordingsMap).length} Cloud Uploads ·{' '}
            <span className="text-[#38bdf8] font-semibold">
              {personalWords.length} My Struggling Words (Private)
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {onOpenContests && (
            <button
              type="button"
              onClick={onOpenContests}
              className="min-h-[42px] px-3.5 py-2 rounded-xl bg-[#fbbf24]/15 hover:bg-[#fbbf24]/25 border border-[#fbbf24]/50 text-[#fbbf24] text-xs font-extrabold flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <Trophy className="w-4 h-4 text-[#fbbf24]" />
              <span>
                Live Contests
                {liveContestsCount > 0 ? ` (${liveContestsCount})` : ''}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={onOpenPersonalWordsModal}
            className="min-h-[42px] px-3.5 py-2 rounded-xl bg-[#38bdf8]/15 hover:bg-[#38bdf8]/25 border border-[#38bdf8]/40 text-[#7dd3fc] text-xs font-extrabold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Plus className="w-4 h-4 text-[#38bdf8]" />
            <span>Add Struggling Word ({personalWords.length})</span>
          </button>
          <button
            type="button"
            disabled={isDownloadingOfflineAudio}
            onClick={() => void handleSaveDeckOfflineNow()}
            title="Save original spelling recordings to your local device so they play when offline"
            className="min-h-[42px] px-3.5 py-2 rounded-xl bg-[#11281e] hover:bg-[#173528] border border-[#1f4735] text-[#10b981] text-xs font-extrabold flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-60"
          >
            <Download className="w-4 h-4 text-[#10b981]" />
            <span>
              {isDownloadingOfflineAudio
                ? `Saving Offline (${offlineDownloadProgress})...`
                : `Offline Audio (${offlineSavedCount} Saved)`}
            </span>
          </button>
          <button
            type="button"
            onClick={() => onOpenRecordingsManager(currentWord?.id)}
            className="min-h-[42px] px-4 py-2 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <ListMusic className="w-4 h-4" />
            <span>Manage Recordings</span>
          </button>
        </div>
      </div>

      {/* Mode Switcher: Free Practice vs. Take Strict Exam Test (Desktop/Tablet only; Mobile uses Bottom App Dock) */}
      <div className="hidden md:flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-4 pb-3 sm:pb-4 border-b border-[#183126]">
        <div>
          <h1 className="text-lg sm:text-3xl font-bold text-white tracking-tight">
            {subMode === 'test'
              ? 'Strict IELTS Spelling Exam'
              : 'IELTS Listening & Spelling'}
          </h1>
          <p className="mt-0.5 text-[11px] sm:text-sm text-[#8ba89a] hidden sm:block">
            {subMode === 'test'
              ? 'Each word plays 3 times with pauses, then automatically advances. No replay or going back.'
              : 'Select Page 1, Page 2, or your private Struggling Words, and practice at your own pace.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl sm:rounded-2xl bg-[#0b1812] border border-[#1d382b] shrink-0">
          <button
            type="button"
            onClick={() => handleSwitchSubMode('practice')}
            className={`min-h-[38px] sm:min-h-[42px] px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 sm:gap-2 whitespace-nowrap ${
              subMode === 'practice'
                ? 'bg-[#10b981] text-[#04120c]'
                : 'text-[#8ba89a] hover:text-white'
            }`}
          >
            <Volume2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            <span>Free Practice</span>
          </button>

          <button
            type="button"
            onClick={() => handleSwitchSubMode('test')}
            className={`min-h-[38px] sm:min-h-[42px] px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg sm:rounded-xl text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 sm:gap-2 whitespace-nowrap ${
              subMode === 'test'
                ? 'bg-[#fbbf24] text-[#08120e]'
                : 'text-[#8ba89a] hover:text-white'
            }`}
          >
            <Timer className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            <span>Strict Test</span>
          </button>
        </div>
      </div>

      {/* Page 1 / Page 2 / My Struggling Words Selector + Category Selector Cards */}
      {!(subMode === 'test' && examState === 'running') && (
        <section className="rounded-2xl bg-[#0d1d16] border border-[#1d382b] p-3 sm:p-6 space-y-3 sm:space-y-5">
          {/* Row 1: Page 1 | Page 2 | All Pages | My Struggling Words + Audio Deck Filter */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="space-y-1.5">
              <div className="hidden sm:flex text-xs font-semibold text-[#8ba89a] items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-[#10b981]" />
                <span>Select Word Book Page or Personal Struggling Words</span>
              </div>
              <div className="grid grid-cols-4 gap-1 sm:gap-1.5 p-1 rounded-xl bg-[#08120e] border border-[#1a3327]">
                <button
                  type="button"
                  onClick={() => handlePageFilterChange('page1')}
                  className={`min-h-[38px] sm:min-h-[42px] px-1.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-[11px] sm:text-xs font-bold transition-colors flex flex-col sm:flex-row items-center justify-center sm:gap-1.5 whitespace-nowrap ${
                    pageFilter === 'page1'
                      ? 'bg-[#10b981] text-[#04120c]'
                      : 'text-[#9ab5a7] hover:text-white'
                  }`}
                >
                  <span>Page 1</span>
                  <span className="font-mono tabular-nums text-[10px] sm:text-[11px] opacity-85">
                    ({pageCounts.page1})
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => handlePageFilterChange('page2')}
                  className={`min-h-[38px] sm:min-h-[42px] px-1.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-[11px] sm:text-xs font-bold transition-colors flex flex-col sm:flex-row items-center justify-center sm:gap-1.5 whitespace-nowrap ${
                    pageFilter === 'page2'
                      ? 'bg-[#10b981] text-[#04120c]'
                      : 'text-[#9ab5a7] hover:text-white'
                  }`}
                >
                  <span>Page 2</span>
                  <span className="font-mono tabular-nums text-[10px] sm:text-[11px] opacity-85">
                    ({pageCounts.page2})
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => handlePageFilterChange('all')}
                  className={`min-h-[38px] sm:min-h-[42px] px-1.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-[11px] sm:text-xs font-bold transition-colors flex flex-col sm:flex-row items-center justify-center sm:gap-1.5 whitespace-nowrap ${
                    pageFilter === 'all'
                      ? 'bg-[#10b981] text-[#04120c]'
                      : 'text-[#9ab5a7] hover:text-white'
                  }`}
                >
                  <span>All Pages</span>
                  <span className="font-mono tabular-nums text-[10px] sm:text-[11px] opacity-85">
                    ({pageCounts.all})
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => handlePageFilterChange('personal')}
                  className={`min-h-[38px] sm:min-h-[42px] px-1.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-[11px] sm:text-xs font-bold transition-colors flex flex-col sm:flex-row items-center justify-center sm:gap-1.5 whitespace-nowrap ${
                    pageFilter === 'personal'
                      ? 'bg-[#38bdf8] text-[#04120c]'
                      : 'text-[#7dd3fc] hover:text-white'
                  }`}
                >
                  <span className="flex items-center gap-1">
                    <Bookmark className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0 hidden sm:inline" />
                    <span>My Words</span>
                  </span>
                  <span className="font-mono tabular-nums text-[10px] sm:text-[11px] opacity-90">
                    ({personalWords.length})
                  </span>
                </button>
              </div>
            </div>

            {/* Mobile Compact Summary + Drawer Toggle Bar */}
            <div className="flex md:hidden items-center justify-between gap-2 pt-0.5">
              <div className="min-w-0 flex items-center gap-1.5 text-xs">
                <FolderOpen className="w-3.5 h-3.5 text-[#10b981] shrink-0" />
                <span className="text-[#c4d9ce] font-semibold truncate">
                  {selectedCategoriesLabel}
                </span>
                <span className="font-mono tabular-nums text-[11px] text-[#10b981] font-bold shrink-0">
                  ({filteredDeck.length}w)
                </span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={isDownloadingOfflineAudio}
                  onClick={() => void handleSaveDeckOfflineNow()}
                  title="Save original spelling recordings for offline playback"
                  className="min-h-[34px] px-2.5 py-1 rounded-xl bg-[#0e241a] border border-[#10b981]/40 text-[11px] font-bold text-[#10b981] flex items-center gap-1"
                >
                  <Download className="w-3 h-3 shrink-0" />
                  <span>
                    {isDownloadingOfflineAudio
                      ? offlineDownloadProgress
                      : `${offlineSavedCount} Offline`}
                  </span>
                </button>
                {selectedCategories.length > 0 && pageFilter !== 'personal' && (
                  <button
                    type="button"
                    onClick={() => setSelectedCategories([])}
                    className="min-h-[34px] px-2.5 py-1 rounded-lg bg-[#29200e] border border-[#fbbf24]/40 text-[11px] font-bold text-[#fbbf24]"
                  >
                    Reset
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setIsMobileFilterOpen((v) => !v)}
                  className={`min-h-[34px] px-3 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 transition-colors ${
                    isMobileFilterOpen
                      ? 'bg-[#10b981] border-[#10b981] text-[#04120c]'
                      : 'bg-[#12281e] border-[#254b3a] text-[#10b981]'
                  }`}
                >
                  <span>
                    {isMobileFilterOpen
                      ? 'Hide Categories'
                      : `Categories (${
                          selectedCategories.length > 0
                            ? selectedCategories.length
                            : 'All'
                        })`}
                  </span>
                  <ChevronRight
                    className={`w-3.5 h-3.5 transition-transform ${
                      isMobileFilterOpen ? 'rotate-90' : ''
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Audio Source Filter */}
            <div
              className={`${
                isMobileFilterOpen ? 'block' : 'hidden md:block'
              } space-y-1.5`}
            >
              <div className="text-xs font-semibold text-[#8ba89a]">
                Audio Filter
              </div>
              <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[#08120e] border border-[#1a3327]">
                <button
                  type="button"
                  onClick={() => setDeckMode('all')}
                  className={`min-h-[38px] sm:min-h-[42px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
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
                  className={`min-h-[38px] sm:min-h-[42px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
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
                  className={`min-h-[38px] sm:min-h-[42px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
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
          <div
            className={`${
              isMobileFilterOpen ? 'block' : 'hidden md:block'
            } space-y-2.5`}
          >
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
              {/* "My Struggling Words (Private)" Card */}
              <button
                type="button"
                onClick={() => {
                  if (pageFilter === 'personal') {
                    setPageFilter('page1');
                    setSelectedCategories([]);
                  } else {
                    setPageFilter('personal');
                    setSelectedCategories([PERSONAL_STRUGGLING_CATEGORY]);
                  }
                }}
                className={`min-h-[44px] px-3 py-2 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors ${
                  pageFilter === 'personal' ||
                  selectedCategories.includes(PERSONAL_STRUGGLING_CATEGORY)
                    ? 'bg-[#0c2a36] border-[#38bdf8] text-white font-bold'
                    : 'bg-[#09181d] border-[#1b3b48] text-[#7dd3fc] hover:border-[#38bdf8] hover:text-white'
                }`}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <Bookmark className="w-3.5 h-3.5 text-[#38bdf8] shrink-0" />
                  <span className="text-xs truncate">My Struggling Words</span>
                </span>
                <span className="text-[11px] font-mono tabular-nums shrink-0 text-[#38bdf8]">
                  {personalWords.length}
                </span>
              </button>

              {/* "All Categories" Card */}
              <button
                type="button"
                onClick={() => {
                  if (pageFilter === 'personal') setPageFilter('page1');
                  setSelectedCategories([]);
                }}
                className={`min-h-[44px] px-3 py-2 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors ${
                  pageFilter !== 'personal' && selectedCategories.length === 0
                    ? 'bg-[#143325] border-[#10b981] text-white font-bold'
                    : 'bg-[#09140f] border-[#183126] text-[#9ab5a7] hover:border-[#254b3a] hover:text-white'
                }`}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <span
                    className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 ${
                      pageFilter !== 'personal' && selectedCategories.length === 0
                        ? 'bg-[#10b981] border-[#10b981] text-[#04120c]'
                        : 'border-[#2d5442]'
                    }`}
                  >
                    {pageFilter !== 'personal' && selectedCategories.length === 0 && (
                      <Check className="w-3 h-3 stroke-[3]" />
                    )}
                  </span>
                  <span className="text-xs truncate">All Categories</span>
                </span>
                <span
                  className={`text-[11px] font-mono tabular-nums shrink-0 ${
                    pageFilter !== 'personal' && selectedCategories.length === 0
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
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="strict-exam-input"
                  className="block text-xs font-semibold text-[#c4d9ce] mb-2"
                >
                  Write your answer before the timer reaches 0.0s:
                </label>
                <NoSuggestSpellingInput
                  id="strict-exam-input"
                  inputRef={examInputRef}
                  value={examInput}
                  onChange={setExamInput}
                  onEnterPress={() => advanceStrictExamWord(examInput)}
                  placeholder="Write spelling here..."
                  enterKeyHint="next"
                  variant="exam"
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
                  type="button"
                  onClick={() => advanceStrictExamWord(examInput)}
                  className="min-h-[48px] px-6 py-3 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-extrabold text-xs sm:text-sm flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Lock Answer &amp; Next</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
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
        <div className="space-y-4 sm:space-y-5">
          {/* Mobile Sub-View Switcher: Practice Card vs Study Word List */}
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-[#0b1812] border border-[#1d382b] md:hidden">
            <button
              type="button"
              onClick={() => setMobilePracticeTab('card')}
              className={`min-h-[40px] px-3 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                mobilePracticeTab === 'card'
                  ? 'bg-[#10b981] text-[#04120c]'
                  : 'text-[#8ba89a] hover:text-white'
              }`}
            >
              <Volume2 className="w-3.5 h-3.5 shrink-0" />
              <span>
                Practice Card (
                {filteredDeck.length > 0
                  ? `${(currentIndex % filteredDeck.length) + 1}/${filteredDeck.length}`
                  : '0'}
                )
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMobilePracticeTab('list')}
              className={`min-h-[40px] px-3 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                mobilePracticeTab === 'list'
                  ? 'bg-[#10b981] text-[#04120c]'
                  : 'text-[#8ba89a] hover:text-white'
              }`}
            >
              <ListMusic className="w-3.5 h-3.5 shrink-0" />
              <span>Word List ({filteredDeck.length})</span>
            </button>
          </div>

          {/* Top Row: Side-by-Side on Tablet & PC (md:grid-cols-12), Tabbed on Phone */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-start">
            {/* LEFT (6 cols on Tablet/PC, Tab 1 on Phone): Interactive Spelling Practice Card */}
            <div
              onClick={() => {
                if (!submitted) {
                  setIsPracticingBlur(true);
                }
              }}
              className={`${
                mobilePracticeTab === 'card' ? 'block' : 'hidden md:block'
              } md:col-span-6 rounded-2xl bg-[#0d1d16] border border-[#1d382b] p-4 sm:p-6 space-y-5`}
            >
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
                  {/* Word Metadata & Audio Source Header */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#162d22] text-xs text-[#8ba89a]">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                      <span className="font-mono tabular-nums font-bold text-[#10b981] whitespace-nowrap">
                        Word {(currentIndex % filteredDeck.length) + 1} of{' '}
                        {filteredDeck.length}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="whitespace-nowrap">
                        Page {currentWord.page}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="text-[#c4d9ce] font-medium">
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

                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onTogglePersonalStrugglingWord(currentWord);
                        }}
                        title={
                          personalWordIdsSet.has(currentWord.id)
                            ? 'Remove from your private Struggling Words'
                            : 'Save this word to your private Struggling Words list'
                        }
                        className={`min-h-[32px] px-2.5 py-1 rounded-lg border text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                          personalWordIdsSet.has(currentWord.id)
                            ? 'bg-[#0c2a36] border-[#38bdf8] text-[#7dd3fc]'
                            : 'bg-[#13291f] hover:bg-[#1a372a] border-[#234435] text-[#9ab5a7] hover:text-white'
                        }`}
                      >
                        <Bookmark
                          className={`w-3.5 h-3.5 shrink-0 ${
                            personalWordIdsSet.has(currentWord.id)
                              ? 'fill-[#38bdf8] text-[#38bdf8]'
                              : ''
                          }`}
                        />
                        <span>
                          {personalWordIdsSet.has(currentWord.id)
                            ? 'In Struggling Words'
                            : '+ Struggling Word'}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenRecordingsManager(currentWord.id);
                        }}
                        className="min-h-[32px] px-2.5 py-1 rounded-lg bg-[#13291f] hover:bg-[#1a372a] border border-[#234435] text-xs font-semibold text-[#10b981] flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
                      >
                        <Mic className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          {activeRecording
                            ? 'Edit / Replace Audio'
                            : 'Upload Custom Audio'}
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Active Word Test History Accuracy & Visual Progress Bar */}
                  <div className="rounded-xl bg-[#091510] border border-[#193327] px-3.5 py-2.5 space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold text-[#8ba89a]">
                          Your Test Accuracy:
                        </span>
                        {currentWordStats.attempts > 0 ? (
                          <span
                            className={`font-mono tabular-nums font-bold ${
                              currentWordStats.accuracyPct < 50
                                ? 'text-[#f87171]'
                                : currentWordStats.accuracyPct < 80
                                ? 'text-[#fbbf24]'
                                : 'text-[#10b981]'
                            }`}
                          >
                            {currentWordStats.accuracyPct}% (
                            {currentWordStats.correct}/
                            {currentWordStats.attempts} correct
                            {currentWordStats.failed > 0
                              ? ` · ${currentWordStats.failed} failed`
                              : ''}
                            )
                          </span>
                        ) : (
                          <span className="text-[11px] text-[#6d8a7b] font-medium">
                            Not tested yet (0 attempts)
                          </span>
                        )}
                      </div>

                      {currentWordStats.attempts > 0 && (
                        <span
                          className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider ${
                            currentWordStats.accuracyPct < 50
                              ? 'bg-[#2a1215] text-[#f87171] border border-[#f87171]/30'
                              : currentWordStats.accuracyPct < 80
                              ? 'bg-[#29200e] text-[#fbbf24] border border-[#fbbf24]/30'
                              : 'bg-[#0e291e] text-[#10b981] border border-[#10b981]/30'
                          }`}
                        >
                          {currentWordStats.accuracyPct < 50
                            ? 'High Failure · Needs Practice'
                            : currentWordStats.accuracyPct < 80
                            ? 'Improving'
                            : 'Mastered'}
                        </span>
                      )}
                    </div>

                    <div className="w-full h-2 rounded-full bg-[#12261d] overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          currentWordStats.attempts === 0
                            ? 'bg-[#234435]'
                            : currentWordStats.accuracyPct < 50
                            ? 'bg-[#f87171]'
                            : currentWordStats.accuracyPct < 80
                            ? 'bg-[#fbbf24]'
                            : 'bg-[#10b981]'
                        }`}
                        style={{
                          width:
                            currentWordStats.attempts === 0
                              ? '0%'
                              : `${Math.max(6, currentWordStats.accuracyPct)}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Audio Playback & Study Toggle Controls */}
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

                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => handlePlay(0.72)}
                        className="min-h-[44px] py-2 px-2.5 rounded-xl bg-[#13291f] hover:bg-[#1a372a] border border-[#234435] text-xs font-semibold text-[#d2e5dc] flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <Gauge className="w-3.5 h-3.5 text-[#10b981] shrink-0" />
                        <span className="truncate">Slow (0.75x)</span>
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowStudyWord((prev) => {
                            const next = !prev;
                            if (next) {
                              setIsPracticingBlur(false);
                            }
                            return next;
                          });
                        }}
                        className="min-h-[44px] py-2 px-2.5 rounded-xl bg-[#13291f] hover:bg-[#1a372a] border border-[#234435] text-xs font-semibold text-[#d2e5dc] flex items-center justify-center gap-1.5 transition-colors"
                      >
                        {showStudyWord ? (
                          <>
                            <EyeOff className="w-3.5 h-3.5 text-[#fbbf24] shrink-0" />
                            <span className="truncate">Hide Word</span>
                          </>
                        ) : (
                          <>
                            <Eye className="w-3.5 h-3.5 text-[#10b981] shrink-0" />
                            <span className="truncate">Show Word</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => setShowBanglaHint((v) => !v)}
                        className="min-h-[44px] py-2 px-2.5 rounded-xl bg-[#13291f] hover:bg-[#1a372a] border border-[#234435] text-xs font-semibold text-[#d2e5dc] flex items-center justify-center gap-1.5 transition-colors"
                      >
                        {showBanglaHint ? (
                          <>
                            <EyeOff className="w-3.5 h-3.5 text-[#8ba89a] shrink-0" />
                            <span className="truncate">Hide Meaning</span>
                          </>
                        ) : (
                          <>
                            <Eye className="w-3.5 h-3.5 text-[#10b981] shrink-0" />
                            <span className="truncate">Show Meaning</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Study Word Display Box (English Word + Pronunciation Study View) */}
                  {showStudyWord && (
                    <div className="rounded-xl bg-[#0a1c14] border border-[#10b981]/40 px-4 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-[#10b981]">
                          Study Word Spelling &amp; Pronunciation
                        </div>
                        <div className="text-xl sm:text-2xl font-bold font-mono text-white mt-0.5 break-words tracking-wide">
                          {currentWord.word}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handlePlay(1.0)}
                          className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#10b981]/20 hover:bg-[#10b981]/30 border border-[#10b981]/50 text-xs font-bold text-[#10b981] flex items-center gap-1.5 transition-colors"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                          <span>Listen</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePlay(0.72)}
                          className="min-h-[38px] px-2.5 py-1.5 rounded-lg bg-[#13291f] hover:bg-[#1a372a] border border-[#234435] text-xs font-semibold text-[#d2e5dc] flex items-center gap-1 transition-colors"
                        >
                          <Gauge className="w-3.5 h-3.5 text-[#10b981]" />
                          <span>0.75x</span>
                        </button>
                      </div>
                    </div>
                  )}

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

                  {/* Spelling Input Box (No form wrapper so mobile keyboards never show password/autofill/suggestion popups) */}
                  <div className="space-y-4">
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowStudyWord(false);
                        setIsPracticingBlur(true);
                      }}
                    >
                      <label
                        htmlFor="spelling-input"
                        className="block text-xs font-medium text-[#8ba89a] mb-2"
                      >
                        Type the exact word or phrase you hear:
                      </label>
                      <NoSuggestSpellingInput
                        id="spelling-input"
                        inputRef={practiceInputRef}
                        value={userInput}
                        onChange={(val) => {
                          setUserInput(val);
                          setShowStudyWord(false);
                          setIsPracticingBlur(true);
                        }}
                        onEnterPress={() => handleSubmitPractice()}
                        onFocus={() => {
                          setShowStudyWord(false);
                          setIsPracticingBlur(true);
                        }}
                        disabled={submitted}
                        placeholder="Type the word you hear..."
                        enterKeyHint="done"
                        variant="practice"
                      />
                    </div>

                    {submitted && (
                      <div
                        className={`rounded-xl p-4 border flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 ${
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

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePracticeAgainWord();
                          }}
                          className="self-start sm:self-center min-h-[40px] px-3.5 py-2 rounded-xl bg-[#13291f] hover:bg-[#1c3b2d] border border-[#2a5440] text-xs font-bold text-[#10b981] hover:text-white flex items-center gap-1.5 shrink-0 transition-colors"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Practice Again (Enter)</span>
                        </button>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePrevPracticeWord();
                          }}
                          className="min-h-[46px] px-3.5 py-2.5 rounded-xl bg-[#13291f] hover:bg-[#1a372a] text-xs font-semibold text-[#9ab5a7] hover:text-white transition-colors"
                        >
                          Prev Word
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNextPracticeWord();
                          }}
                          className="min-h-[46px] px-3.5 py-2.5 rounded-xl bg-[#13291f] hover:bg-[#1a372a] text-xs font-semibold text-[#9ab5a7] hover:text-white transition-colors"
                        >
                          Skip / Next
                        </button>
                        {submitted && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePracticeAgainWord();
                            }}
                            className="min-h-[46px] px-3.5 py-2.5 rounded-xl bg-[#163326] hover:bg-[#1f4534] border border-[#10b981]/40 text-xs font-bold text-[#10b981] flex items-center gap-1.5 transition-colors"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>Practice Again (Enter)</span>
                          </button>
                        )}
                      </div>

                      {submitted ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNextPracticeWord();
                          }}
                          className="min-h-[46px] px-5 py-2.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-bold text-sm flex items-center justify-center gap-2 transition-colors"
                        >
                          <span>Next Word</span>
                          <ArrowRight className="w-4 h-4 shrink-0" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSubmitPractice();
                          }}
                          className="min-h-[46px] px-5 py-2.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-bold text-sm flex items-center justify-center gap-2 transition-colors"
                        >
                          <span>Check Spelling</span>
                          <ArrowRight className="w-4 h-4 shrink-0" />
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* RIGHT (6 cols on Tablet/PC, Tab 2 on Phone): Selected Category Study Words & Pronunciation */}
            <div
              onClick={() => {
                setIsPracticingBlur(false);
              }}
              className={`${
                mobilePracticeTab === 'list' ? 'block' : 'hidden md:block'
              } md:col-span-6 rounded-2xl bg-[#0d1d16] border border-[#1d382b] p-4 sm:p-6 space-y-4`}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-[#162d22]">
                <div>
                  <div className="flex items-center gap-2">
                    <ListMusic className="w-4 h-4 text-[#10b981] shrink-0" />
                    <h3 className="text-sm sm:text-base font-bold text-white">
                      Selected Category Study Words &amp; Pronunciation (
                      {filteredDeck.length})
                    </h3>
                  </div>
                  <p className="text-xs text-[#8ba89a] mt-0.5">
                    {pageFilter === 'all'
                      ? 'All Pages'
                      : pageFilter === 'page1'
                      ? 'Page 1'
                      : 'Page 2'}{' '}
                    ·{' '}
                    <span className="text-[#10b981] font-semibold">
                      {selectedCategoriesLabel}
                    </span>{' '}
                    — Click any word to select it, or tap 1.0x / 0.75x to listen.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPersonalWordsModal();
                  }}
                  className="self-start sm:self-center min-h-[36px] px-3 py-1.5 rounded-xl bg-[#38bdf8]/15 hover:bg-[#38bdf8]/25 border border-[#38bdf8]/40 text-[#7dd3fc] text-xs font-bold flex items-center gap-1.5 shrink-0 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5 text-[#38bdf8]" />
                  <span>Add My Word</span>
                </button>
              </div>

              {/* Sort / Filter Bar for Identifying Most-Failed Words */}
              <div className="flex flex-wrap items-center justify-between gap-2 bg-[#09140f] border border-[#173024] rounded-xl p-2">
                <span className="text-[11px] font-semibold text-[#8ba89a] pl-1.5">
                  Sort / Filter by Test History:
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setStudySortMode('default');
                    }}
                    className={`min-h-[30px] px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                      studySortMode === 'default'
                        ? 'bg-[#10b981] text-[#04120c]'
                        : 'bg-[#12261d] text-[#9ab5a7] hover:text-white'
                    }`}
                  >
                    Default Order
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setStudySortMode('weakest');
                    }}
                    className={`min-h-[30px] px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                      studySortMode === 'weakest'
                        ? 'bg-[#fbbf24] text-[#04120c]'
                        : 'bg-[#12261d] text-[#fbbf24] hover:bg-[#193529]'
                    }`}
                  >
                    Weakest First
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setStudySortMode('failedOnly');
                    }}
                    className={`min-h-[30px] px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                      studySortMode === 'failedOnly'
                        ? 'bg-[#f87171] text-[#04120c]'
                        : 'bg-[#12261d] text-[#f87171] hover:bg-[#2a1418]'
                    }`}
                  >
                    Failed Only ({failedWordsInDeckCount})
                  </button>
                </div>
              </div>

              {filteredDeck.length === 0 ? (
                <div className="py-8 text-center space-y-3">
                  <p className="text-xs text-[#8ba89a]">
                    {studySortMode === 'failedOnly'
                      ? 'No failed words recorded in this category yet! Complete a test or practice to track mistakes.'
                      : pageFilter === 'personal'
                      ? 'You have not added any personal struggling words yet.'
                      : 'No words in the selected filter.'}
                  </p>
                  {studySortMode === 'failedOnly' ? (
                    <button
                      type="button"
                      onClick={() => setStudySortMode('default')}
                      className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#10b981] text-[#04120c] text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      <span>Show All Words</span>
                    </button>
                  ) : (
                    pageFilter === 'personal' && (
                      <button
                        type="button"
                        onClick={onOpenPersonalWordsModal}
                        className="min-h-[40px] px-4 py-2 rounded-xl bg-[#38bdf8] text-[#04120c] text-xs font-extrabold inline-flex items-center gap-1.5"
                      >
                        <Plus className="w-4 h-4" />
                        <span>Add Your First Struggling Word</span>
                      </button>
                    )
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2.5 max-h-[540px] overflow-y-auto overflow-x-hidden pr-1">
                  {filteredDeck.map((item, idx) => {
                    const rec = recordingsMap[item.id];
                    const itemBangla = rec?.banglaMeaning || item.bangla;
                    const itemStats = getWordStats(item);
                    const isSelectedWord =
                      Boolean(currentWord) && currentWord.id === item.id;
                    const shouldBlurActiveSpelling =
                      isSelectedWord &&
                      isPracticingBlur &&
                      !submitted &&
                      !showStudyWord;
                    const isPlayingNormal =
                      playingStudyWordId === `${item.id}_1`;
                    const isPlayingSlow =
                      playingStudyWordId === `${item.id}_0.72`;

                    return (
                      <div
                        key={item.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCurrentIndex(idx);
                          setSubmitted(false);
                          setUserInput('');
                          setIsPracticingBlur(false);
                          setMobilePracticeTab('card');
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            setCurrentIndex(idx);
                            setSubmitted(false);
                            setUserInput('');
                            setIsPracticingBlur(false);
                            setMobilePracticeTab('card');
                          }
                        }}
                        className={`w-full p-3.5 rounded-xl border transition-all cursor-pointer flex flex-col gap-2 ${
                          isSelectedWord
                            ? 'bg-[#122b20] border-[#10b981] ring-1 ring-[#10b981]/30'
                            : itemStats.attempts > 0 &&
                              itemStats.accuracyPct < 50
                            ? 'bg-[#170e11] hover:bg-[#221317] border-[#f87171]/35'
                            : 'bg-[#09140f] hover:bg-[#10231a] border-[#173024]'
                        }`}
                      >
                        {/* Top Line: Word Number + Full English Word + Active/Accuracy Badges + Audio Buttons */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            <span className="text-xs font-mono tabular-nums text-[#6d8a7b] shrink-0">
                              #{idx + 1}
                            </span>
                            <span
                              className={`text-base sm:text-lg font-bold font-mono text-white transition-all duration-200 ${
                                shouldBlurActiveSpelling
                                  ? 'blur-md select-none'
                                  : ''
                              }`}
                            >
                              {item.word}
                            </span>
                            {isSelectedWord && (
                              <span className="px-2 py-0.5 rounded-md bg-[#10b981]/20 text-[#10b981] text-[10px] font-bold whitespace-nowrap shrink-0">
                                {shouldBlurActiveSpelling
                                  ? 'Active · Blurred'
                                  : 'Active'}
                              </span>
                            )}
                            {itemStats.attempts > 0 ? (
                              <span
                                className={`px-2 py-0.5 rounded-md text-[10px] font-mono tabular-nums font-bold whitespace-nowrap shrink-0 border ${
                                  itemStats.accuracyPct < 50
                                    ? 'bg-[#2a1215] text-[#f87171] border-[#f87171]/40'
                                    : itemStats.accuracyPct < 80
                                    ? 'bg-[#29200e] text-[#fbbf24] border-[#fbbf24]/40'
                                    : 'bg-[#0e291e] text-[#10b981] border-[#10b981]/40'
                                }`}
                              >
                                {itemStats.accuracyPct}% ({itemStats.correct}/
                                {itemStats.attempts})
                                {itemStats.failed > 0
                                  ? ` · ${itemStats.failed} failed`
                                  : ''}
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-md bg-[#11221a] text-[#6d8a7b] text-[10px] font-medium whitespace-nowrap shrink-0">
                                Untested
                              </span>
                            )}
                          </div>

                          <div
                            className="flex items-center gap-1.5 shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => void handlePlayStudyItem(item, 1.0)}
                              title={`Listen to ${item.word} (1.0x)`}
                              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                                isPlayingNormal
                                  ? 'bg-[#10b981] text-[#04120c]'
                                  : 'bg-[#10b981]/15 hover:bg-[#10b981]/30 text-[#10b981] border border-[#10b981]/40'
                              }`}
                            >
                              <Volume2 className="w-3.5 h-3.5 shrink-0" />
                              <span>1.0x</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => void handlePlayStudyItem(item, 0.72)}
                              title={`Listen slow to ${item.word} (0.75x)`}
                              className={`min-h-[36px] px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 whitespace-nowrap transition-colors ${
                                isPlayingSlow
                                  ? 'bg-[#fbbf24] text-[#04120c]'
                                  : 'bg-[#13291f] hover:bg-[#1a372a] text-[#d2e5dc] border border-[#234435]'
                              }`}
                            >
                              <Gauge className="w-3.5 h-3.5 text-[#10b981] shrink-0" />
                              <span>0.75x</span>
                            </button>
                          </div>
                        </div>

                        {/* Middle Line (Full Width): Bangla Meaning + Page & Category */}
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <span className="text-sm font-medium text-[#d2e5dc]">
                            {itemBangla}
                          </span>
                          <span className="text-[11px] text-[#7ea090] whitespace-nowrap">
                            Page {item.page} · {item.category}
                          </span>
                        </div>

                        {/* Visual Accuracy Progress Bar */}
                        <div className="w-full flex items-center gap-2 pt-0.5">
                          <div className="flex-1 h-1.5 rounded-full bg-[#13281e] overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-300 ${
                                itemStats.attempts === 0
                                  ? 'bg-transparent'
                                  : itemStats.accuracyPct < 50
                                  ? 'bg-[#f87171]'
                                  : itemStats.accuracyPct < 80
                                  ? 'bg-[#fbbf24]'
                                  : 'bg-[#10b981]'
                              }`}
                              style={{
                                width:
                                  itemStats.attempts === 0
                                    ? '0%'
                                    : `${Math.max(6, itemStats.accuracyPct)}%`,
                              }}
                            />
                          </div>
                          <span
                            className={`text-[10px] font-mono tabular-nums shrink-0 ${
                              itemStats.attempts === 0
                                ? 'text-[#597567]'
                                : itemStats.accuracyPct < 50
                                ? 'text-[#f87171] font-bold'
                                : itemStats.accuracyPct < 80
                                ? 'text-[#fbbf24] font-semibold'
                                : 'text-[#10b981] font-semibold'
                            }`}
                          >
                            {itemStats.attempts === 0
                              ? '0/0'
                              : `${itemStats.accuracyPct}%`}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Bottom Row: Current Session Score (5 cols) + Recent Practice & Exam History (7 cols) */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-start">
            <div className="md:col-span-5 rounded-2xl bg-[#0d1d16] border border-[#1d382b] p-5 space-y-4">
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
            <div className="md:col-span-7 rounded-2xl bg-[#0d1d16] border border-[#1d382b] p-5 space-y-3">
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
