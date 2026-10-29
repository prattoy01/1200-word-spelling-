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
  CheckCircle2,
} from 'lucide-react';
import type { CloudRecording } from '../services/recordingsService';
import { saveWordRecording } from '../services/recordingsService';
import {
  ANDROID_APK_PATH,
  ANDROID_APK_FILENAME,
  triggerAndroidApkDownload,
} from './PWAInstallButton';
import { usePWAInstall } from '../hooks/usePWAInstall';

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
  const [apkDownloadStarted, setApkDownloadStarted] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { isInstallable, install } = usePWAInstall();

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

  const handleApkDownloadClick = () => {
    triggerAndroidApkDownload();
    setApkDownloadStarted(true);
    setTimeout(() => setApkDownloadStarted(false), 4000);
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Listen & Write — IELTS Cloud Studio (Android App & Web)',
          text: 'Download the Listen & Write IELTS Android APK or practice online with real-time Cloud Sync.',
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
        durationMs: r.durationMs || 1200,
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
                Download Official Android App (.APK) &amp; Mobile Link
              </h2>
              <p className="text-xs text-[#8ba89a]">
                Install the native Android APK (<code className="font-mono text-[#10b981]">{ANDROID_APK_FILENAME}</code>) with full offline audio &amp; live contest sync
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
          {/* 1. OFFICIAL ANDROID APK DOWNLOAD HERO CARD */}
          <div className="rounded-2xl bg-gradient-to-br from-[#0d291e] via-[#112e22] to-[#1a2814] border-2 border-[#10b981] p-5 space-y-4 shadow-xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1.5">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#10b981]/20 border border-[#10b981]/50 text-[#10b981] text-[11px] font-extrabold uppercase tracking-wider">
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>Native Signed Android Package (v2.4.0)</span>
                </div>
                <h3 className="text-xl font-extrabold text-white">
                  Listen &amp; Write IELTS — Android APK
                </h3>
                <p className="text-xs text-[#b7cec2] leading-relaxed max-w-xl">
                  Full Android application (<code className="font-mono text-[#a7f3d0]">app.listenwrite.ielts</code>) signed with Android v1/v2/v3 signatures for Android 5.0 through Android 15. Includes 3x auto-audio Strict Exam, Live Blind Contests, Personal Words, and Microphone Recording.
                </p>
              </div>

              <div className="flex flex-col gap-2 shrink-0">
                <a
                  href={ANDROID_APK_PATH}
                  download={ANDROID_APK_FILENAME}
                  onClick={() => {
                    setApkDownloadStarted(true);
                    setTimeout(() => setApkDownloadStarted(false), 4000);
                  }}
                  className="min-h-[48px] px-5 py-3 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-extrabold text-sm flex items-center justify-center gap-2 shadow-lg transition-colors whitespace-nowrap"
                >
                  <Download className="w-4 h-4 stroke-[2.5]" />
                  <span>Download Android APK</span>
                </a>

                {isInstallable && (
                  <button
                    type="button"
                    onClick={install}
                    className="min-h-[38px] px-4 py-2 rounded-xl bg-[#13291f] hover:bg-[#1a382b] border border-[#244c3a] text-xs font-bold text-[#fbbf24] flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Or Install Instant WebApp</span>
                  </button>
                )}
              </div>
            </div>

            {apkDownloadStarted && (
              <div className="rounded-xl bg-[#071610] border border-[#10b981]/50 px-4 py-2.5 text-xs text-[#a7f3d0] flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-[#10b981] shrink-0" />
                <span>
                  Downloading <strong>{ANDROID_APK_FILENAME}</strong>! Open the downloaded file on your Android phone and tap <strong>Install</strong>.
                </span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-[#1e4433] text-xs text-[#c4d9ce]">
              <div className="rounded-xl bg-[#091610]/90 border border-[#193528] p-3">
                <div className="font-bold text-[#10b981] mb-0.5">Step 1: Download</div>
                <p className="text-[11px] text-[#8ba89a]">
                  Tap <strong>Download Android APK</strong> above to save <code className="font-mono text-white">{ANDROID_APK_FILENAME}</code>.
                </p>
              </div>
              <div className="rounded-xl bg-[#091610]/90 border border-[#193528] p-3">
                <div className="font-bold text-[#fbbf24] mb-0.5">Step 2: Open APK</div>
                <p className="text-[11px] text-[#8ba89a]">
                  Tap the downloaded <code className="font-mono text-white">.apk</code> notification or open it from your <strong>Downloads</strong> folder.
                </p>
              </div>
              <div className="rounded-xl bg-[#091610]/90 border border-[#193528] p-3">
                <div className="font-bold text-white mb-0.5">Step 3: Install &amp; Launch</div>
                <p className="text-[11px] text-[#8ba89a]">
                  Tap <strong>Install</strong> (if Play Protect asks on first install, tap <strong>More details &rarr; Install anyway</strong>).
                </p>
              </div>
            </div>
          </div>

          {/* 2. Share Link or Direct APK Download Link */}
          <div className="rounded-xl bg-[#13281f] border border-[#244a39] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-[#10b981]">
                  Share App Link or Direct APK URL with Students
                </div>
                <h3 className="text-base font-bold text-white mt-0.5">
                  Copy Active Link or Send to Mobile Phone
                </h3>
              </div>
              <button
                type="button"
                onClick={handleApkDownloadClick}
                className="px-3.5 py-2 rounded-xl bg-[#10b981]/15 hover:bg-[#10b981]/25 border border-[#10b981]/40 text-xs font-bold text-[#10b981] flex items-center gap-1.5 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .APK Again</span>
              </button>
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

            <div className="rounded-lg bg-[#1c2410] border border-[#fbbf24]/30 p-3.5 text-xs text-[#e2e8f0] flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-[#fbbf24] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <strong className="text-[#fbbf24] block">
                  Enable Google Popup Sign-In on Vercel (10-Second Step):
                </strong>
                <p className="leading-relaxed">
                  In <strong>Firebase Console &rarr; Project &ldquo;protean-sandbox-t01dl&rdquo; &rarr; Authentication &rarr; Settings &rarr; Authorized domains &rarr; Add domain</strong>, add <code className="font-mono text-[#fbbf24]">1200-word-spelling.vercel.app</code>. (Direct Email &amp; Student Name-Only Unique #ID login already work everywhere immediately!)
                </p>
              </div>
            </div>
          </div>

          {/* 3. Live Cloud Sync Status & 1-Click Restore of Screenshot 14 Uploads */}
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
                    {localUnsyncedCount} local recording(s) waiting for Sign-In to sync to Cloud.
                  </p>
                )}
                <p className="mt-2 text-xs text-[#8ba89a]">
                  All {cloudCount} cloud recordings play automatically on Web, Android APK, and Incognito without disappearing.
                </p>
              </div>

              {!isSignedIn ? (
                <button
                  onClick={onSignIn}
                  className="mt-4 w-full py-2.5 px-4 rounded-xl bg-[#10b981] hover:bg-[#059669] text-[#04120c] font-semibold text-sm transition-colors flex items-center justify-center gap-2"
                >
                  <CloudCheck className="w-4 h-4" />
                  <span>Sign in to Sync Uploads</span>
                </button>
              ) : (
                <div className="mt-4 py-2 px-3 rounded-lg bg-[#10b981]/10 border border-[#10b981]/30 text-xs text-[#10b981] flex items-center gap-2">
                  <CloudCheck className="w-4 h-4 shrink-0" />
                  <span>Connected to Firebase Cloud — Web &harr; Android APK sync active</span>
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
                  Automatically generate and sync the 14 uploaded words (<strong className="text-[#d2e5dc]">orienteering, caving, scuba-diving, snorkeling</strong>, etc.) across Web and Android APK.
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

          {/* 4. Export / Import Bundle */}
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
