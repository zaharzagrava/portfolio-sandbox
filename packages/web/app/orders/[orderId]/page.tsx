import type { Metadata } from 'next';
import { Suspense } from 'react';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { OrderDetail } from '@/components/orders/order-detail';
import { OrderDetailSkeleton } from '@/components/orders/order-detail-skeleton';
import { queryKeys } from '@/lib/query-keys';
import { orderHref } from '@/lib/routes';
import { readGuardedOrder } from '@/lib/server/guarded-order.server';

export const metadata: Metadata = { title: 'Your order', robots: { index: false, follow: false } };

/**
 * The guard and the first read, inside `<Suspense>` (W03 AS-57, AS-60): a malformed, unknown or foreign order is not found
 * and an anonymous visitor goes to sign-in with `returnTo=/orders/{id}` (the link of a notification lands here). The order
 * is handed to the client's query cache; a failed read is left out and the browser reads it again with its own error.
 */
async function GuardedDetail({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const page = await readGuardedOrder(orderId, orderHref(orderId));
  const client = new QueryClient();
  if (page) client.setQueryData(queryKeys.orders.detail(orderId), page);
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <OrderDetail orderId={orderId} />
    </HydrationBoundary>
  );
}

export default function OrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  return (
    <Suspense fallback={<OrderDetailSkeleton />}>
      <GuardedDetail params={params} />
    </Suspense>
  );
}
