import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { OfflineConflictsView } from '@/components/seller/integrations/offline-conflicts-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { readShop } from '@/lib/server/seller.server';

export const metadata: Metadata = { title: 'Offline conflicts' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/** Offline stock conflicts (S09): read with `products.read`, dismissed with `products.write` (the view hides the button). */
async function OfflineConflictsPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/integrations/offline-conflicts`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  return (
    <PageAccess shop={shop.data} page="inventory">
      <OfflineConflictsView shopId={shopId} />
    </PageAccess>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton filters={false} />}>
      <OfflineConflictsPage {...props} />
    </Suspense>
  );
}
