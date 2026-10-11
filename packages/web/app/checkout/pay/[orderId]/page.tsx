import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { PaySkeleton } from '@/components/checkout/page-skeletons';
import { PayPanel } from '@/components/checkout/pay-panel';
import { isConfirmed } from '@/lib/checkout/status';
import { queryKeys } from '@/lib/query-keys';
import { payHref, successHref } from '@/lib/routes';
import { readGuardedOrder } from '@/lib/server/guarded-order.server';

export const metadata: Metadata = { title: 'Pay', robots: { index: false, follow: false } };

/**
 * The guard and the first read, inside `<Suspense>` (they read the request's cookies and `params`): a malformed, unknown or
 * foreign order is not found, an anonymous visitor goes to sign-in with `returnTo`, and an order that is already paid goes
 * to the success page (W03 AS-35). The order aggregate is read on the server and handed to the client's query cache, so the
 * pay step needs no second wait. The heading and skeleton are the static shell.
 */
async function GuardedPay({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const page = await readGuardedOrder(orderId, payHref(orderId));
  if (page && isConfirmed(page.order.status)) redirect(successHref(orderId));
  const client = new QueryClient();
  if (page) client.setQueryData(queryKeys.orders.detail(orderId), page);
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <PayPanel orderId={orderId} />
    </HydrationBoundary>
  );
}

export default function PayPage({ params }: { params: Promise<{ orderId: string }> }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
      <Suspense fallback={<PaySkeleton />}>
        <GuardedPay params={params} />
      </Suspense>
    </div>
  );
}
