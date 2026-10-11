'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authLinkClass } from '@/components/auth/auth-card';
import { CodeInput, normalizeRecoveryCode } from '@/components/auth/code-input';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { useVerifyMfa } from '@/hooks/use-auth-actions';
import type { Problem } from '@/lib/api/errors';
import { SUBMITTING } from '@/lib/auth/copy';
import { loginHref, safeReturnTo } from '@/lib/auth/return-to';

const TIMED_OUT = new Set(['mfa_not_pending', 'invalid_mfa_challenge', 'invalid_token']);
const WRONG_CODE = new Set(['invalid_mfa_code', 'invalid_code']);
type Focus = { target: 'field' | 'alert'; n: number };

/**
 * Second step of sign-in (W01 US6, FR-022). The pending challenge lives in the BFF's HttpOnly cookie, so the form posts
 * only `{code}`. It never submits by itself: the member presses Verify or Enter (AS-37).
 */
export function MfaForm({ returnTo }: { returnTo?: string }) {
  const safeTo = safeReturnTo(returnTo);
  const verifyMfa = useVerifyMfa(safeTo);
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [pending, setPending] = useState(false);
  const [waitMs, setWaitMs] = useState<number | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const sending = useRef(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focus) return;
    (focus.target === 'field' ? fieldRef : alertRef).current?.focus();
  }, [focus]);

  useEffect(() => {
    if (waitMs === null) return;
    const timer = setTimeout(() => setWaitMs(null), waitMs);
    return () => clearTimeout(timer);
  }, [waitMs]);

  const requestFocus = (target: Focus['target']) => setFocus((previous) => ({ target, n: (previous?.n ?? 0) + 1 }));
  const ready = mode === 'totp' ? code.length === 6 : code.trim().length > 0;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || waitMs !== null || !ready) return;
    sending.current = true;
    setPending(true);
    setProblem(null);
    const result = await verifyMfa.mutateAsync(mode === 'totp' ? code : normalizeRecoveryCode(code));
    if (result.ok) return; // signed in: the hook navigates; the form stays locked meanwhile
    const failure: Problem = {
      status: result.status,
      code: result.code,
      errors: [],
      ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      ...(result.requestId ? { requestId: result.requestId } : {}),
    };
    sending.current = false;
    setPending(false);
    setProblem(failure);
    if (failure.code && TIMED_OUT.has(failure.code)) {
      setTimedOut(true);
      requestFocus('alert');
    } else if (failure.code && WRONG_CODE.has(failure.code)) {
      setCode('');
      requestFocus('field');
    } else {
      requestFocus('alert');
      if ((failure.status === 429 || failure.code === 'rate_limited') && failure.retryAfterSeconds) {
        setWaitMs(failure.retryAfterSeconds * 1000);
      }
    }
  }

  function switchMode() {
    setMode((current) => (current === 'totp' ? 'recovery' : 'totp'));
    setCode('');
    setProblem(null);
  }

  if (timedOut && problem) {
    return (
      <div className="grid gap-4">
        <ProblemAlert ref={alertRef} problem={problem} context="mfa-login" />
        <Link href={loginHref(safeTo)} className={`${authLinkClass} justify-self-center`}>
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-busy={pending}>
      <span role="status" className="sr-only">
        {pending ? SUBMITTING.mfa : ''}
      </span>
      {problem && <ProblemAlert ref={alertRef} problem={problem} context="mfa-login" />}
      <p className="text-sm text-muted-foreground">
        {mode === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of the recovery codes you saved when you turned on two-step verification.'}
      </p>
      <CodeInput ref={fieldRef} mode={mode} value={code} onChange={setCode} readOnly={pending} />
      <Button type="submit" size="lg" className="min-h-11 w-full" disabled={pending || waitMs !== null || !ready} aria-busy={pending}>
        {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
        Verify
      </Button>
      <Button type="button" variant="link" className="min-h-11 justify-self-center" onClick={switchMode} disabled={pending}>
        {mode === 'totp' ? 'Use a recovery code instead' : 'Use authenticator code instead'}
      </Button>
      <Link href={loginHref(safeTo)} className={`${authLinkClass} justify-self-center`}>
        Back to sign in
      </Link>
    </form>
  );
}
