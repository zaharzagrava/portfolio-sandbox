import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { ExportView } from '@/components/seller/exports/export-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { readShop } from '@/lib/server/seller.server';

export const metadata: Metadata = { title: 'Order export' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/** Order export (W04 US10, S12). `orders.manage` decides between the page and the forbidden panel. */
async function ExportsPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/exports`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  return (
    <PageAccess shop={shop.data} page="exports">
      <ExportView shopId={shopId} />
    </PageAccess>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton filters={false} />}>
      <ExportsPage {...props} />
    </Suspense>
  );
}
