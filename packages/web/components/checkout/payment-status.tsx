'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { orderHref, ordersHref } from '@/lib/routes';
import { BuyAgainButton, type BuyAgainItem } from '@/components/orders/buy-again';
import { withOrdersLink } from './problem-alerts';

/** AS-41: one sentence per failure code of the closed list; any other or missing code gets the last one. */
const FAILURE_SENTENCES: Record<string, string> = {
  card_declined: 'Your card was declined.',
  insufficient_funds: 'Your card has insufficient funds.',
  expired_card: 'Your card has expired.',
  provider_rejected: "Your bank didn't accept this payment.",
  declined_other: "Your bank didn't accept this payment.",
  provider_unavailable: "The payment service had a problem. You weren't charged.",
  provider_canceled: "The payment service had a problem. You weren't charged.",
};
const FAILURE_FALLBACK = "The payment couldn't be completed.";

export const failureSentence = (code: string | null | undefined): string => (code ? (FAILURE_SENTENCES[code] ?? FAILURE_FALLBACK) : FAILURE_FALLBACK);

/** AS-43: the reason sentence of a cancellation, from the order timeline; an unknown reason gives no sentence. */
const CANCEL_SENTENCES: Record<string, string> = {
  out_of_stock: 'Some items sold out.',
  payment_failed: "The payment didn't go through.",
  hold_expired: 'The reservation ended before payment.',
  user_cancelled: 'You cancelled this order.',
};
export const cancelSentence = (reason: string | null | undefined): string | null => (reason ? (CANCEL_SENTENCES[reason] ?? null) : null);

export const REFUND_NOTICE = 'Your payment arrived after the reservation ended. It will be refunded automatically.';
export const SLOW_CONFIRMING_HINT = 'This is taking longer than usual. You can leave this page; your order will appear in Your orders as soon as it is confirmed.';
export const STALLED_TEXT = "This is taking longer than expected. You can leave this page; we'll email you and it will show in Your orders.";

export type StatusPanel =
  | { kind: 'reserving' }
  | { kind: 'processing' }
  | { kind: 'redirecting' }
  | { kind: 'confirming'; slow: boolean }
  | { kind: 'unknown' }
  /** The bank must confirm. `onContinue` reopens the frame here; `continueHref` sends the buyer to the pay step instead. */
  | { kind: 'action'; opening?: boolean; onContinue?: () => void; continueHref?: string }
  | { kind: 'failed'; failureCode: string | null; orderId: string; items: readonly BuyAgainItem[] }
  | { kind: 'expired' }
  | { kind: 'ended'; reason: 'cancelled' | 'refunded'; cause: string | null; paymentArrivedLate: boolean; items: readonly BuyAgainItem[] };

const BOX = 'space-y-3 rounded-xl border bg-card p-4 md:p-6';

/**
 * The pay step's status panel (W03 FR-042, AS-38..AS-46): one live region (`role="status"`) whose heading takes focus when
 * the panel replaces the form. It says what the server reports and nothing more: it never claims an order is confirmed.
 * `stalled` is set when the polling schedule ended: the buyer may leave, or ask again.
 */
export function PaymentStatus({
  panel,
  headingLevel = 2,
  focus,
  stalled,
}: {
  panel: StatusPanel;
  headingLevel?: 1 | 2;
  /** Move focus to the heading when the panel (or its kind) appears. */
  focus: boolean;
  stalled?: { onCheckAgain: () => void };
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus, panel.kind]);

  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const title = (text: string): ReactNode => (
    <Heading ref={heading} id={headingId} tabIndex={-1} className="text-xl font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      {text}
    </Heading>
  );
  const ordersLink = (
    <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
      <Link href={ordersHref()}>Your orders</Link>
    </Button>
  );

  let content: ReactNode;
  switch (panel.kind) {
    case 'reserving':
      content = title('Reserving your items…');
      break;
    case 'processing':
      content = title('Payment is being processed…');
      break;
    case 'redirecting':
      content = title('Payment received. Taking you to your order…');
      break;
    case 'confirming':
      content = (
        <>
          {title('Payment received. Confirming your order…')}
          {panel.slow && <p className="text-sm text-muted-foreground">{SLOW_CONFIRMING_HINT}</p>}
        </>
      );
      break;
    case 'unknown':
      content = (
        <>
          {title('Confirming your payment')}
          <p className="text-sm text-muted-foreground">We&apos;re confirming your payment with your bank. This can take a few minutes. Please don&apos;t pay again.</p>
        </>
      );
      break;
    case 'action':
      content = (
        <>
          {title('Your bank needs you to confirm this payment.')}
          {panel.continueHref ? (
            <Button asChild className="min-h-11 sm:min-h-8">
              <Link href={panel.continueHref}>Continue to payment</Link>
            </Button>
          ) : (
            <Button type="button" className="min-h-11 sm:min-h-8" disabled={panel.opening} aria-busy={panel.opening} onClick={panel.onContinue}>
              Continue verification
            </Button>
          )}
        </>
      );
      break;
    case 'failed':
      content = (
        <>
          {title("Payment didn't go through")}
          <p>{failureSentence(panel.failureCode)}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <BuyAgainButton items={panel.items} />
            <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
              <Link href={orderHref(panel.orderId)}>View order</Link>
            </Button>
          </div>
        </>
      );
      break;
    case 'expired':
      content = (
        <>
          {title('Your reservation has ended')}
          <p className="text-sm text-muted-foreground">We&apos;re checking your order. If it was cancelled, you can buy the items again from Your orders.</p>
        </>
      );
      break;
    case 'ended': {
      const reason = panel.reason === 'cancelled' ? cancelSentence(panel.cause) : null;
      content = (
        <>
          {title(panel.reason === 'cancelled' ? 'This order was cancelled' : 'This order was refunded.')}
          {reason && <p>{reason}</p>}
          {panel.paymentArrivedLate && <p>{REFUND_NOTICE}</p>}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            {panel.reason === 'cancelled' && <BuyAgainButton items={panel.items} />}
            {ordersLink}
          </div>
        </>
      );
      break;
    }
  }

  return (
    <section role="status" aria-labelledby={headingId} className={BOX}>
      {content}
      {stalled && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-sm">{withOrdersLink(STALLED_TEXT)}</p>
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={stalled.onCheckAgain}>
            Check again
          </Button>
        </div>
      )}
    </section>
  );
}
