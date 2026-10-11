'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authLinkClass } from '@/components/auth/auth-card';
import { PasswordInput } from '@/components/auth/password-input';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLogin } from '@/hooks/use-auth-actions';
import type { Problem } from '@/lib/api/errors';
import type { SessionFailure } from '@/lib/api/session';
import { SUBMITTING } from '@/lib/auth/copy';
import { safeReturnTo } from '@/lib/auth/return-to';
import { GoogleButton } from './google-button';

type Focus = { target: 'email' | 'password' | 'alert'; n: number };

const toProblem = (failure: SessionFailure): Problem => ({
  status: failure.status,
  code: failure.code,
  errors: [],
  ...(failure.retryAfterSeconds !== undefined ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
  ...(failure.requestId ? { requestId: failure.requestId } : {}),
});

/**
 * Sign in (W01 US2, FR-021). The BFF sets the session cookies; this form only reacts to the typed result, switching on the
 * problem `code`, never on message text. `mfa_required` hands over to `/login/mfa` with history replaced and no secret in the URL.
 */
export function LoginForm({ returnTo, oidcEnabled }: { returnTo?: string; oidcEnabled: boolean }) {
  const router = useRouter();
  const safeTo = safeReturnTo(returnTo);
  const login = useLogin(safeTo);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);
  const [waitMs, setWaitMs] = useState<number | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const sending = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focus) return;
    const target = { email: emailRef, password: passwordRef, alert: alertRef }[focus.target];
    target.current?.focus();
  }, [focus]);

  // A throttled sign-in re-enables itself when the wait is over, without a reload (FR-041).
  useEffect(() => {
    if (waitMs === null) return;
    const timer = setTimeout(() => setWaitMs(null), waitMs);
    return () => clearTimeout(timer);
  }, [waitMs]);

  const requestFocus = (target: Focus['target']) => setFocus((previous) => ({ target, n: (previous?.n ?? 0) + 1 }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || waitMs !== null) return;
    const found: typeof errors = {};
    if (!email.trim()) found.email = 'Enter your email address.';
    if (!password) found.password = 'Enter your password.';
    setErrors(found);
    setProblem(null);
    if (found.email || found.password) {
      requestFocus(found.email ? 'email' : 'password');
      return;
    }
    sending.current = true;
    setPending(true);
    const result = await login.mutateAsync({ email: email.trim(), password });
    if (result.ok) {
      // `session`: the hook has navigated; `mfa_required`: second step. The form stays locked while the page changes.
      if (result.kind === 'mfa_required') router.replace(safeTo === '/' ? '/login/mfa' : `/login/mfa?returnTo=${encodeURIComponent(safeTo)}`);
      return;
    }
    const failure = toProblem(result);
    setProblem(failure);
    sending.current = false;
    setPending(false);
    if (failure.code === 'invalid_credentials') {
      setPassword('');
      requestFocus('password');
    } else {
      requestFocus('alert');
    }
    if ((failure.status === 429 || failure.code === 'rate_limited') && failure.retryAfterSeconds) {
      setWaitMs(failure.retryAfterSeconds * 1000);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-busy={pending}>
      <span role="status" className="sr-only">
        {pending ? SUBMITTING.login : ''}
      </span>
      {problem && <ProblemAlert ref={alertRef} problem={problem} context="login" />}

      <div className="grid gap-2">
        <Label htmlFor="login-email">Email</Label>
        <Input
          ref={emailRef}
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          readOnly={pending}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? 'login-email-error' : undefined}
          className="h-11 sm:h-9"
          onChange={(event) => setEmail(event.target.value)}
        />
        {errors.email && (
          <p id="login-email-error" className="text-sm text-destructive">
            {errors.email}
          </p>
        )}
      </div>

      <div className="grid gap-1">
        <PasswordInput
          ref={passwordRef}
          id="login-password"
          name="password"
          label="Password"
          autoComplete="current-password"
          error={errors.password}
          value={password}
          readOnly={pending}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Link href="/forgot-password" className={`${authLinkClass} justify-self-end text-sm`}>
          Forgot password?
        </Link>
      </div>

      <Button type="submit" size="lg" className="min-h-11 w-full" disabled={pending || waitMs !== null} aria-busy={pending}>
        {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
        Sign in
      </Button>

      {oidcEnabled && <GoogleButton returnTo={safeTo} />}

      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{' '}
        <Link href="/register" className={authLinkClass}>
          Register
        </Link>
      </p>
    </form>
  );
}
