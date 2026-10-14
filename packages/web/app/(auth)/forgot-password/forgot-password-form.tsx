'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authLinkClass } from '@/components/auth/auth-card';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { requestPasswordReset } from '@/lib/api/auth';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { SUBMITTING, fieldErrorMessage } from '@/lib/auth/copy';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_EMAIL = fieldErrorMessage('email', 'invalid');

/**
 * Forgot password (W01 US7, FR-023). The confirmation replaces the form only after a `202`; every other outcome keeps the
 * form and the typed address. Failures are never logged (the raw error may carry the address).
 */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [focus, setFocus] = useState<{ target: 'email' | 'alert'; n: number } | null>(null);
  const sending = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!focus) return;
    (focus.target === 'email' ? emailRef : alertRef).current?.focus();
  }, [focus]);

  useEffect(() => {
    if (sent) headingRef.current?.focus();
  }, [sent]);

  const requestFocus = (target: 'email' | 'alert') => setFocus((previous) => ({ target, n: (previous?.n ?? 0) + 1 }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    setProblem(null);
    if (!EMAIL.test(email.trim())) {
      setError(INVALID_EMAIL);
      requestFocus('email');
      return;
    }
    setError(null);
    sending.current = true;
    setPending(true);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (failure) {
      const found = problemFromError(failure);
      if (found.code === 'validation_failed' && found.errors.some((entry) => entry.field === 'email')) {
        setError(INVALID_EMAIL);
        requestFocus('email');
      } else {
        setProblem(found);
        requestFocus('alert');
      }
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  if (sent) {
    return (
      <div className="grid gap-4">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
          Check your inbox
        </h2>
        <p className="text-sm text-muted-foreground">
          If an account exists for that address, we&apos;ve sent a link to reset the password. The link works once and expires in 30 minutes.
        </p>
        <Link href="/login" className={authLinkClass}>
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-busy={pending}>
      <span role="status" className="sr-only">
        {pending ? SUBMITTING.reset : ''}
      </span>
      {problem && <ProblemAlert ref={alertRef} problem={problem} context="reset-request" />}
      <div className="grid gap-2">
        <Label htmlFor="forgot-email">Email</Label>
        <Input
          ref={emailRef}
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          readOnly={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'forgot-email-error' : undefined}
          className="h-11 sm:h-9"
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
        />
        {error && (
          <p id="forgot-email-error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" size="lg" className="min-h-11 w-full" disabled={pending} aria-busy={pending}>
        {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
        Send reset link
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className={authLinkClass}>
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
