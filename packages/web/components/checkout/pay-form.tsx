'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { PaymentFields, type FieldState, type TokenResult } from './payment-fields';

/**
 * The card form of the pay step (W03 AS-37, AS-38, FR-042). The provider's fields live in `PaymentFields`; this component
 * only knows whether they are complete and what error sentence the provider reported. **Pay** stays disabled until the
 * fields are complete. On submit it asks the provider for a payment method token and hands that token up: no card value
 * ever passes through this file. A provider error is tied to the fields with `aria-describedby`; it becomes an alert only
 * once the buyer has pressed **Pay**.
 */
export function PayForm({
  label,
  pending,
  blocked,
  onPress,
  onToken,
  onTokenFailed,
}: {
  /** The amount on the button, formatted by the caller (`Pay {label}`). */
  label: string;
  /** A payment is being started: the button reads "Paying…" and is disabled. */
  pending: boolean;
  /** Offline, or waiting out a rate limit. */
  blocked: boolean;
  onPress: () => void;
  onToken: (paymentMethodId: string) => void;
  onTokenFailed: () => void;
}) {
  const errorId = useId();
  const [fields, setFields] = useState<FieldState>({ complete: false });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const tokenize = useRef<(() => Promise<TokenResult>) | null>(null);
  /** Set at once on a press, before React re-renders, so a double click or Enter-Enter is one press. */
  const pressed = useRef(false);

  useEffect(() => {
    if (!pending) pressed.current = false;
  }, [pending]);

  const register = useCallback((fn: () => Promise<TokenResult>) => {
    tokenize.current = fn;
  }, []);
  const change = useCallback((state: FieldState) => {
    setFields(state);
    setSubmitError(null);
  }, []);

  const message = submitError ?? fields.error ?? null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pressed.current || pending || blocked || !fields.complete || !tokenize.current) return;
    pressed.current = true;
    setSubmitError(null);
    onPress();
    const result = await tokenize.current();
    if (!result.ok) {
      pressed.current = false;
      setSubmitError(result.error);
      onTokenFailed();
      return;
    }
    onToken(result.paymentMethodId);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
      <div role="group" aria-label="Payment details" aria-describedby={message ? errorId : undefined} className="space-y-2">
        <PaymentFields onChange={change} register={register} describedBy={message ? errorId : undefined} />
        {message && (
          <p id={errorId} role={submitError ? 'alert' : undefined} className="text-sm text-red-700 dark:text-red-300">
            {message}
          </p>
        )}
      </div>
      <Button type="submit" size="lg" className="min-h-11 w-full text-base" disabled={pending || blocked || !fields.complete} aria-busy={pending}>
        {pending ? 'Paying…' : `Pay ${label}`}
      </Button>
    </form>
  );
}
