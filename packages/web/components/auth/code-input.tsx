'use client';

import { useId, type ChangeEvent, type ClipboardEvent, type Ref } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Digits only, at most 6: what a 6-digit authenticator code field holds. */
export const normalizeTotp = (raw: string): string => raw.replace(/\D/g, '').slice(0, 6);

/** `XXXXX-XXXXX` upper case from any spacing, case or hyphenation the member typed or pasted. */
export function normalizeRecoveryCode(raw: string): string {
  const compact = raw.replace(/[^a-z0-9]/gi, '').toUpperCase();
  return compact.length > 5 ? `${compact.slice(0, 5)}-${compact.slice(5)}` : compact;
}

/**
 * One text input for the second step (W01 AS-37, AS-33): numeric authenticator code or recovery code. It never submits by
 * itself; the form's Verify button (or Enter) does.
 */
export function CodeInput({
  mode,
  value,
  onChange,
  error,
  id,
  disabled,
  readOnly,
  label,
  hint,
  ref,
}: {
  mode: 'totp' | 'recovery';
  value: string;
  onChange: (next: string) => void;
  error?: string;
  id?: string;
  disabled?: boolean;
  readOnly?: boolean;
  /** Overrides the default label ("Authentication code" / "Recovery code"). */
  label?: string;
  /** Hint under the field; defaults to the recovery-code format in `recovery` mode and to none otherwise. */
  hint?: string;
  ref?: Ref<HTMLInputElement>;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const recovery = mode === 'recovery';
  const hintText = hint ?? (recovery ? 'Format: XXXXX-XXXXX' : undefined);
  const described = [hintText ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  const handle = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    // Recovery codes keep what is typed (the form normalises on submit) so the caret never jumps while typing.
    onChange(recovery ? raw : normalizeTotp(raw));
  };
  // `maxlength` would cut "123 456" at the sixth character before it could be normalised, so a paste is handled here.
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (recovery) return;
    event.preventDefault();
    onChange(normalizeTotp(event.clipboardData.getData('text')));
  };
  return (
    <div className="grid gap-2">
      <Label htmlFor={inputId}>{label ?? (recovery ? 'Recovery code' : 'Authentication code')}</Label>
      <Input
        ref={ref}
        id={inputId}
        name={recovery ? 'recoveryCode' : 'code'}
        type="text"
        value={value}
        onChange={handle}
        onPaste={paste}
        disabled={disabled}
        readOnly={readOnly}
        inputMode={recovery ? undefined : 'numeric'}
        maxLength={recovery ? undefined : 6}
        autoComplete={recovery ? 'off' : 'one-time-code'}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={described || undefined}
        className={`h-11 sm:h-9 ${recovery ? 'font-mono tracking-wider' : 'text-center text-lg tracking-[0.4em] sm:text-base'}`}
      />
      {hintText && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hintText}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
