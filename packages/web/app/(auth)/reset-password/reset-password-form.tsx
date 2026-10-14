'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authLinkClass } from '@/components/auth/auth-card';
import { PasswordInput } from '@/components/auth/password-input';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { confirmPasswordReset } from '@/lib/api/auth';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { COPY, SUBMITTING, fieldErrorMessage } from '@/lib/auth/copy';

type Phase = 'reading' | 'form' | 'invalid' | 'done';
type Focus = { target: 'password' | 'confirm' | 'alert'; n: number };

const LENGTH_MESSAGE = 'Use 12 to 128 characters.';
const MISMATCH_MESSAGE = "The passwords don't match.";

/**
 * Reset password (W01 US7, FR-024). The token arrives in the URL fragment (never sent to a server): it is read once,
 * removed from the address bar and history with `history.replaceState`, and kept in a ref only. A `weak_password`,
 * `validation_failed` or `429` answer leaves the token unconsumed, so the form stays and the same token is resent.
 */
export function ResetPasswordForm() {
  const queryClient = useQueryClient();
  const token = useRef<string | null>(null);
  const read = useRef(false);
  const sending = useRef(false);
  const [phase, setPhase] = useState<Phase>('reading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordError, setPasswordError] = useState<string>();
  const [confirmError, setConfirmError] = useState<string>();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Read and strip the fragment exactly once (React runs effects twice in development, and the second run sees no hash).
  useEffect(() => {
    if (read.current) return;
    read.current = true;
    const value = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    token.current = value && value.length > 0 ? value : null;
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    setPhase(token.current ? 'form' : 'invalid');
  }, []);

  useEffect(() => {
    if (!focus) return;
    const refs = { password: passwordRef, confirm: confirmRef, alert: alertRef };
    refs[focus.target].current?.focus();
  }, [focus]);

  useEffect(() => {
    if (phase === 'done' || phase === 'invalid') headingRef.current?.focus();
  }, [phase]);

  const requestFocus = (target: Focus['target']) => setFocus((previous) => ({ target, n: (previous?.n ?? 0) + 1 }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || !token.current) return;
    setProblem(null);
    const lengthError = password.length < 12 || password.length > 128 ? LENGTH_MESSAGE : undefined;
    const mismatch = !lengthError && confirm !== password ? MISMATCH_MESSAGE : undefined;
    setPasswordError(lengthError);
    setConfirmError(mismatch);
    if (lengthError || mismatch) {
      requestFocus(lengthError ? 'password' : 'confirm');
      return;
    }
    sending.current = true;
    setPending(true);
    try {
      await confirmPasswordReset({ token: token.current, password });
      token.current = null;
      setPassword('');
      setConfirm('');
      queryClient.clear();
      setPhase('done');
    } catch (failure) {
      const found = problemFromError(failure);
      if (found.code === 'invalid_reset_token') {
        token.current = null;
        setPhase('invalid');
      } else if (found.code === 'weak_password' || found.errors.some((entry) => entry.field === 'password')) {
        const entry = found.errors.find((item) => item.field === 'password');
        setPasswordError(found.code === 'weak_password' ? COPY.weakPassword : fieldErrorMessage('password', entry?.code ?? ''));
        requestFocus('password');
      } else {
        setProblem(found);
        requestFocus('alert');
      }
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  if (phase === 'reading') return <div className="min-h-[16rem]" aria-busy="true" />;

  if (phase === 'invalid') {
    return (
      <div className="grid gap-4">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
          Link not valid
        </h2>
        <p role="alert" className="text-sm">
          {COPY.invalidResetToken}
        </p>
        <Link href="/forgot-password" className={authLinkClass}>
          Request a new link
        </Link>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="grid gap-4">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
          Password updated
        </h2>
        <p className="text-sm text-muted-foreground">Your password was changed. Sign in with your new password.</p>
        <Link href="/login?notice=password_reset" className={authLinkClass}>
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-busy={pending}>
      <span role="status" className="sr-only">
        {pending ? SUBMITTING.update : ''}
      </span>
      {problem && <ProblemAlert ref={alertRef} problem={problem} context="reset-confirm" />}
      <PasswordInput
        ref={passwordRef}
        id="reset-password"
        name="password"
        label="New password"
        autoComplete="new-password"
        error={passwordError}
        value={password}
        readOnly={pending}
        onChange={(event) => {
          setPassword(event.target.value);
          setPasswordError(undefined);
        }}
      />
      <PasswordInput
        ref={confirmRef}
        id="reset-confirm"
        name="confirmPassword"
        label="Confirm new password"
        autoComplete="new-password"
        error={confirmError}
        value={confirm}
        readOnly={pending}
        onChange={(event) => {
          setConfirm(event.target.value);
          setConfirmError(undefined);
        }}
      />
      <Button type="submit" size="lg" className="min-h-11 w-full" disabled={pending} aria-busy={pending}>
        {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
        Update password
      </Button>
    </form>
  );
}
