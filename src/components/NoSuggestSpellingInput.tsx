import React, { useRef, useState } from 'react';
import { X, Keyboard, Delete, CornerDownLeft } from 'lucide-react';

interface NoSuggestSpellingInputProps {
  id?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (newValue: string) => void;
  onEnterPress?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  enterKeyHint?: 'done' | 'next' | 'go' | 'send' | 'search';
  variant?: 'practice' | 'exam';
}

const QWERTY_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', '-', "'"],
];

/**
 * 100% Zero-Suggestion Spelling Input for Mobile (Android APK, Gboard, Samsung Keyboard, iOS) & Desktop.
 *
 * Why mobile keyboards normally suggest words on `<input type="text">`:
 * Android Gboard & Samsung Keyboard ignore `autocomplete="off"` on `type="text"` and run IME
 * composition (`TYPE_CLASS_TEXT`), displaying predictive word completions above the keyboard.
 *
 * How this component guarantees ZERO spelling suggestions in every practice word & test:
 * 1. The underlying native `<input>` uses `type="password"` while remaining `opacity-0` (invisible).
 *    By OS security law on Android (Gboard/Samsung/SwiftKey) and iOS, `type="password"` forces
 *    `TYPE_TEXT_VARIATION_PASSWORD` which completely disables the predictive suggestion strip,
 *    auto-correct, and IME composition buffer.
 * 2. Meanwhile, our custom visible layer directly beneath the `opacity-0` input renders `{value}`
 *    in clear, readable letters so the student sees their exact spelling (not password dots).
 * 3. `readOnly` is held until touch/focus so browsers never attach a Password Manager autofill popup.
 * 4. Also includes an optional 1-tap built-in Exam QWERTY Keyboard for mobile touch users.
 */
export const NoSuggestSpellingInput: React.FC<NoSuggestSpellingInputProps> = ({
  id,
  inputRef,
  value,
  onChange,
  onEnterPress,
  onFocus,
  onBlur,
  disabled = false,
  placeholder = 'Type the word you hear...',
  enterKeyHint = 'done',
  variant = 'practice',
}) => {
  const internalRef = useRef<HTMLInputElement | null>(null);
  const resolvedRef = inputRef || internalRef;
  const [isFocused, setIsFocused] = useState(false);
  const [readOnlyGuard, setReadOnlyGuard] = useState(true);
  const [useInAppKeyboard, setUseInAppKeyboard] = useState<boolean>(() => {
    try {
      return localStorage.getItem('lw_use_inapp_kb') === '1';
    } catch {
      return false;
    }
  });
  const [randomFieldName] = useState(
    () => `lw_ns_${Math.random().toString(36).slice(2, 10)}`
  );

  const toggleInAppKeyboard = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !useInAppKeyboard;
    setUseInAppKeyboard(next);
    try {
      localStorage.setItem('lw_use_inapp_kb', next ? '1' : '0');
    } catch {
      // Ignore storage errors
    }
    if (next) {
      resolvedRef.current?.blur();
      setIsFocused(true);
      onFocus?.();
    } else {
      setReadOnlyGuard(false);
      setTimeout(() => resolvedRef.current?.focus(), 20);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'Enter' && onEnterPress) {
      e.preventDefault();
      e.stopPropagation();
      onEnterPress();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    onChange(e.currentTarget.value);
  };

  const handleVirtualKey = (char: string) => {
    if (disabled) return;
    onFocus?.();
    setIsFocused(true);
    onChange(value + char);
  };

  const handleVirtualBackspace = () => {
    if (disabled) return;
    onFocus?.();
    setIsFocused(true);
    if (value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const isExam = variant === 'exam';

  return (
    <div className="w-full space-y-2">
      <div
        onClick={() => {
          if (disabled) return;
          if (useInAppKeyboard) {
            setIsFocused(true);
            onFocus?.();
          } else {
            setReadOnlyGuard(false);
            resolvedRef.current?.focus();
          }
        }}
        className={`relative w-full flex items-center cursor-text transition-colors ${
          isExam
            ? `min-h-[54px] px-4 py-3.5 rounded-2xl bg-[#07110c] border-2 ${
                isFocused
                  ? 'border-[#fbbf24] shadow-[0_0_0_3px_rgba(251,191,36,0.12)]'
                  : 'border-[#264d3b]'
              }`
            : `min-h-[52px] px-4 py-3 rounded-2xl bg-[#08130e] border-2 ${
                isFocused
                  ? 'border-[#10b981] shadow-[0_0_0_3px_rgba(16,185,129,0.12)]'
                  : 'border-[#224234]'
              }`
        } ${disabled ? 'opacity-65 cursor-not-allowed' : ''}`}
      >
        {/* Visible rendered plain-text spelling & blinking caret */}
        <div className="flex-1 min-w-0 flex items-center overflow-x-auto no-scrollbar pointer-events-none select-none">
          {value.length === 0 ? (
            <>
              {isFocused && !disabled && (
                <span
                  className={`inline-block w-[2px] h-5 mr-0.5 animate-pulse ${
                    isExam ? 'bg-[#fbbf24]' : 'bg-[#10b981]'
                  }`}
                />
              )}
              <span
                className={`${
                  isExam ? 'text-base sm:text-lg' : 'text-base sm:text-lg'
                } font-medium text-[#4c6b5c] truncate`}
              >
                {placeholder}
              </span>
            </>
          ) : (
            <div className="flex items-center whitespace-pre">
              <span
                className={`${
                  isExam ? 'text-lg' : 'text-base sm:text-lg'
                } font-mono font-bold text-white tracking-wide`}
              >
                {value}
              </span>
              {isFocused && !disabled && (
                <span
                  className={`inline-block w-[2px] h-5 ml-0.5 animate-pulse ${
                    isExam ? 'bg-[#fbbf24]' : 'bg-[#10b981]'
                  }`}
                />
              )}
            </div>
          )}
        </div>

        {/* Right Controls: Clear button + Mobile In-App Exam Keyboard Toggle */}
        <div className="flex items-center gap-1.5 ml-2 shrink-0 z-20">
          {value.length > 0 && !disabled && (
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onChange('');
                if (!useInAppKeyboard) {
                  setReadOnlyGuard(false);
                  resolvedRef.current?.focus();
                }
              }}
              title="Clear text"
              className="w-7 h-7 rounded-lg bg-[#13291f] hover:bg-[#1c3b2d] text-[#8ba89a] hover:text-white flex items-center justify-center transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {!disabled && (
            <button
              type="button"
              tabIndex={-1}
              onClick={toggleInAppKeyboard}
              title={
                useInAppKeyboard
                  ? 'Using Built-in Exam Keyboard (Tap to use Phone Keyboard)'
                  : 'Switch to Built-in Exam Keyboard (100% No OS Popups)'
              }
              className={`md:hidden h-7 px-2 rounded-lg border text-[10px] font-bold flex items-center gap-1 transition-colors ${
                useInAppKeyboard
                  ? 'bg-[#10b981] border-[#10b981] text-[#04120c]'
                  : 'bg-[#11241b] border-[#234435] text-[#8ba89a]'
              }`}
            >
              <Keyboard className="w-3 h-3" />
              <span>{useInAppKeyboard ? 'App Keys' : 'No-Suggest'}</span>
            </button>
          )}
        </div>

        {/* Invisible native input overlay using type="password" so Android Gboard / iOS NEVER shows word suggestions */}
        {!useInAppKeyboard && (
          <input
            id={id}
            ref={resolvedRef}
            name={randomFieldName}
            type="password"
            inputMode="text"
            readOnly={readOnlyGuard}
            value={value}
            disabled={disabled}
            onTouchStart={() => {
              if (!disabled) setReadOnlyGuard(false);
            }}
            onMouseDown={() => {
              if (!disabled) setReadOnlyGuard(false);
            }}
            onKeyDown={handleKeyDown}
            onChange={handleChange}
            onFocus={(e) => {
              setReadOnlyGuard(false);
              setIsFocused(true);
              try {
                const len = e.currentTarget.value.length;
                e.currentTarget.setSelectionRange(len, len);
              } catch {
                // Ignore selection range errors
              }
              onFocus?.();
            }}
            onBlur={() => {
              setIsFocused(false);
              setReadOnlyGuard(true);
              onBlur?.();
            }}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-lpignore="true"
            data-1p-ignore="true"
            data-bwignore="true"
            data-form-type="other"
            aria-label={placeholder}
            enterKeyHint={enterKeyHint}
            className="absolute inset-0 w-full h-full opacity-0 cursor-text z-10 text-transparent bg-transparent caret-transparent border-0 focus:outline-none"
          />
        )}
      </div>

      {/* Built-in Tactile Mobile Exam Keyboard (when App Keys mode is toggled on mobile) */}
      {useInAppKeyboard && !disabled && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="md:hidden rounded-2xl bg-[#07120d] border border-[#1f3d2f] p-2 space-y-1.5 select-none shadow-xl"
        >
          {QWERTY_ROWS.map((row, rIdx) => (
            <div key={rIdx} className="flex justify-center gap-1">
              {row.map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => handleVirtualKey(ch)}
                  className="flex-1 min-w-0 h-10 rounded-lg bg-[#12281e] active:bg-[#10b981] active:text-[#04120c] border border-[#224535] text-sm font-mono font-bold text-white flex items-center justify-center transition-colors"
                >
                  {ch}
                </button>
              ))}
            </div>
          ))}
          <div className="flex items-center gap-1.5 pt-0.5">
            <button
              type="button"
              onClick={() => handleVirtualKey(' ')}
              className="flex-[3] h-10 rounded-lg bg-[#12281e] active:bg-[#10b981] active:text-[#04120c] border border-[#224535] text-xs font-bold text-[#c4d9ce] flex items-center justify-center"
            >
              Space
            </button>
            <button
              type="button"
              onClick={handleVirtualBackspace}
              className="flex-1 h-10 rounded-lg bg-[#2a1418] active:bg-[#f87171] active:text-[#04120c] border border-[#f87171]/40 text-xs font-bold text-[#fca5a5] flex items-center justify-center gap-1"
            >
              <Delete className="w-4 h-4" />
            </button>
            {onEnterPress && (
              <button
                type="button"
                onClick={() => onEnterPress()}
                className="flex-[1.5] h-10 rounded-lg bg-[#10b981] active:bg-[#059669] text-[#04120c] text-xs font-extrabold flex items-center justify-center gap-1"
              >
                <CornerDownLeft className="w-3.5 h-3.5" />
                <span>Done</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
