import type { Metadata } from 'next';
import { Suspense } from 'react';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { SuccessSkeleton } from '@/components/checkout/page-skeletons';
import { SuccessView } from '@/components/checkout/success-view';
import { queryKeys } from '@/lib/query-keys';
import { successHref } from '@/lib/routes';
import { readGuardedOrder } from '@/lib/server/guarded-order.server';

export const metadata: Metadata = { title: 'Your order', robots: { index: false, follow: false } };

/**
 * The guard and the first read, inside `<Suspense>` (W03 AS-50): a malformed, unknown or foreign order is not found and an
 * anonymous visitor goes to sign-in with `returnTo`. Unlike the pay page there is no redirect on the order's status: this
 * page tells the truth for every state (confirmed only for a paid order, AS-48, AS-49). The order is handed to the client's
 * query cache so the view needs no second wait.
 */
async function GuardedSuccess({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const page = await readGuardedOrder(orderId, successHref(orderId));
  const client = new QueryClient();
  if (page) client.setQueryData(queryKeys.orders.detail(orderId), page);
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <SuccessView orderId={orderId} />
    </HydrationBoundary>
  );
}

export default function SuccessPage({ params }: { params: Promise<{ orderId: string }> }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-6">
      <Suspense fallback={<SuccessSkeleton />}>
        <GuardedSuccess params={params} />
      </Suspense>
    </div>
  );
}
