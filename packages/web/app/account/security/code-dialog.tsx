'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CodeInput, normalizeRecoveryCode, normalizeTotp } from '@/components/auth/code-input';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { COPY } from '@/lib/auth/copy';
import { DESTRUCTIVE_TEXT, SHEET_DIALOG } from './dialog-styles';

/** The 409 answers that mean "the status you are looking at is stale" (W01 AS-49). */
export const STALE = new Set(['mfa_already_enabled', 'mfa_not_enabled', 'mfa_not_pending']);

export type CodeFormProps = {
  label: string;
  hint?: string;
  mode: 'totp' | 'recovery';
  submitLabel: string;
  destructive?: boolean;
  onClose: () => void;
  onBack?: () => void;
  onStale: (problem: Problem) => void;
  run: (code: string) => Promise<void>;
};

/** A dialog with one code field: regenerate, turn off, link Google (setup has its own steps around `CodeForm`). */
export function CodeDialog({ title, description, onClose, ...form }: CodeFormProps & { title: string; description: ReactNode }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={SHEET_DIALOG}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <CodeForm {...form} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The code field and its buttons. `invalid_code` is shown under the field, which is cleared and focused; stale-status
 * answers go to `onStale`; everything else is the shared alert (`429` included).
 */
export function CodeForm({ label, hint, mode, submitLabel, destructive, onClose, onBack, onStale, run }: CodeFormProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);
  const [focusN, setFocusN] = useState(0);
  const sending = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const alert = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusN > 0) field.current?.focus();
  }, [focusN]);

  useEffect(() => {
    if (problem) alert.current?.focus();
  }, [problem]);

  /** Up to six digits is an authenticator code and is sent as digits; anything longer or lettered is a recovery code (`XXXXX-XXXXX`). */
  const normalize = (raw: string) => {
    const compact = raw.replace(/[\s-]/g, '');
    return mode === 'totp' || (/^\d+$/.test(compact) && compact.length <= 6) ? normalizeTotp(raw) : normalizeRecoveryCode(raw);
  };

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    const value = normalize(code);
    setProblem(null);
    if (value.length < 6) {
      setError(mode === 'totp' ? 'Enter the 6-digit code.' : 'Enter a code.');
      setFocusN((n) => n + 1);
      return;
    }
    setError(undefined);
    sending.current = true;
    setPending(true);
    try {
      await run(value);
    } catch (failure) {
      const found = problemFromError(failure);
      if (found.code && STALE.has(found.code)) onStale(found);
      else if (found.code === 'invalid_code' || found.code === 'invalid_mfa_code') {
        setError(COPY.wrongCode);
        setCode('');
        setFocusN((n) => n + 1);
      } else setProblem(found);
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-busy={pending}>
      {problem && <ProblemAlert ref={alert} problem={problem} context="mfa-setup" />}
      <CodeInput
        ref={field}
        mode={mode}
        label={label}
        hint={hint}
        value={code}
        onChange={(next) => {
          setCode(next);
          setError(undefined);
        }}
        error={error}
        readOnly={pending}
      />
      <DialogFooter>
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" disabled={pending} onClick={onBack ?? onClose}>
          {onBack ? 'Back' : 'Cancel'}
        </Button>
        <Button type="submit" variant={destructive ? 'destructive' : 'default'} className={`min-h-11 sm:min-h-0 ${destructive ? DESTRUCTIVE_TEXT : ''}`} disabled={pending} aria-busy={pending}>
          {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
