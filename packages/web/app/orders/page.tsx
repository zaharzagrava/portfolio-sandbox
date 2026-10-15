import type { Metadata } from 'next';
import { Suspense } from 'react';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { OrdersList, OrdersSkeleton } from '@/components/orders/orders-list';
import { requireServerSession } from '@/lib/auth/session.server';
import { queryKeys } from '@/lib/query-keys';
import { ordersHref } from '@/lib/routes';
import { getOrdersPage } from '@/lib/server/orders.server';

export const metadata: Metadata = { title: 'Your orders', robots: { index: false, follow: false } };

/** The cursor is opaque text from the URL; a repeated or empty parameter is read as the first page's absence. */
const cursorOf = (value: string | string[] | undefined): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  return first ? first : undefined;
};

/**
 * The guard and the first read, inside `<Suspense>` (W03 AS-51, AS-53, FR-052): an anonymous visitor goes to sign-in with
 * `returnTo` (the cursor included); a member's page is read on the server and handed to the client's query cache. A failed
 * read (including a refused cursor) is left out: the browser reads again and shows its own message, so no member data or
 * error text is cached here.
 */
async function GuardedOrders({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  const cursor = cursorOf((await searchParams).cursor);
  await requireServerSession(ordersHref(cursor));
  const read = await getOrdersPage(cursor);
  const client = new QueryClient();
  if (read.ok) client.setQueryData(queryKeys.orders.list({ cursor }), read.data);
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <OrdersList cursor={cursor} />
    </HydrationBoundary>
  );
}

export default function OrdersPage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  return (
    <Suspense fallback={<OrdersSkeleton />}>
      <GuardedOrders searchParams={searchParams} />
    </Suspense>
  );
}
