import React, { useState, useEffect, useRef } from 'react';
import {
  Upload,
  Mic,
  Square,
  Play,
  Plus,
  Trash2,
  Check,
  Sparkles,
  Layers,
  Volume2,
} from 'lucide-react';
import {
  type ProcessedAudio,
  processAudioBlob,
  combineAudioBlobsOrDataUrls,
  splitPhraseIntoWordParts,
  playWordAudio,
} from '../utils/audioUtils';
import { type CloudRecording } from '../services/recordingsService';
import { toWordId } from '../data/words';

export interface WordPartSlot {
  id: string;
  label: string;
  audio: ProcessedAudio | null;
}

interface MultiWordAudioBuilderProps {
  phrase: string;
  recordingsMap?: Record<string, CloudRecording>;
  isSaving?: boolean;
  saveButtonLabel?: string;
  onCombinedAudioReady: (
    combinedAudio: ProcessedAudio,
    partsCount: number
  ) => Promise<void> | void;
}

export const MultiWordAudioBuilder: React.FC<MultiWordAudioBuilderProps> = ({
  phrase,
  recordingsMap = {},
  isSaving = false,
  saveButtonLabel,
  onCombinedAudioReady,
}) => {
  const detectedParts = splitPhraseIntoWordParts(phrase);
  const isNaturallyMultiWord = detectedParts.length >= 2;

  const [isExpanded, setIsExpanded] = useState<boolean>(isNaturallyMultiWord);
  const [slots, setSlots] = useState<WordPartSlot[]>([]);
  const [pauseMs, setPauseMs] = useState<number>(180);
  const [activeMicIndex, setActiveMicIndex] = useState<number | null>(null);
  const [micSeconds, setMicSeconds] = useState<number>(0);
  const [processingSlotIndex, setProcessingSlotIndex] = useState<number | null>(
    null
  );
  const [isCombining, setIsCombining] = useState<boolean>(false);
  const [previewCombinedAudio, setPreviewCombinedAudio] =
    useState<ProcessedAudio | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const multiFileInputRef = useRef<HTMLInputElement | null>(null);

  // Re-initialize slots whenever the selected phrase changes
  useEffect(() => {
    const parts = splitPhraseIntoWordParts(phrase);
    const initialLabels =
      parts.length >= 2 ? parts : [parts[0] || 'Part 1', 'Part 2'];

    setSlots(
      initialLabels.map((lbl, idx) => {
        const partWordId = toWordId(lbl);
        const existingRec = recordingsMap[partWordId];
        return {
          id: `slot-${idx}-${Date.now()}`,
          label: lbl,
          audio: existingRec
            ? {
                audioDataUrl: existingRec.audioDataUrl,
                mimeType: existingRec.mimeType,
                fileName: existingRec.fileName,
                fileSize: existingRec.fileSize,
                durationMs: existingRec.durationMs,
              }
            : null,
        };
      })
    );
    setIsExpanded(parts.length >= 2);
    setPreviewCombinedAudio(null);
    setLocalError(null);
  }, [phrase]);

  // Stop any active mic on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== 'inactive'
      ) {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const readySlots = slots.filter((s) => Boolean(s.audio?.audioDataUrl));
  const allSlotsReady = slots.length > 0 && readySlots.length === slots.length;

  const handleSlotFileUpload = async (
    index: number,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setLocalError(null);

    // If user selected multiple files even from a single slot picker, distribute them starting at `index`
    if (files.length > 1) {
      await handleBatchFilesUpload(Array.from(files), index);
      e.target.value = '';
      return;
    }

    const file = files[0];
    setProcessingSlotIndex(index);
    try {
      const processed = await processAudioBlob(file, file.name);
      setSlots((prev) =>
        prev.map((slot, i) =>
          i === index ? { ...slot, audio: processed } : slot
        )
      );
      setPreviewCombinedAudio(null);
      void playWordAudio({
        word: slots[index]?.label || phrase,
        audioDataUrl: processed.audioDataUrl,
      });
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Could not process audio file.'
      );
    } finally {
      setProcessingSlotIndex(null);
      e.target.value = '';
    }
  };

  const handleBatchFilesUpload = async (
    fileList: File[],
    startIndex = 0
  ) => {
    if (fileList.length === 0) return;
    setLocalError(null);
    setIsCombining(true);
    try {
      const processedList: ProcessedAudio[] = [];
      for (const f of fileList) {
        const proc = await processAudioBlob(f, f.name);
        processedList.push(proc);
      }

      const nextSlots = [...slots];
      for (let i = 0; i < processedList.length; i++) {
        const targetIdx = startIndex + i;
        if (targetIdx < nextSlots.length) {
          nextSlots[targetIdx] = {
            ...nextSlots[targetIdx],
            audio: processedList[i],
          };
        } else {
          nextSlots.push({
            id: `slot-${targetIdx}-${Date.now()}`,
            label: `Word ${targetIdx + 1}`,
            audio: processedList[i],
          });
        }
      }
      setSlots(nextSlots);

      // Automatically stitch and preview if at least 2 parts are ready
      const validSources = nextSlots
        .filter((s) => Boolean(s.audio?.audioDataUrl))
        .map((s) => s.audio!.audioDataUrl);

      if (validSources.length >= 2) {
        const combined = await combineAudioBlobsOrDataUrls(
          validSources,
          phrase || 'combined-words',
          pauseMs
        );
        setPreviewCombinedAudio(combined);
        await onCombinedAudioReady(combined, validSources.length);
      }
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? err.message
          : 'Failed to process multiple audio files.'
      );
    } finally {
      setIsCombining(false);
      if (multiFileInputRef.current) {
        multiFileInputRef.current.value = '';
      }
    }
  };

  const handleToggleSlotMic = async (index: number) => {
    if (activeMicIndex === index) {
      mediaRecorderRef.current?.stop();
      setActiveMicIndex(null);
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      return;
    }

    if (activeMicIndex !== null) {
      mediaRecorderRef.current?.stop();
      setActiveMicIndex(null);
      if (timerIntervalRef.current) {
        window.clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    }

    setLocalError(null);
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

        setProcessingSlotIndex(index);
        try {
          const partLabel = slots[index]?.label || `part-${index + 1}`;
          const processed = await processAudioBlob(
            blob,
            `${toWordId(partLabel)}-mic.wav`
          );
          setSlots((prev) =>
            prev.map((slot, i) =>
              i === index ? { ...slot, audio: processed } : slot
            )
          );
          setPreviewCombinedAudio(null);
          void playWordAudio({
            word: partLabel,
            audioDataUrl: processed.audioDataUrl,
          });
        } catch (err) {
          setLocalError(
            err instanceof Error
              ? err.message
              : 'Failed to save microphone clip.'
          );
        } finally {
          setProcessingSlotIndex(null);
        }
      };

      recorder.start();
      setActiveMicIndex(index);
      setMicSeconds(0);
      timerIntervalRef.current = window.setInterval(() => {
        setMicSeconds((s) => {
          if (s >= 6) {
            recorder.stop();
            setActiveMicIndex(null);
            if (timerIntervalRef.current) {
              window.clearInterval(timerIntervalRef.current);
            }
          }
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? `Microphone error: ${err.message}`
          : 'Could not access microphone.'
      );
    }
  };

  const handleCombineAndSave = async () => {
    const validSources = slots
      .filter((s) => Boolean(s.audio?.audioDataUrl))
      .map((s) => s.audio!.audioDataUrl);

    if (validSources.length === 0) {
      setLocalError(
        'Please upload or record audio for at least one word part first.'
      );
      return;
    }

    setLocalError(null);
    setIsCombining(true);
    try {
      const combined = await combineAudioBlobsOrDataUrls(
        validSources,
        phrase || slots.map((s) => s.label).join(' '),
        pauseMs
      );
      setPreviewCombinedAudio(combined);
      await onCombinedAudioReady(combined, validSources.length);
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? err.message
          : 'Failed to combine word pronunciations.'
      );
    } finally {
      setIsCombining(false);
    }
  };

  const handlePreviewCombinedOnly = async () => {
    const validSources = slots
      .filter((s) => Boolean(s.audio?.audioDataUrl))
      .map((s) => s.audio!.audioDataUrl);

    if (validSources.length === 0) return;

    setLocalError(null);
    setIsCombining(true);
    try {
      const combined = await combineAudioBlobsOrDataUrls(
        validSources,
        phrase || slots.map((s) => s.label).join(' '),
        pauseMs
      );
      setPreviewCombinedAudio(combined);
      await playWordAudio({
        word: phrase,
        audioDataUrl: combined.audioDataUrl,
      });
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Could not preview combined audio.'
      );
    } finally {
      setIsCombining(false);
    }
  };

  if (!isExpanded) {
    return (
      <div className="rounded-2xl bg-[#0a1611] border border-[#1d362a] px-4 py-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-[#9ab5a7]">
          <Layers className="w-4 h-4 text-[#fbbf24] shrink-0" />
          <span>
            Have separate audio clips for 2 or 3 words? Combine multiple word
            files into one pronunciation.
          </span>
        </div>
        <button
          type="button"
          onClick={() => setIsExpanded(true)}
          className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#fbbf24]/15 hover:bg-[#fbbf24]/25 border border-[#fbbf24]/40 text-xs font-bold text-[#fbbf24] flex items-center gap-1.5 shrink-0 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Upload Word-by-Word (2–3 Clips)</span>
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-[#0a1712] border border-[#fbbf24]/45 p-3.5 sm:p-4 space-y-3.5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-md bg-[#fbbf24]/20 text-[#fbbf24] text-[10px] font-extrabold uppercase tracking-wider">
              Multi-Word Audio Stitcher
            </span>
            <h3 className="text-xs sm:text-sm font-extrabold text-white">
              Upload Pronunciation for Each Word Separately ({slots.length}{' '}
              Words)
            </h3>
          </div>
          <p className="text-[11px] text-[#9ab5a7]">
            Upload or record each word part below (e.g.{' '}
            {slots.map((s, i) => (
              <React.Fragment key={s.id}>
                {i > 0 && ' + '}
                <strong className="text-[#fde68a]">&ldquo;{s.label}&rdquo;</strong>
              </React.Fragment>
            ))}
            ), or select multiple files at once. They will be automatically
            joined into one smooth pronunciation!
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Batch Select 2-3 Files at Once */}
          <label className="min-h-[36px] px-3 py-1.5 rounded-xl bg-[#fbbf24] hover:bg-[#f59e0b] text-[#08120e] text-xs font-extrabold flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap">
            <Upload className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>Select {slots.length} Files Together</span>
            <input
              ref={multiFileInputRef}
              type="file"
              multiple
              accept="audio/mp3,audio/mpeg,audio/mp4,audio/x-m4a,audio/m4a,audio/ogg,audio/wav,audio/webm,audio/*"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  void handleBatchFilesUpload(Array.from(e.target.files), 0);
                }
              }}
              className="hidden"
            />
          </label>

          {!isNaturallyMultiWord && (
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="min-h-[36px] px-2.5 py-1.5 rounded-xl bg-[#13291f] text-xs font-semibold text-[#8ca89a] hover:text-white"
            >
              Hide
            </button>
          )}
        </div>
      </div>

      {localError && (
        <div className="rounded-xl bg-[#2a1215] border border-[#f87171]/40 px-3 py-2 text-xs text-[#fecaca]">
          {localError}
        </div>
      )}

      {/* Per-Word Upload & Mic Slots */}
      <div className="space-y-2">
        {slots.map((slot, idx) => {
          const isSlotReady = Boolean(slot.audio?.audioDataUrl);
          const isSlotRecording = activeMicIndex === idx;
          const isSlotProcessing = processingSlotIndex === idx;

          return (
            <div
              key={slot.id}
              className={`rounded-xl border p-2.5 sm:p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 transition-colors ${
                isSlotReady
                  ? 'bg-[#0e261c] border-[#10b981]/50'
                  : 'bg-[#09130e] border-[#1c382b]'
              }`}
            >
              {/* Left: Word Number + Editable Word Part Name + Status */}
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span
                  className={`w-6 h-6 rounded-lg font-mono text-xs font-extrabold flex items-center justify-center shrink-0 ${
                    isSlotReady
                      ? 'bg-[#10b981] text-[#04120c]'
                      : 'bg-[#152c21] text-[#8ca89a]'
                  }`}
                >
                  {idx + 1}
                </span>

                <input
                  type="text"
                  value={slot.label}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSlots((prev) =>
                      prev.map((s, i) => (i === idx ? { ...s, label: val } : s))
                    );
                  }}
                  aria-label={`Word part ${idx + 1}`}
                  className="min-w-[90px] max-w-[160px] px-2.5 py-1 rounded-lg bg-[#07100c] border border-[#1f3d2f] text-xs sm:text-sm font-mono font-bold text-white focus:outline-none focus:border-[#fbbf24]"
                />

                {isSlotProcessing ? (
                  <span className="text-[11px] text-[#fbbf24] font-semibold">
                    Processing...
                  </span>
                ) : isSlotReady ? (
                  <span className="text-[11px] text-[#10b981] font-semibold flex items-center gap-1 truncate">
                    <Check className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      Ready (
                      {Math.max(
                        1,
                        Math.round((slot.audio?.durationMs || 800) / 100) / 10
                      )}
                      s)
                    </span>
                  </span>
                ) : (
                  <span className="text-[11px] text-[#6d8a7b] truncate">
                    No clip yet
                  </span>
                )}
              </div>

              {/* Right: Preview Part | Upload Part | Record Mic | Remove Slot */}
              <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    void playWordAudio({
                      word: slot.label,
                      audioDataUrl: slot.audio?.audioDataUrl,
                    })
                  }
                  title={
                    isSlotReady
                      ? `Play uploaded audio for "${slot.label}"`
                      : `Listen to dictionary audio for "${slot.label}"`
                  }
                  className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-[#12281e] hover:bg-[#19382a] border border-[#234435] text-xs font-semibold text-[#10b981] flex items-center gap-1"
                >
                  <Volume2 className="w-3.5 h-3.5 shrink-0" />
                  <span>{isSlotReady ? 'Play' : 'Dict'}</span>
                </button>

                <label className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-extrabold flex items-center gap-1 cursor-pointer transition-colors">
                  <Upload className="w-3.5 h-3.5 stroke-[2.5] shrink-0" />
                  <span>{isSlotReady ? 'Replace File' : `Upload #${idx + 1}`}</span>
                  <input
                    type="file"
                    multiple
                    accept="audio/mp3,audio/mpeg,audio/mp4,audio/x-m4a,audio/m4a,audio/ogg,audio/wav,audio/webm,audio/*"
                    onChange={(e) => void handleSlotFileUpload(idx, e)}
                    className="hidden"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => void handleToggleSlotMic(idx)}
                  className={`min-h-[36px] px-2.5 py-1.5 rounded-lg border text-xs font-bold flex items-center gap-1 transition-colors ${
                    isSlotRecording
                      ? 'bg-[#dc2626] border-[#f87171] text-white'
                      : 'bg-[#13291f] hover:bg-[#1a372a] border-[#234435] text-[#d2e5dc]'
                  }`}
                >
                  {isSlotRecording ? (
                    <>
                      <Square className="w-3 h-3 fill-current" />
                      <span>Stop ({micSeconds}s)</span>
                    </>
                  ) : (
                    <>
                      <Mic className="w-3.5 h-3.5 text-[#10b981]" />
                      <span>Mic</span>
                    </>
                  )}
                </button>

                {isSlotReady && (
                  <button
                    type="button"
                    onClick={() => {
                      setSlots((prev) =>
                        prev.map((s, i) =>
                          i === idx ? { ...s, audio: null } : s
                        )
                      );
                      setPreviewCombinedAudio(null);
                    }}
                    title="Clear this word's audio"
                    className="min-h-[36px] px-2 py-1.5 rounded-lg bg-[#2a1417] hover:bg-[#3b1a1f] text-[#fda4af] text-xs flex items-center justify-center"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}

                {slots.length > 2 && !isSlotReady && (
                  <button
                    type="button"
                    onClick={() =>
                      setSlots((prev) => prev.filter((_, i) => i !== idx))
                    }
                    title="Remove word slot"
                    className="min-h-[36px] px-2 py-1.5 rounded-lg bg-[#13291f] hover:bg-[#2a1417] text-[#8ca89a] hover:text-[#fda4af] text-xs flex items-center justify-center"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer Controls: + Add 3rd Word | Pause Selector | Preview & Combine Buttons */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-1 border-t border-[#183327]">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setSlots((prev) => [
                ...prev,
                {
                  id: `slot-${prev.length}-${Date.now()}`,
                  label: `Word ${prev.length + 1}`,
                  audio: null,
                },
              ])
            }
            className="min-h-[34px] px-2.5 py-1 rounded-lg bg-[#12281e] hover:bg-[#19382a] border border-[#234435] text-[11px] font-bold text-[#a7f3d0] flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Word Slot</span>
          </button>

          <div className="flex items-center gap-1 text-[11px] text-[#8ca89a]">
            <span>Gap:</span>
            {(
              [
                { ms: 90, label: 'Fast' },
                { ms: 180, label: 'Natural' },
                { ms: 300, label: 'Clear' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.ms}
                type="button"
                onClick={() => setPauseMs(opt.ms)}
                className={`px-2 py-1 rounded-md font-bold transition-colors ${
                  pauseMs === opt.ms
                    ? 'bg-[#fbbf24] text-[#08120e]'
                    : 'bg-[#11241c] text-[#9ab5a7] hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {readySlots.length >= 2 && (
            <button
              type="button"
              disabled={isCombining || isSaving}
              onClick={() => void handlePreviewCombinedOnly()}
              className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#12281e] hover:bg-[#19382a] border border-[#234b39] text-xs font-bold text-[#10b981] flex items-center gap-1.5 disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Preview Combined ({readySlots.length})</span>
            </button>
          )}

          <button
            type="button"
            disabled={readySlots.length === 0 || isCombining || isSaving}
            onClick={() => void handleCombineAndSave()}
            className={`min-h-[40px] px-4 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-colors disabled:opacity-50 ${
              allSlotsReady
                ? 'bg-[#fbbf24] hover:bg-[#f59e0b] text-[#08120e]'
                : 'bg-[#10b981] hover:bg-[#059669] text-[#04120c]'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>
              {isCombining || isSaving
                ? 'Combining & Saving...'
                : saveButtonLabel ||
                  `Combine & Save Full Audio (${readySlots.length}/${slots.length} Ready)`}
            </span>
          </button>
        </div>
      </div>

      {previewCombinedAudio && (
        <div className="rounded-xl bg-[#0e291e] border border-[#10b981]/50 px-3 py-2 flex items-center justify-between gap-2 text-xs text-[#a7f3d0]">
          <span>
            Combined <strong>{readySlots.length} word clips</strong> into one
            pronunciation ({Math.round(previewCombinedAudio.durationMs / 100) / 10}
            s · {Math.max(1, Math.round(previewCombinedAudio.fileSize / 1024))}{' '}
            KB)!
          </span>
          <button
            type="button"
            onClick={() =>
              void playWordAudio({
                word: phrase,
                audioDataUrl: previewCombinedAudio.audioDataUrl,
              })
            }
            className="min-h-[32px] px-2.5 py-1 rounded-lg bg-[#10b981] text-[#04120c] font-bold flex items-center gap-1 shrink-0"
          >
            <Volume2 className="w-3.5 h-3.5" />
            <span>Play Merged</span>
          </button>
        </div>
      )}
    </div>
  );
};
