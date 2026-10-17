import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { CampaignsView } from '@/components/seller/ads/campaigns-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { shopCan } from '@/lib/seller/permissions';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { readShop } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/**
 * Sponsored-listing campaigns of a shop (W04 US10, S36): session first with the full address as `returnTo` (AS-84);
 * `products.read` decides between the page and the forbidden panel. The list is read in the browser so a filter or page
 * change in the address refetches it; the view shows a failed read with "Try again".
 */
async function CampaignsPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/campaigns`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'products.read')) return <PageAccess shop={shop.data} page="campaigns">{null}</PageAccess>;
  return <CampaignsView shopId={shopId} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton />}>
      <CampaignsPage {...props} />
    </Suspense>
  );
}
