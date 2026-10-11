'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';
import type { CartPageLine } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { useOnline } from '@/hooks/use-online';
import { useCartPage } from '@/lib/api/cart';
import { problemFromError } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { groupByShop, lineTotalMinor, subtotalsByCurrency, unitCount } from '@/lib/cart/totals';
import { trackCheckoutStep } from '@/lib/checkout/events';
import { searchHref } from '@/lib/routes';
import { CheckoutProgress } from './progress';
import { OrderLines, OrderTotals, type SummaryGroup } from './order-summary';
import { PlaceOrderButton, usePlaceOrder } from './place-order';
import { ProblemAlerts, withOrdersLink, type AlertProduct } from './problem-alerts';

export const REVIEW_NOTE = 'Placing the order holds your items for 15 minutes while you pay.';

function summaryGroups(lines: readonly CartPageLine[], outOfStock: ReadonlySet<string>): SummaryGroup[] {
  return groupByShop(lines).map((group) => ({
    id: group.shopId ?? 'other',
    name: group.name,
    lines: group.lines.map((line) => {
      const total = lineTotalMinor(line);
      return {
        id: line.productId,
        title: line.product ? line.product.title : 'Unavailable product',
        quantity: line.quantity,
        lineTotal: line.product && total !== null ? { amountMinor: total, currency: line.product.currency } : null,
        ...(!line.product ? { note: 'No longer available' } : !line.product.inStock || outOfStock.has(line.productId) ? { note: 'Out of stock' } : {}),
      };
    }),
  }));
}

function Heading() {
  return <h1 className="text-2xl font-bold tracking-tight">Checkout</h1>;
}

/**
 * The checkout review (W03 AS-15, AS-16, AS-33, FR-041): progress, the cart lines by shop, the 15-minute note, the
 * estimated total and **Place order**. The cart comes from the aggregate the server page put in the query cache. The
 * layout is one column with a bottom bar on a phone, and two columns with a sticky card from 1024 px.
 */
export function Review() {
  const cart = useCartPage();
  const online = useOnline();
  const lines = useMemo(() => cart.data?.lines ?? [], [cart.data]);
  const totals = useMemo(() => subtotalsByCurrency(lines), [lines]);

  const order = usePlaceOrder({ lines, expectedTotalMinor: totals[0]?.subtotalMinor ?? 0, online });

  // FR-090: one `checkout_step` per view, sent when the cart is first known.
  const reported = useRef(false);
  const items = cart.data ? unitCount(cart.data.lines) : null;
  useEffect(() => {
    if (items === null || reported.current) return;
    reported.current = true;
    trackCheckoutStep({ step: 'review', items });
  }, [items]);

  const products = useMemo(() => {
    const known = new Map<string, AlertProduct>();
    for (const line of lines) if (line.product) known.set(line.productId, { title: line.product.title, unitPriceMinor: line.product.priceMinor, currency: line.product.currency });
    return known;
  }, [lines]);

  const outOfStock = useMemo(() => new Set(order.problem?.code === 'out_of_stock' ? (order.problem.productIds ?? []) : []), [order.problem]);
  const groups = useMemo(() => summaryGroups(lines, outOfStock), [lines, outOfStock]);

  if (cart.isPending) {
    return (
      <div className="space-y-6">
        <Heading />
        <div role="status" aria-busy="true" className="h-40 animate-pulse rounded-xl bg-muted">
          <span className="sr-only">Loading checkout…</span>
        </div>
      </div>
    );
  }

  if (cart.isError && !cart.data) {
    const copy = problemCopy('checkout', problemFromError(cart.error), { operation: 'read' });
    return (
      <div className="space-y-6">
        <Heading />
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          <p>We couldn&apos;t load your cart.</p>
          {copy.reference && <p className="mt-1 text-xs">{copy.reference}</p>}
          <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11 sm:min-h-7" onClick={() => void cart.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (lines.length === 0 || order.cartEmptied) {
    return (
      <div className="space-y-6">
        <Heading />
        <div className="rounded-xl border px-4 py-12 text-center">
          <p className="text-lg font-medium">Your cart is empty</p>
          {order.cartEmptied && <p className="mt-2 text-sm text-muted-foreground">{withOrdersLink("If you just placed an order, you'll find it in Your orders.")}</p>}
          <Button asChild className="mt-4 min-h-11 sm:min-h-8">
            <Link href={searchHref()}>Browse products</Link>
          </Button>
        </div>
      </div>
    );
  }

  const estimate = totals.map((total) => ({ amountMinor: total.subtotalMinor, currency: total.currency }));

  return (
    <div className="space-y-6 pb-40 lg:pb-0">
      <div className="space-y-3">
        <Heading />
        <CheckoutProgress current="review" />
      </div>

      {!online && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
          You&apos;re offline. Reconnect to place your order.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-4">
          <ProblemAlerts
            problem={order.problem}
            cartProblem={order.cartProblem}
            focusKey={order.problemSeq}
            products={products}
            currency={totals[0]?.currency ?? null}
            blockedSeconds={order.blockedSeconds}
            rateLimitEnded={order.rateLimitEnded}
            removing={order.removing}
            busy={order.disabled}
            onAccept={order.accept}
            onRemove={(ids) => void order.removeUnavailable(ids)}
          />
          <OrderLines groups={groups} />
          <p className="text-sm text-muted-foreground">{REVIEW_NOTE}</p>
        </div>

        <aside className="fixed inset-x-0 bottom-0 z-20 space-y-3 border-t bg-background p-4 shadow-lg lg:sticky lg:top-24 lg:rounded-xl lg:border lg:shadow-none">
          <OrderTotals totals={estimate} />
          <PlaceOrderButton pending={order.pending} disabled={order.disabled} onPress={order.press} />
        </aside>
      </div>
    </div>
  );
}
