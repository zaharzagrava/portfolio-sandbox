'use client';

import { lazy, Suspense, type ReactElement } from 'react';

/**
 * The adapter between the pay form and the card provider (W03 R-07). The page never sees card data: the provider's own
 * frames (or, in a non-production build with the sandbox flag, a test-card picker) report only "complete or not" and an
 * error sentence, and hand back a payment method token when asked.
 */
export type FieldState = { complete: boolean; error?: string };
export type TokenResult = { ok: true; paymentMethodId: string } | { ok: false; error: string };
/** `abandoned`: the buyer closed the bank's frame (or it failed); the page offers Continue verification. */
export type ActionResult = { ok: true } | { ok: false; abandoned: boolean };

export type PaymentFieldsProps = {
  /** Called whenever completeness or the provider's error text changes. */
  onChange: (state: FieldState) => void;
  /** Hands over `tokenize()`, the one way to turn the entered fields into a payment method token. */
  register: (tokenize: () => Promise<TokenResult>) => void;
  /** The id of the element that holds the field error, for `aria-describedby`. */
  describedBy?: string;
};

const SandboxCardPicker = lazy(() => import('./sandbox-card-picker'));
const StripeFields = lazy(() => import('./stripe-fields'));

/** The sandbox picker exists only outside production builds and only with the flag (questions.md [LOCAL]). */
function sandboxOn(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_PAYMENTS_SANDBOX === 'true';
}

function FieldsPlaceholder() {
  return (
    <div role="status" aria-busy="true" className="h-32 animate-pulse rounded-lg bg-muted">
      <span className="sr-only">Loading card fields…</span>
    </div>
  );
}

export function PaymentFields(props: PaymentFieldsProps): ReactElement {
  return <Suspense fallback={<FieldsPlaceholder />}>{sandboxOn() ? <SandboxCardPicker {...props} /> : <StripeFields {...props} />}</Suspense>;
}

/**
 * Opens the bank's confirmation frame for a payment that needs the customer (3-D Secure, AS-40). `clientSecret` is used
 * for this call only: it is not stored, logged or put in a URL by this module.
 */
export async function confirmPaymentAction(clientSecret: string): Promise<ActionResult> {
  if (sandboxOn()) return { ok: true };
  const { confirmWithProvider } = await import('./stripe-fields');
  return confirmWithProvider(clientSecret);
}
