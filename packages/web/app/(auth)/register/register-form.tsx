'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authLinkClass } from '@/components/auth/auth-card';
import { PasswordInput } from '@/components/auth/password-input';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { register } from '@/lib/api/auth';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { COPY, SUBMITTING, fieldErrorMessage } from '@/lib/auth/copy';

type Field = 'email' | 'password' | 'confirm' | 'terms';
type FieldErrors = Partial<Record<Field, string>>;
type Focus = { target: Field | 'alert'; n: number };

const ORDER: Field[] = ['email', 'password', 'confirm', 'terms'];
const MESSAGES = {
  email: 'Enter a valid email address.',
  password: 'Use 12 to 128 characters.',
  confirm: "The passwords don't match.",
  terms: 'Accept the terms to continue.',
} as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create account (W01 US1, FR-020). Plain controlled state (R-07). Sends `{email, password}` only; the confirmation and the
 * terms box are interface-only checks. Every 202 looks the same (no auto-login): the visitor lands on the sign-in notice.
 */
export function RegisterForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null);
  const sending = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const termsRef = useRef<HTMLButtonElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  // Focus moves after the render that shows the error (FR-053).
  useEffect(() => {
    if (!focus) return;
    const target = { email: emailRef, password: passwordRef, confirm: confirmRef, terms: termsRef, alert: alertRef }[focus.target];
    target.current?.focus();
  }, [focus]);

  const requestFocus = (target: Focus['target']) => setFocus((previous) => ({ target, n: (previous?.n ?? 0) + 1 }));
  const firstInvalid = (found: FieldErrors) => ORDER.find((field) => found[field]);

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    if (!EMAIL.test(email.trim())) found.email = MESSAGES.email;
    if (password.length < 12 || password.length > 128) found.password = MESSAGES.password;
    if (confirm !== password) found.confirm = MESSAGES.confirm;
    if (!terms) found.terms = MESSAGES.terms;
    return found;
  }

  function showServerProblem(failure: Problem) {
    const weak = failure.code === 'weak_password' || failure.errors.some((entry) => entry.field === 'password' && entry.code === 'weak_password');
    if (weak) {
      setPassword('');
      setConfirm('');
      setErrors({ password: COPY.weakPassword });
      requestFocus('password');
      return;
    }
    if (failure.code === 'validation_failed' && failure.errors.length > 0) {
      const found: FieldErrors = {};
      let unplaced = false;
      for (const entry of failure.errors) {
        if (entry.field === 'email' || entry.field === 'password') found[entry.field] ??= fieldErrorMessage(entry.field, entry.code);
        else unplaced = true;
      }
      setErrors(found);
      const first = firstInvalid(found);
      if (unplaced) setProblem(failure);
      requestFocus(first ?? 'alert');
      if (first || unplaced) return;
    }
    setProblem(failure);
    requestFocus('alert');
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    const found = validate();
    setErrors(found);
    setProblem(null);
    const first = firstInvalid(found);
    if (first) {
      requestFocus(first);
      return;
    }
    sending.current = true;
    setPending(true);
    try {
      await register({ email: email.trim(), password });
      // Same for a new and an existing address; the form stays locked while the page changes.
      router.replace('/login?notice=registered');
    } catch (error) {
      showServerProblem(problemFromError(error));
      sending.current = false;
      setPending(false);
    }
  }

  const clear = (field: Field) => setErrors((previous) => ({ ...previous, [field]: undefined }));

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4" aria-busy={pending}>
      <span role="status" className="sr-only">
        {pending ? SUBMITTING.register : ''}
      </span>
      {problem && <ProblemAlert ref={alertRef} problem={problem} context="register" />}
      <p className="text-sm text-muted-foreground">All fields are required.</p>

      <div className="grid gap-2">
        <Label htmlFor="register-email">Email</Label>
        <Input
          ref={emailRef}
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          readOnly={pending}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? 'register-email-error' : undefined}
          className="h-11 sm:h-9"
          onChange={(event) => {
            setEmail(event.target.value);
            clear('email');
          }}
        />
        {errors.email && (
          <p id="register-email-error" className="text-sm text-destructive">
            {errors.email}
          </p>
        )}
      </div>

      <PasswordInput
        ref={passwordRef}
        id="register-password"
        name="password"
        label="Password"
        autoComplete="new-password"
        hint="Use 12 to 128 characters."
        error={errors.password}
        value={password}
        readOnly={pending}
        onChange={(event) => {
          setPassword(event.target.value);
          clear('password');
        }}
      />

      <PasswordInput
        ref={confirmRef}
        id="register-confirm"
        name="confirmPassword"
        label="Confirm password"
        autoComplete="new-password"
        error={errors.confirm}
        value={confirm}
        readOnly={pending}
        onChange={(event) => {
          setConfirm(event.target.value);
          clear('confirm');
        }}
      />

      <div className="grid gap-2">
        <div className="flex items-start gap-3">
          <Checkbox
            ref={termsRef}
            id="register-terms"
            checked={terms}
            disabled={pending}
            aria-invalid={errors.terms ? true : undefined}
            aria-describedby={errors.terms ? 'register-terms-error' : undefined}
            onCheckedChange={(checked) => {
              setTerms(checked === true);
              clear('terms');
            }}
          />
          <Label htmlFor="register-terms" className="block text-sm leading-snug font-normal">
            I agree to the{' '}
            <Link href="/terms" className="underline underline-offset-4">
              Terms
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="underline underline-offset-4">
              Privacy Policy
            </Link>
          </Label>
        </div>
        {errors.terms && (
          <p id="register-terms-error" className="text-sm text-destructive">
            {errors.terms}
          </p>
        )}
      </div>

      <Button type="submit" size="lg" className="min-h-11 w-full" disabled={pending} aria-busy={pending}>
        {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
        Create account
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className={authLinkClass}>
          Log in
        </Link>
      </p>
    </form>
  );
}
