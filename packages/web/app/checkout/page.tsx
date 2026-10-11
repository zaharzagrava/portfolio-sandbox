import type { Metadata } from 'next';
import { Suspense } from 'react';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { cartPageResponseSchema } from '@marketplace-sandbox/contracts';
import { Review } from '@/components/checkout/review';
import { ReviewSkeleton } from '@/components/checkout/review-skeleton';
import { requireServerSession } from '@/lib/auth/session.server';
import { queryKeys } from '@/lib/query-keys';
import { readAsMember } from '@/lib/server/member-read.server';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false, follow: false } };

/**
 * The guard and the first read, both inside `<Suspense>` (they read the request's cookies): an anonymous visitor is
 * redirected to sign-in with `returnTo=/checkout` before any member content is sent (W03 AS-14, FR-010); a member's cart
 * aggregate is read on the server and handed to the client's query cache, so the review needs no second wait. A failed
 * read is simply left out: the client reads it again and shows its own error with Try again.
 */
async function GuardedReview() {
  await requireServerSession('/checkout');
  const read = await readAsMember('/api/bff/cart', cartPageResponseSchema);
  const client = new QueryClient();
  if (read.ok) client.setQueryData(queryKeys.cart.page(), read.data);
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <Review />
    </HydrationBoundary>
  );
}

export default function CheckoutPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
      <Suspense fallback={<ReviewSkeleton />}>
        <GuardedReview />
      </Suspense>
    </div>
  );
}
