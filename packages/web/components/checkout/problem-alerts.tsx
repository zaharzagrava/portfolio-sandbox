'use client';

import Link from 'next/link';
import { useEffect, useRef, type ReactNode, type Ref } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import type { Problem } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import type { CheckoutProblem } from '@/lib/checkout/checkout-problem';
import { cartHref, ordersHref } from '@/lib/routes';
import { formatMoney } from '@/lib/utils';

/** What the alerts need to know about a cart line: its title (for `productIds`) and its current unit price (for `price_changed`). */
export type AlertProduct = { title: string; unitPriceMinor: number; currency: string };

const ORDERS_LABEL = 'Your orders';

/** Makes the words "Your orders" in a catalogue sentence a link to the order list; the text content stays the sentence. */
export function withOrdersLink(text: string): ReactNode {
  const at = text.indexOf(ORDERS_LABEL);
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      <Link href={ordersHref()} className="inline-flex min-h-11 items-center font-medium underline sm:min-h-0">
        {ORDERS_LABEL}
      </Link>
      {text.slice(at + ORDERS_LABEL.length)}
    </>
  );
}

function AlertBox({ children, ref, role = 'alert' }: { children: ReactNode; ref?: Ref<HTMLDivElement>; role?: 'alert' | 'status' }) {
  return (
    <div
      ref={ref}
      role={role}
      tabIndex={-1}
      className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100"
    >
      {children}
    </div>
  );
}

const BackToCart = () => (
  <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-7">
    <Link href={cartHref()}>Back to cart</Link>
  </Button>
);

/** The extension fields of these codes are required by their form; without them the generic form is shown (FR-082). */
function hasExtras(problem: CheckoutProblem): boolean {
  switch (problem.code) {
    case 'price_changed':
      return problem.currentTotalMinor !== undefined && problem.lines !== undefined;
    case 'out_of_stock':
    case 'product_unavailable':
      return problem.productIds !== undefined;
    default:
      return true;
  }
}

/**
 * The visible form of every checkout problem (W03 FR-081, AS-22..AS-31), directly above the lines. The alert takes focus
 * whenever `focusKey` changes (a new problem), not on a countdown tick. Text comes from the catalogue by `code`, never from
 * the server's `detail`/`title`.
 */
export function ProblemAlerts({
  problem,
  cartProblem,
  focusKey,
  products,
  currency,
  blockedSeconds,
  rateLimitEnded,
  removing,
  busy,
  onAccept,
  onRemove,
}: {
  problem: CheckoutProblem | null;
  /** A failed write while removing unavailable items (cart surface). */
  cartProblem: Problem | null;
  focusKey: number;
  products: ReadonlyMap<string, AlertProduct>;
  /** The currency of the estimated total, for "New total". */
  currency: string | null;
  blockedSeconds: number | null;
  rateLimitEnded: boolean;
  removing: boolean;
  busy: boolean;
  onAccept: () => void;
  onRemove: (productIds: string[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusKey > 0) ref.current?.focus();
  }, [focusKey]);

  if (cartProblem) return <ProblemAlert ref={ref} problem={cartProblem} surface="cart" />;

  if (!problem) {
    return rateLimitEnded ? (
      <AlertBox role="status">
        <p>You can place your order again.</p>
      </AlertBox>
    ) : null;
  }
  if (problem.code === 'cart_empty') return null; // the page shows the empty state instead (AS-27)

  const titles = (problem.productIds ?? []).flatMap((id) => {
    const title = products.get(id)?.title;
    return title ? [title] : [];
  });

  if (!hasExtras(problem)) return <ProblemAlert ref={ref} problem={{ ...problem, code: undefined }} surface="checkout" copyOptions={{ detail: problem.detail }} />;

  if (problem.status === 429 || problem.code === 'rate_limited') {
    const wait = blockedSeconds ?? problem.retryAfter;
    const copy = problemCopy('checkout', { ...problem, retryAfterSeconds: wait }, {});
    // The countdown is a live region switched off: it is announced when it appears and again by the "can place" status, not each second.
    return (
      <AlertBox ref={ref}>
        <p aria-live="off">{copy.text}</p>
      </AlertBox>
    );
  }

  switch (problem.code) {
    case 'price_changed': {
      const changed = (problem.lines ?? []).flatMap((line) => {
        const known = products.get(line.productId);
        // The API lists every line; the buyer is shown the ones whose unit price differs from what they saw.
        return known && known.unitPriceMinor !== line.unitPriceMinor ? [{ ...line, known }] : [];
      });
      const totalCurrency = changed[0]?.known.currency ?? currency;
      return (
        <AlertBox ref={ref}>
          <p>{problemCopy('checkout', problem, {}).text}</p>
          {changed.length > 0 && (
            <ul className="mt-2 space-y-1">
              {changed.map((line) => (
                <li key={line.productId}>
                  {line.known.title}: was {formatMoney(line.known.unitPriceMinor, line.known.currency)}, now {formatMoney(line.unitPriceMinor, line.known.currency)}
                </li>
              ))}
            </ul>
          )}
          {totalCurrency && problem.currentTotalMinor !== undefined && <p className="mt-2 font-medium">New total: {formatMoney(problem.currentTotalMinor, totalCurrency)}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" className="min-h-11 sm:min-h-7" onClick={onAccept} disabled={busy}>
              Accept new total and place order
            </Button>
            <BackToCart />
          </div>
        </AlertBox>
      );
    }
    case 'out_of_stock':
      return (
        <AlertBox ref={ref}>
          <p>{problemCopy('checkout', problem, { titles }).text}</p>
          <div className="mt-3">
            <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-7">
              <Link href={cartHref()}>Review cart</Link>
            </Button>
          </div>
        </AlertBox>
      );
    case 'product_unavailable':
      return (
        <AlertBox ref={ref}>
          <p>{problemCopy('checkout', problem, { titles }).text}</p>
          <div className="mt-3">
            <Button type="button" size="sm" className="min-h-11 sm:min-h-7" disabled={removing} onClick={() => onRemove(problem.productIds ?? [])}>
              Remove unavailable items
            </Button>
          </div>
        </AlertBox>
      );
    case 'mixed_currency':
      return (
        <AlertBox ref={ref}>
          <p>{problemCopy('checkout', problem, {}).text}</p>
          <div className="mt-3">
            <BackToCart />
          </div>
        </AlertBox>
      );
    case 'idempotency_in_flight':
    case 'checkout_in_progress':
      return (
        <AlertBox ref={ref}>
          <p>{withOrdersLink(problemCopy('checkout', problem, {}).text)}</p>
        </AlertBox>
      );
    default:
      // checkout_unavailable, a network failure, 401, flash-sale codes, key misuse, 400 and every 5xx: the catalogue text
      // (generic with the reference, a 4xx plain detail as a second line) through W01's alert.
      return <ProblemAlert ref={ref} problem={problem} surface="checkout" copyOptions={{ detail: problem.detail }} />;
  }
}
