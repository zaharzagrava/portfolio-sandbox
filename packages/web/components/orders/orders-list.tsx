'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { problemFromError } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { useOrdersPage } from '@/lib/api/orders';
import { queryKeys } from '@/lib/query-keys';
import { ordersHref, searchHref } from '@/lib/routes';
import { OrderLive, useOrderLive, useRefresh } from './order-live';
import { OrderRow } from './order-row';

const FRAME = 'mx-auto max-w-5xl px-4 py-8 md:px-6';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className={FRAME}>
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Your orders</h1>
      {children}
    </div>
  );
}

/** Skeleton rows announced once as "Loading your orders" (W03 AS-52). Server-renderable for `loading.tsx`. */
export function OrdersSkeleton() {
  return (
    <Frame>
      <div role="status">
        <span className="sr-only">Loading your orders</span>
        <div aria-hidden="true" className="space-y-3">
          {['a', 'b', 'c'].map((key) => (
            <Skeleton key={key} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      </div>
    </Frame>
  );
}

/**
 * The member's order history, one keyset page (W03 US5, AS-51..AS-53, AS-58). The cursor comes from the URL and nothing
 * else about paging is kept in state. The page is refreshed by the shared user stream.
 */
export function OrdersList({ cursor }: { cursor?: string }) {
  const orders = useOrdersPage(cursor);
  const refresh = useRefresh(queryKeys.orders.list({ cursor }));
  const shown = orders.data?.items;
  const isShown = useCallback((orderId: string) => Boolean(shown?.some((order) => order.id === orderId)), [shown]);
  const message = useOrderLive({ isShown, refresh });

  if (orders.isPending) return <OrdersSkeleton />;

  if (!orders.data) {
    const problem = problemFromError(orders.error);
    const copy = problemCopy('orders', problem, { operation: 'read' });
    const gone = problem.code === 'invalid_cursor';
    const text = gone || problem.status === 429 ? copy.text : "We couldn't load your orders.";
    return (
      <Frame>
        <div role="alert" className="space-y-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          <p>{text}</p>
          {!gone && copy.reference && <p className="text-xs">{copy.reference}</p>}
          <div className="flex flex-wrap gap-2">
            {gone ? (
              <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-7">
                <Link href={ordersHref()}>Newest orders</Link>
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" onClick={() => void orders.refetch()}>
                Try again
              </Button>
            )}
          </div>
        </div>
      </Frame>
    );
  }

  const { items, nextCursor } = orders.data;
  return (
    <Frame>
      <OrderLive message={message} />
      {items.length === 0 ? (
        <div className="space-y-4 rounded-xl border p-6 text-center">
          <p>You haven&apos;t placed any orders yet.</p>
          <Button asChild>
            <Link href={searchHref({})}>Browse products</Link>
          </Button>
        </div>
      ) : (
        <table className="w-full text-sm max-md:block">
          <caption className="sr-only">Your orders</caption>
          <thead className="max-md:sr-only">
            <tr className="border-b text-left">
              <th scope="col" className="px-3 py-2 font-medium">Order</th>
              <th scope="col" className="px-3 py-2 font-medium">Date</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="max-md:block">
            {items.map((order) => (
              <OrderRow key={order.id} order={order} />
            ))}
          </tbody>
        </table>
      )}
      {(nextCursor || cursor) && (
        <nav aria-label="Pages of orders" className="mt-6 flex flex-wrap gap-3">
          {nextCursor && (
            <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
              <Link href={ordersHref(nextCursor)}>Older orders</Link>
            </Button>
          )}
          {cursor && (
            <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
              <Link href={ordersHref()}>Newest orders</Link>
            </Button>
          )}
        </nav>
      )}
    </Frame>
  );
}
