import React from 'react';
import { Globe, Mic, ShieldCheck, Volume2 } from 'lucide-react';
import {
  getWordAudioSourceInfo,
  type WordAudioSourceKind,
} from '../utils/audioUtils';

interface AudioSourceTagProps {
  word: string;
  recording?: {
    audioDataUrl?: string | null;
    isPersonalOverride?: boolean;
    ownerName?: string | null;
  } | null;
  hasBundledAudio?: boolean;
  compact?: boolean;
}

const STYLE_BY_KIND: Record<WordAudioSourceKind, string> = {
  personal:
    'bg-[#38bdf8]/12 border-[#38bdf8]/40 text-[#7dd3fc]',
  admin:
    'bg-[#fbbf24]/12 border-[#fbbf24]/40 text-[#fde68a]',
  'default-bundled':
    'bg-[#10b981]/12 border-[#10b981]/35 text-[#6ee7b7]',
  'browser-default':
    'bg-[#1e293b]/70 border-[#475569]/60 text-[#cbd5e1]',
};

export const AudioSourceTag: React.FC<AudioSourceTagProps> = ({
  word,
  recording,
  hasBundledAudio,
  compact = false,
}) => {
  const info = getWordAudioSourceInfo({
    word,
    recording,
    hasBundledAudio,
  });

  const Icon =
    info.kind === 'personal'
      ? Mic
      : info.kind === 'admin'
      ? ShieldCheck
      : info.kind === 'default-bundled'
      ? Volume2
      : Globe;

  return (
    <span
      title={info.detail}
      className={`inline-flex items-center gap-1 rounded-md border font-semibold whitespace-nowrap shrink-0 ${
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'
      } ${STYLE_BY_KIND[info.kind]}`}
    >
      <Icon className={compact ? 'w-2.5 h-2.5 shrink-0' : 'w-3 h-3 shrink-0'} />
      <span>{compact ? info.shortLabel : info.label}</span>
    </span>
  );
};
