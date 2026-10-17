import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { CardPageSkeleton } from '@/components/seller/page-skeletons';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { readShop } from '@/lib/server/seller.server';
import { StatementsView } from './view';

export const metadata: Metadata = { title: 'Statements' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/** Monthly statements (W04 US10). `payouts.read` decides between the page and the forbidden panel. */
async function StatementsPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/statements`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  return (
    <PageAccess shop={shop.data} page="statements">
      <StatementsView shopId={shopId} />
    </PageAccess>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<CardPageSkeleton />}>
      <StatementsPage {...props} />
    </Suspense>
  );
}
