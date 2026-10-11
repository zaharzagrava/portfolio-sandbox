'use client';

import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { useEffect, useRef } from 'react';
import type { ActionResult, PaymentFieldsProps } from './payment-fields';

const UNAVAILABLE = "Card payments aren't available right now. Try again later.";

let loading: Promise<Stripe | null> | null = null;
/** The provider's script is loaded here, on the pay page only, the first time it is needed. */
function provider(): Promise<Stripe | null> {
  const key = process.env.NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY;
  if (!key) return Promise.resolve(null);
  loading ??= loadStripe(key).catch(() => null);
  return loading;
}

/** Opens the bank's confirmation frame. An error (frame closed, challenge failed) is "abandoned": the buyer may try again. */
export async function confirmWithProvider(clientSecret: string): Promise<ActionResult> {
  const stripe = await provider();
  if (!stripe) return { ok: false, abandoned: true };
  try {
    const result = await stripe.handleNextAction({ clientSecret });
    return result.error ? { ok: false, abandoned: true } : { ok: true };
  } catch {
    return { ok: false, abandoned: true };
  }
}

type Part = 'number' | 'expiry' | 'cvc';

/** What the three hosted card elements have in common (the provider's types are overloaded per element). */
type HostedField = {
  mount: (target: HTMLElement) => void;
  on: (type: 'change', handler: (event: { complete: boolean; error?: { message: string } }) => void) => unknown;
  destroy: () => void;
};

/** The provider's hosted card fields: number, expiry and security code live in the provider's frames. */
export default function StripeFields({ onChange, register, describedBy }: PaymentFieldsProps) {
  const numberRef = useRef<HTMLDivElement>(null);
  const expiryRef = useRef<HTMLDivElement>(null);
  const cvcRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    const mounted: HostedField[] = [];
    const state: Record<Part, { complete: boolean; error?: string }> = { number: { complete: false }, expiry: { complete: false }, cvc: { complete: false } };
    const report = () => {
      const error = state.number.error ?? state.expiry.error ?? state.cvc.error;
      onChange({ complete: state.number.complete && state.expiry.complete && state.cvc.complete, ...(error ? { error } : {}) });
    };

    void provider().then((stripe) => {
      if (disposed) return;
      const number = numberRef.current;
      const expiry = expiryRef.current;
      const cvc = cvcRef.current;
      if (!stripe || !number || !expiry || !cvc) {
        onChange({ complete: false, error: UNAVAILABLE });
        return;
      }
      const elements = stripe.elements();
      const cardNumber = elements.create('cardNumber', { showIcon: true });
      const cardExpiry = elements.create('cardExpiry');
      const cardCvc = elements.create('cardCvc');
      const watch = (part: Part, element: HostedField, target: HTMLDivElement) => {
        element.mount(target);
        element.on('change', (event) => {
          state[part] = { complete: event.complete, ...(event.error ? { error: event.error.message } : {}) };
          report();
        });
        mounted.push(element);
      };
      watch('number', cardNumber, number);
      watch('expiry', cardExpiry, expiry);
      watch('cvc', cardCvc, cvc);
      register(async () => {
        const result = await stripe.createPaymentMethod({ type: 'card', card: cardNumber });
        if (result.error || !result.paymentMethod) return { ok: false, error: result.error?.message ?? 'Check your card details and try again.' };
        return { ok: true, paymentMethodId: result.paymentMethod.id };
      });
    });

    return () => {
      disposed = true;
      for (const element of mounted) element.destroy();
    };
    // Mounted once: the provider owns the fields from here on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const frame = 'min-h-11 rounded-md border bg-background px-3 py-3';
  return (
    <fieldset aria-describedby={describedBy} className="space-y-4 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Card details</legend>
      <div className="space-y-1">
        <p id="card-number-label" className="text-sm">
          Card number
        </p>
        <div ref={numberRef}role="group" aria-labelledby="card-number-label" className={frame} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <p id="card-expiry-label" className="text-sm">
            Expiry date
          </p>
          <div ref={expiryRef}role="group" aria-labelledby="card-expiry-label" className={frame} />
        </div>
        <div className="space-y-1">
          <p id="card-cvc-label" className="text-sm">
            Security code
          </p>
          <div ref={cvcRef}role="group" aria-labelledby="card-cvc-label" className={frame} />
        </div>
      </div>
    </fieldset>
  );
}
