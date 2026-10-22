import React, { useState, useRef } from 'react';
import {
  X,
  CloudCheck,
  Download,
  Upload,
  Sparkles,
  Copy,
  Check,
  Smartphone,
  Share2,
  ShieldCheck,
  ExternalLink,
  AlertCircle,
} from 'lucide-react';
import type { CloudRecording } from '../services/recordingsService';
import { saveWordRecording } from '../services/recordingsService';
import { PWAInstallButton } from './PWAInstallButton';

interface NetlifyFixModalProps {
  isOpen: boolean;
  onClose: () => void;
  recordingsMap: Record<string, CloudRecording>;
  isSignedIn: boolean;
  onSignIn: () => Promise<void>;
  onRestore14Uploads: () => Promise<void>;
  isRestoring14: boolean;
  restoreProgressText: string;
}

export const DEV_APP_URL =
  'https://ais-dev-vfja3juliugi6tlzdyn4s4-286639760996.asia-southeast1.run.app';

export function getActiveAppUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return DEV_APP_URL;
}

export const NetlifyFixModal: React.FC<NetlifyFixModalProps> = ({
  isOpen,
  onClose,
  recordingsMap,
  isSignedIn,
  onSignIn,
  onRestore14Uploads,
  isRestoring14,
  restoreProgressText,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const activeUrl = getActiveAppUrl();
  const recordingsList = Object.values(recordingsMap);
  const cloudCount = recordingsList.filter((r) => r.source === 'cloud').length;
  const localUnsyncedCount = recordingsList.filter(
    (r) => r.source === 'local-unsynced'
  ).length;

  const handleCopyAppLink = () => {
    navigator.clipboard.writeText(activeUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2200);
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Listen & Write — IELTS Cloud Studio',
          text: 'Practice IELTS Listening spelling and sync pronunciation recordings across Web & Mobile.',
          url: activeUrl,
        });
      } catch {
        // User dismissed share sheet
      }
    } else {
      handleCopyAppLink();
    }
  };

  const handleExportBundle = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 2,
      count: recordingsList.length,
      recordings: recordingsList.map((r) => ({
        wordId: r.wordId,
        word: r.word,
        banglaMeaning: r.banglaMeaning,
        audioDataUrl: r.audioDataUrl,
        mimeType: r.mimeType,
        fileName: r.fileName,
        fileSize: r.fileSize,
        durationMs: r.fileSize,
      })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `listen-write-recordings-bundle-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportBundle = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportStatus('Importing recordings...');
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : parsed.recordings || [];
      let imported = 0;

      for (const item of items) {
        if (item.wordId && item.audioDataUrl) {
          await saveWordRecording({
            wordId: item.wordId,
            word: item.word || item.wordId,
            banglaMeaning: item.banglaMeaning || '',
            audio: {
              audioDataUrl: item.audioDataUrl,
              mimeType: item.mimeType || 'audio/wav',
              fileName: item.fileName || `${item.wordId}.wav`,
              fileSize: item.fileSize || 1024,
              durationMs: item.durationMs || 1200,
            },
          });
          imported++;
        }
      }

      setImportStatus(
        `Successfully imported ${imported} recording(s) ${
          isSignedIn
            ? 'directly to Firebase Cloud!'
            : 'to local storage (Sign in with Google to sync to Cloud).'
        }`
      );
    } catch (err) {
      setImportStatus(
        `Import failed: ${
          err instanceof Error ? err.message : 'Invalid JSON file'
        }`
      );
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-2xl bg-[#0e1f18] border border-[#1f3b2e] shadow-2xl overflow-hidden my-8">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[#1f3b2e] bg-[#0a1712]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#10b981]/15 border border-[#10b981]/30 flex items-center justify-center text-[#10b981]">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">
                Web &harr; Mobile App Link &amp; Netlify Deployment Guide
              </h2>
              <p className="text-xs text-[#8ba89a]">
                Why the <code className="font-mono">ais-pre</code> link showed 404 — and how to open on Mobile or deploy to Netlify
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-[#8ba89a] hover:text-white hover:bg-[#162d23] transition-colors"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 max-h-[78vh] overflow-y-auto">
          {/* Why ais-pre gave 404 */}
          <div className="rounded-xl bg-[#1c2410] border border-[#fbbf24]/40 p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-bold text-[#fbbf24]">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>Why did &ldquo;ais-pre-...run.app&rdquo; show &ldquo;Error: Page not found&rdquo;?</span>
            </div>
            <p className="text-xs text-[#e2e8f0] leading-relaxed">
              In Google AI Studio, the <code className="font-mono text-[#fbbf24]">ais-pre-...</code> (Shared Preview) link only turns on <strong>after</strong> you click the <strong>Share / Publish</strong> button in the top-right corner of the AI Studio page. Until then, use the active link below or deploy directly to your <strong>Netlify</strong> site!
            </p>
          </div>

          {/* 1. Active App Link & How to Deploy to Netlify */}
          <div className="rounded-xl bg-[#13281f] border border-[#244a39] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-[#10b981]">
                  Current Active App URL
                </div>
                <h3 className="text-base font-bold text-white mt-0.5">
                  Copy Active Link or Install as App
                </h3>
              </div>
              <PWAInstallButton />
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <input
                type="text"
                readOnly
                value={activeUrl}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="flex-1 px-3.5 py-2.5 rounded-xl bg-[#08120e] border border-[#1f3d2f] text-xs font-mono text-[#a7f3d0] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleCopyAppLink}
                className="px-4 py-2.5 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] text-xs font-bold flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                {copiedLink ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Link Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    <span>Copy Active Link</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleNativeShare}
                className="px-3.5 py-2.5 rounded-xl bg-[#183529] hover:bg-[#1f4435] border border-[#2a5945] text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
              >
                <Share2 className="w-4 h-4 text-[#10b981]" />
                <span>Share</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 text-xs text-[#b7cec2]">
              <div className="rounded-lg bg-[#0b1812] border border-[#1d362a] p-3.5 space-y-1.5">
                <div className="font-bold text-white">
                  Way 1: Click &ldquo;Share&rdquo; in AI Studio (Top Right)
                </div>
                <p className="text-[#8ba89a] leading-relaxed">
                  Click the <strong>Share / Publish</strong> icon at the very top-right of Google AI Studio (outside this preview frame) and set visibility to <strong>Public</strong>. That activates your public share link for any phone or browser.
                </p>
              </div>
              <div className="rounded-lg bg-[#0b1812] border border-[#1d362a] p-3.5 space-y-1.5">
                <div className="font-bold text-white flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-[#10b981] shrink-0" />
                  <span>Way 2: Deploy to Your Netlify Site</span>
                </div>
                <p className="text-[#8ba89a] leading-relaxed">
                  Click the <strong>Download ZIP / Sync to GitHub</strong> icon in the top-right of AI Studio and deploy to Netlify (<code className="font-mono">netlify.toml</code> and <code className="font-mono">firebase-applet-config.json</code> are already included!). Just add your <code className="font-mono">*.netlify.app</code> domain under <strong>Firebase Console &rarr; Authentication &rarr; Settings &rarr; Authorized domains</strong>.
                </p>
              </div>
            </div>
          </div>

          {/* 2. Live Cloud Sync Status & 1-Click Restore of Screenshot 14 Uploads */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl bg-[#0b1812] border border-[#1f3b2e] p-4 flex flex-col justify-between">
              <div>
                <div className="text-xs font-medium text-[#8ba89a]">
                  Live Cloud Firestore Status
                </div>
                <div className="mt-2 flex items-baseline gap-3">
                  <span className="text-3xl font-bold font-mono tabular-nums text-[#10b981]">
                    {cloudCount}
                  </span>
                  <span className="text-sm text-[#c4d9ce]">
                    Cloud-Synced Recordings
                  </span>
                </div>
                {localUnsyncedCount > 0 && (
                  <p className="mt-1 text-xs text-[#fbbf24]">
                    {localUnsyncedCount} local recording(s) waiting for Google Sign-In to sync to Cloud.
                  </p>
                )}
                <p className="mt-2 text-xs text-[#8ba89a]">
                  All {cloudCount} cloud recordings play automatically on Web, Mobile App, and Incognito without disappearing.
                </p>
              </div>

              {!isSignedIn ? (
                <button
                  onClick={onSignIn}
                  className="mt-4 w-full py-2.5 px-4 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-semibold text-sm transition-colors flex items-center justify-center gap-2"
                >
                  <CloudCheck className="w-4 h-4" />
                  <span>Sign in with Google to Sync Uploads</span>
                </button>
              ) : (
                <div className="mt-4 py-2 px-3 rounded-lg bg-[#10b981]/10 border border-[#10b981]/30 text-xs text-[#10b981] flex items-center gap-2">
                  <CloudCheck className="w-4 h-4 shrink-0" />
                  <span>Connected to Firebase Cloud — Web &harr; Mobile sync active</span>
                </div>
              )}
            </div>

            {/* 1-Click Restore of Screenshot 2's 14 Uploads */}
            <div className="rounded-xl bg-[#0b1812] border border-[#1f3b2e] p-4 flex flex-col justify-between">
              <div>
                <div className="text-xs font-medium text-[#fbbf24]">
                  Quick Restore from Your Screenshot #2
                </div>
                <h3 className="mt-1 text-base font-bold text-white">
                  Sync Your 14 Outdoor &amp; Sports Words
                </h3>
                <p className="mt-1.5 text-xs text-[#8ba89a] leading-relaxed">
                  Automatically generate and sync the 14 uploaded words shown in your second screenshot (<strong className="text-[#d2e5dc]">orienteering, caving, scuba-diving, snorkeling</strong>, etc.) across Web and Mobile.
                </p>
              </div>

              <button
                onClick={onRestore14Uploads}
                disabled={isRestoring14}
                className="mt-4 w-full py-2.5 px-4 rounded-xl bg-[#fbbf24] hover:bg-[#f59e0b] disabled:opacity-50 text-[#09140f] font-semibold text-sm transition-colors flex items-center justify-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>
                  {isRestoring14
                    ? restoreProgressText || 'Syncing 14 recordings...'
                    : 'Restore & Sync 14 Screenshot Uploads'}
                </span>
              </button>
            </div>
          </div>

          {/* 3. Export / Import Bundle */}
          <div className="rounded-xl bg-[#0b1812] border border-[#1f3b2e] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">
                Backup, Export &amp; Import Recording Bundles (JSON)
              </h3>
              <a
                href={activeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[#10b981] hover:underline flex items-center gap-1"
              >
                <span>Open Active URL in New Tab</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
            <p className="text-xs text-[#8ba89a]">
              Export all your custom recordings into a portable <code className="font-mono">recordings-bundle.json</code> file or import recordings from another device into Firebase Cloud.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                onClick={handleExportBundle}
                disabled={recordingsList.length === 0}
                className="px-4 py-2 rounded-xl bg-[#162d23] hover:bg-[#1e3d30] disabled:opacity-40 text-white text-xs font-semibold border border-[#284d3d] transition-colors flex items-center gap-2"
              >
                <Download className="w-4 h-4 text-[#10b981]" />
                <span>Export All Uploads ({recordingsList.length})</span>
              </button>

              <label className="px-4 py-2 rounded-xl bg-[#162d23] hover:bg-[#1e3d30] text-white text-xs font-semibold border border-[#284d3d] transition-colors flex items-center gap-2 cursor-pointer">
                <Upload className="w-4 h-4 text-[#fbbf24]" />
                <span>Import Bundle JSON</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleImportBundle}
                  className="hidden"
                />
              </label>
            </div>
            {importStatus && (
              <p className="text-xs text-[#10b981] pt-1">{importStatus}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
