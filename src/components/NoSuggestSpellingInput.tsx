import React, { useRef, useState, useEffect } from 'react';
import { X } from 'lucide-react';

const SENTINEL = '\u200B';

interface NoSuggestSpellingInputProps {
  id?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (newValue: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  enterKeyHint?: 'done' | 'next' | 'go' | 'send' | 'search';
  variant?: 'practice' | 'exam';
}

/**
 * Zero-Suggestion Spelling Input for Mobile (Android Gboard, Samsung Keyboard, iOS) & Desktop.
 *
 * Why standard `autoComplete="off" autoCorrect="off" spellCheck={false}` is not enough on phones:
 * Android Gboard and mobile IMEs read the full word buffer from the focused `<input>` and display
 * dictionary completions (e.g. typing "monda" suggests "Monday").
 *
 * How this component prevents mobile keyboard spelling suggestions 100% of the time:
 * The underlying native `<input>` only ever holds a single zero-width sentinel character (`\u200B`).
 * On every keystroke, the typed character is immediately extracted into `value` and the native
 * `<input>` DOM value is reset to `\u200B`, forcing the mobile IME to reset its composition buffer
 * so the keyboard never sees a partial word to suggest or auto-correct.
 */
export const NoSuggestSpellingInput: React.FC<NoSuggestSpellingInputProps> = ({
  id,
  inputRef,
  value,
  onChange,
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

  const resetNativeInputToSentinel = (el: HTMLInputElement | null) => {
    if (!el) return;
    el.value = SENTINEL;
    try {
      el.setSelectionRange(1, 1);
    } catch {
      // Ignore selection range errors on some mobile browsers
    }
  };

  useEffect(() => {
    resetNativeInputToSentinel(resolvedRef.current);
  }, [value, resolvedRef]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    if (e.key === 'Backspace') {
      e.preventDefault();
      if (value.length > 0) {
        onChange(value.slice(0, -1));
      }
      resetNativeInputToSentinel(e.currentTarget);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      // Allow Ctrl+A + Backspace convenience by clearing if user wants, or keep sentinel
      return;
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    const el = e.currentTarget;
    const raw = el.value;

    // Case 1: Mobile virtual keyboard Backspace deleted the sentinel character
    if (!raw.includes(SENTINEL)) {
      const remainingChars = raw.replace(/\u200B/g, '');
      if (remainingChars.length === 0) {
        if (value.length > 0) {
          onChange(value.slice(0, -1));
        }
      } else {
        onChange(value + remainingChars);
      }
      resetNativeInputToSentinel(el);
      return;
    }

    // Case 2: Character(s) were typed alongside the sentinel
    const added = raw.replace(/\u200B/g, '');
    if (added.length > 0) {
      onChange(value + added);
    }

    // Reset native input immediately so Gboard/iOS never accumulates the word
    resetNativeInputToSentinel(el);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    e.preventDefault();
    const pasted = e.clipboardData.getData('text');
    if (pasted) {
      onChange(value + pasted.replace(/[\r\n]+/g, ' '));
    }
    resetNativeInputToSentinel(e.currentTarget);
  };

  const isExam = variant === 'exam';

  return (
    <div
      onClick={() => {
        if (!disabled) {
          resolvedRef.current?.focus();
          resetNativeInputToSentinel(resolvedRef.current);
        }
      }}
      className={`relative w-full flex items-center cursor-text transition-colors ${
        isExam
          ? `min-h-[54px] px-4 py-3.5 rounded-xl bg-[#07110c] border-2 ${
              isFocused ? 'border-[#fbbf24]' : 'border-[#264d3b]'
            }`
          : `min-h-[50px] px-4 py-3 rounded-xl bg-[#08130e] border ${
              isFocused ? 'border-[#10b981]' : 'border-[#224234]'
            }`
      } ${disabled ? 'opacity-65 cursor-not-allowed' : ''}`}
    >
      {/* Visible rendered text & blinking caret */}
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
                isExam ? 'text-lg' : 'text-base sm:text-lg'
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
              } font-medium text-white tracking-wide`}
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

      {/* Clear button when input has text */}
      {value.length > 0 && !disabled && (
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onChange('');
            resolvedRef.current?.focus();
            resetNativeInputToSentinel(resolvedRef.current);
          }}
          title="Clear text"
          className="ml-2 w-7 h-7 rounded-lg bg-[#13291f] hover:bg-[#1c3b2d] text-[#8ba89a] hover:text-white flex items-center justify-center shrink-0 z-20 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Hidden-text native input overlay that captures mobile & desktop keystrokes */}
      <input
        id={id}
        ref={resolvedRef}
        type="text"
         inputMode="text"
        defaultValue={SENTINEL}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        onChange={handleChange}
        onPaste={handlePaste}
        onFocus={(e) => {
          setIsFocused(true);
          resetNativeInputToSentinel(e.currentTarget);
          onFocus?.();
        }}
        onBlur={() => {
          setIsFocused(false);
          onBlur?.();
        }}
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-form-type="other"
        aria-label={placeholder}
        enterKeyHint={enterKeyHint}
        className="absolute inset-0 w-full h-full opacity-0 cursor-text z-10 text-transparent bg-transparent caret-transparent border-0 focus:outline-none"
      />
    </div>
  );
};
