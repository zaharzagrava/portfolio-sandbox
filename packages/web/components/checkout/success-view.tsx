'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CONFIRMING_HINT_MS } from '@/hooks/use-pay-flow';
import { useStreamFallback, useUserEvents } from '@/hooks/use-user-stream';
import { problemFromError } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { useOrder, type OrderPageResponse } from '@/lib/api/orders';
import { trackCheckoutStep } from '@/lib/checkout/events';
import { orderSummaryGroups, orderUnitCount } from '@/lib/checkout/order-groups';
import { serverView } from '@/lib/checkout/pay-flow';
import { isConfirmed } from '@/lib/checkout/status';
import { queryKeys } from '@/lib/query-keys';
import { orderHref, payHref, searchHref } from '@/lib/routes';
import { SuccessSkeleton } from './page-skeletons';
import { OrderLines, OrderTotals } from './order-summary';
import { PaymentStatus, type StatusPanel } from './payment-status';
import { StreamBanner } from './stream-banner';

/** The first 8 characters of the order id, upper-case: a display label only; links always use the full id (spec Assumptions). */
const shortId = (orderId: string): string => orderId.slice(0, 8).toUpperCase();

/**
 * The page after payment (W03 US4, AS-48..AS-50). It says "Order confirmed" only when `isConfirmed(order.status)` says so,
 * the one decision point of the app (SC-003). Every other state says what is true: not paid yet, payment on its way,
 * cancelled or refunded. The order is read from the query cache the server page filled, and follows the live stream (with
 * the polling fallback) so a payment that is still settling turns into the confirmation by itself.
 */
export function SuccessView({ orderId }: { orderId: string }) {
  const order = useOrder(orderId);

  if (order.isPending) return <SuccessSkeleton />;
  if (!order.data) {
    const copy = problemCopy('pay', problemFromError(order.error), { operation: 'read' });
    return (
      <div className="mx-auto max-w-xl space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Your order</h1>
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          <p>We couldn&apos;t load your order.</p>
          {copy.reference && <p className="mt-1 text-xs">{copy.reference}</p>}
          <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11 sm:min-h-7" onClick={() => void order.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  return <SuccessBody orderId={orderId} page={order.data} />;
}

type Kind = 'confirmed' | 'unpaid' | 'panel';

function SuccessBody({ orderId, page }: { orderId: string; page: OrderPageResponse }) {
  const queryClient = useQueryClient();
  const { order } = page;
  const confirmed = isConfirmed(order.status);
  const view = serverView({
    payment: page.payment ? { status: page.payment.status, requiresAction: page.payment.requiresAction } : null,
    orderStatus: order.status,
  });
  const phase = view.kind === 'phase' ? view.phase : null;

  // --- live status -------------------------------------------------------------------------------------------------------
  const refetch = useCallback(() => queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) }), [queryClient, orderId]);
  useUserEvents({
    onEvent: (event) => {
      if ((event.type === 'order.status' || event.type === 'payment.status') && event.data.orderId === orderId) void refetch();
    },
    onResync: () => void refetch(),
  });
  const waiting = !confirmed && view.kind === 'phase' && (order.status === 'PENDING' || phase === 'processing' || phase === 'confirming' || phase === 'unknown' || phase === 'actionRequired');
  const fallback = useStreamFallback(refetch, waiting);

  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (confirmed || phase !== 'confirming') return;
    const timer = setTimeout(() => setSlow(true), CONFIRMING_HINT_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [confirmed, phase]);

  // --- what is true ------------------------------------------------------------------------------------------------------
  const items = useMemo(() => order.items.map((item) => ({ productId: item.productId, title: item.title, quantity: item.quantity })), [order.items]);
  let kind: Kind = 'panel';
  let panel: StatusPanel | null = null;
  if (confirmed) {
    kind = 'confirmed';
  } else if (view.kind === 'order-ended') {
    const cause = [...order.timeline].reverse().find((entry) => entry.status === 'CANCELLED')?.reason ?? null;
    panel = { kind: 'ended', reason: view.reason, cause, paymentArrivedLate: view.paymentArrivedLate, items };
  } else if (order.status === 'PENDING') {
    panel = { kind: 'reserving' };
  } else if (phase === 'processing') {
    panel = { kind: 'processing' };
  } else if (phase === 'confirming' || phase === 'completed') {
    panel = { kind: 'confirming', slow };
  } else if (phase === 'unknown') {
    panel = { kind: 'unknown' };
  } else if (phase === 'actionRequired') {
    panel = { kind: 'action', continueHref: payHref(orderId) };
  } else if (phase === 'failed') {
    panel = { kind: 'failed', failureCode: page.payment?.failureCode ?? null, orderId, items };
  } else {
    kind = 'unpaid';
  }

  // --- focus and analytics -----------------------------------------------------------------------------------------------
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (kind !== 'panel') heading.current?.focus();
  }, [kind]);

  const units = orderUnitCount(order);
  const reported = useRef(false);
  useEffect(() => {
    if (!confirmed || reported.current) return;
    reported.current = true;
    trackCheckoutStep({ step: 'success', items: units, orderId });
  }, [confirmed, units, orderId]);

  const headingClass = 'text-3xl font-bold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <StreamBanner />

      {kind === 'confirmed' && (
        <>
          <div className="space-y-3 text-center">
            <CheckCircle2 aria-hidden="true" className="mx-auto h-14 w-14 text-green-600" />
            <h1 ref={heading} tabIndex={-1} className={headingClass}>
              Order confirmed
            </h1>
            <p className="text-lg font-medium">Order #{shortId(order.id)}</p>
            <p className="text-muted-foreground">{units === 1 ? '1 item' : `${units} items`}</p>
          </div>
          <OrderLines groups={orderSummaryGroups(order)} />
          <OrderTotals totals={[{ amountMinor: order.totalMinor, currency: order.currency }]} label="Total" />
          <p className="text-center text-muted-foreground">We&apos;ll email you a confirmation.</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button asChild size="lg" className="min-h-11 w-full sm:w-auto">
              <Link href={orderHref(order.id)}>View order</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="min-h-11 w-full sm:w-auto">
              <Link href={searchHref({})}>Continue shopping</Link>
            </Button>
          </div>
        </>
      )}

      {kind === 'unpaid' && (
        <div className="space-y-4 text-center">
          <h1 ref={heading} tabIndex={-1} className={headingClass}>
            You haven&apos;t paid for this order yet.
          </h1>
          <Button asChild size="lg" className="min-h-11 w-full sm:w-auto">
            <Link href={payHref(orderId)}>Continue to payment</Link>
          </Button>
        </div>
      )}

      {panel && <PaymentStatus panel={panel} headingLevel={1} focus stalled={fallback.state === 'stopped' && waiting ? { onCheckAgain: fallback.checkAgain } : undefined} />}
    </div>
  );
}
