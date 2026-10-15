'use client';

import Link from 'next/link';
import { useCallback, useMemo, useRef } from 'react';
import { OrderTotals } from '@/components/checkout/order-summary';
import { Button } from '@/components/ui/button';
import { problemFromError } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { useOrder, type OrderPageResponse } from '@/lib/api/orders';
import { orderSummaryGroups } from '@/lib/checkout/order-groups';
import { formatPlaced } from '@/lib/orders/format';
import { canBuyAgain, canCancel, canPay, shopOrderStatusText, shortOrderId } from '@/lib/orders/status';
import { queryKeys } from '@/lib/query-keys';
import { payHref, productHref } from '@/lib/routes';
import { formatMoney } from '@/lib/utils';
import { BuyAgainButton } from './buy-again';
import { CancelOrderDialog } from './cancel-order-dialog';
import { OrderDetailSkeleton } from './order-detail-skeleton';
import { OrderLive, useOrderLive, useRefresh } from './order-live';
import { OrderTimeline } from './order-timeline';
import { PaymentPanel } from './payment-panel';
import { StatusBadge } from './status-badge';

const FRAME = 'mx-auto max-w-6xl px-4 py-8 md:px-6';
const CARD = 'space-y-4 rounded-xl border bg-card p-4 md:p-6';

/**
 * One order (W03 US5, AS-55..AS-58): status, timeline, lines by shop with their subtotals, total, payment and the actions
 * that fit the status. It reads the aggregate the server page put in the cache and follows the shared user stream.
 */
export function OrderDetail({ orderId }: { orderId: string }) {
  const order = useOrder(orderId);
  const refresh = useRefresh(queryKeys.orders.detail(orderId));
  const isShown = useCallback((id: string) => id === orderId, [orderId]);
  const message = useOrderLive({ isShown, refresh });

  if (order.isPending) return <OrderDetailSkeleton />;
  if (!order.data) {
    const copy = problemCopy('orders', problemFromError(order.error), { operation: 'read' });
    return (
      <div className={FRAME}>
        <h1 className="mb-6 text-3xl font-bold tracking-tight">Your order</h1>
        <div role="alert" className="space-y-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          <p>We couldn&apos;t load your order.</p>
          {copy.reference && <p className="text-xs">{copy.reference}</p>}
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" onClick={() => void order.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  return <DetailBody page={order.data} message={message} onReload={() => void order.refetch()} />;
}

function DetailBody({ page, message, onReload }: { page: OrderPageResponse; message: string; onReload: () => void }) {
  const { order } = page;
  const short = shortOrderId(order.id);
  const heading = useRef<HTMLHeadingElement>(null);
  const groups = useMemo(() => orderSummaryGroups(order), [order]);
  const shopOrder = (shopId: string) => order.shopOrders.find((entry) => entry.shopId === shopId);
  const items = useMemo(() => order.items.map((item) => ({ productId: item.productId, title: item.title, quantity: item.quantity })), [order.items]);

  return (
    <div className={FRAME}>
      <OrderLive message={message} />
      <header className="mb-6 space-y-2">
        <h1 ref={heading} tabIndex={-1} className="text-3xl font-bold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          Order #{short}
        </h1>
        <p className="text-sm text-muted-foreground">
          Placed <time dateTime={order.createdAt}>{formatPlaced(order.createdAt)}</time>
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <section aria-label="Order status" className={`${CARD} lg:col-start-2 lg:row-start-1 lg:sticky lg:top-4`}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Status</span>
            <StatusBadge status={order.status} />
          </div>
          {(canPay(order.status) || canCancel(order.status) || canBuyAgain(order.status)) && (
            <div className="flex flex-wrap gap-2">
              {canPay(order.status) && (
                <Button asChild className="min-h-11 sm:min-h-8">
                  <Link href={payHref(order.id)}>Pay now</Link>
                </Button>
              )}
              {canCancel(order.status) && <CancelOrderDialog orderId={order.id} returnFocus={() => heading.current} />}
              {canBuyAgain(order.status) && <BuyAgainButton items={items} />}
            </div>
          )}
        </section>

        <div className="lg:col-start-2 lg:row-start-2">
          <OrderTimeline timeline={order.timeline} />
        </div>

        <div className="space-y-6 lg:col-start-1 lg:row-span-3 lg:row-start-1">
          {groups.map((group) => {
            const slice = shopOrder(group.id);
            return (
              <section key={group.id} aria-label={group.name} className="rounded-xl border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                  <h2 className="text-sm font-semibold">{group.name}</h2>
                  {slice && (
                    <p className="text-sm text-muted-foreground">
                      <span>{shopOrderStatusText(slice.status)}</span> · <span className="tabular-nums">{formatMoney(slice.subtotalMinor, order.currency)}</span>
                    </p>
                  )}
                </div>
                <ul className="divide-y">
                  {group.lines.map((line) => (
                    <li key={line.id} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
                      <div className="min-w-0">
                        <Link href={productHref(line.id)} className="break-words font-medium underline-offset-4 hover:underline">
                          {line.title}
                        </Link>
                        <p className="text-muted-foreground">Quantity {line.quantity}</p>
                      </div>
                      <p className="shrink-0 font-medium tabular-nums">{formatMoney(line.lineTotal.amountMinor, line.lineTotal.currency)}</p>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>

        <div className={`${CARD} lg:col-start-2 lg:row-start-3`}>
          <OrderTotals totals={[{ amountMinor: order.totalMinor, currency: order.currency }]} label="Total" />
          <PaymentPanel page={page} onReload={onReload} />
        </div>
      </div>
    </div>
  );
}
