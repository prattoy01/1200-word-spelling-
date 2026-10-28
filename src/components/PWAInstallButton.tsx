import React, { useState } from 'react';
import { Smartphone, Download, X, Share } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const ANDROID_APK_PATH = '/ListenWrite-IELTS.apk';
export const ANDROID_APK_FILENAME = 'ListenWrite-IELTS.apk';

export function triggerAndroidApkDownload(): void {
  const link = document.createElement('a');
  link.href = ANDROID_APK_PATH;
  link.download = ANDROID_APK_FILENAME;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

interface PWAInstallButtonProps {
  onOpenMobileLinkModal?: () => void;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  onOpenMobileLinkModal,
}) => {
  const { isInstalled, isIOS } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  const handleDownloadApkAndOpenModal = () => {
    triggerAndroidApkDownload();
    if (onOpenMobileLinkModal) {
      onOpenMobileLinkModal();
    }
  };

  if (isIOS && !isInstalled) {
    return (
      <>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleDownloadApkAndOpenModal}
            className="px-3.5 py-2 rounded-xl bg-[#10b981] hover:bg-[#059669] text-xs font-extrabold text-[#04120c] flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Get Mobile App &amp; Link (.APK)</span>
          </button>
          <button
            type="button"
            onClick={() => setShowIOSGuide(true)}
            className="px-3 py-2 rounded-xl bg-[#13291f] hover:bg-[#1a382b] border border-[#244c3a] text-xs font-semibold text-[#10b981] flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>iOS</span>
          </button>
        </div>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
            <div className="w-full max-w-sm rounded-2xl bg-[#0e1f18] border border-[#224535] p-6 shadow-2xl space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Share className="w-4 h-4 text-[#10b981]" />
                  <span>Install on iPhone / iPad</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="text-[#8ba89a] hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ol className="text-xs text-[#c4d9ce] space-y-2 list-decimal list-inside leading-relaxed">
                <li>
                  Open this link in <strong>Safari</strong> on your iPhone or iPad.
                </li>
                <li>
                  Tap the <strong>Share</strong> icon at the bottom of Safari.
                </li>
                <li>
                  Scroll down and tap <strong>Add to Home Screen</strong>.
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full py-2.5 rounded-xl bg-[#10b981] text-[#04120c] text-xs font-bold"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={handleDownloadApkAndOpenModal}
      className="px-3.5 py-2 rounded-xl bg-[#10b981] hover:bg-[#059669] text-xs font-extrabold text-[#04120c] flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 shadow-sm"
    >
      <Download className="w-3.5 h-3.5" />
      <span>Get Mobile App &amp; Link (.APK)</span>
    </button>
  );
};
