import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { ImportView } from '@/components/seller/imports/import-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { readShop } from '@/lib/server/seller.server';

export const metadata: Metadata = { title: 'Import products' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/** Bulk catalog import (W04 US10, S07). `products.write` decides between the page and the forbidden panel. */
async function ImportsPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/imports`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  return (
    <PageAccess shop={shop.data} page="imports">
      <ImportView shopId={shopId} />
    </PageAccess>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton filters={false} />}>
      <ImportsPage {...props} />
    </Suspense>
  );
}
