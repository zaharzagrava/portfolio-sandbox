import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { WidgetView } from '@/components/seller/widget/widget-view';
import { shopCan } from '@/lib/seller/permissions';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { readShop } from '@/lib/server/seller.server';

export const metadata: Metadata = { title: 'Widget' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/**
 * Storefront widget sites of a shop (W04 US10, S44): session first with the full address as `returnTo` (AS-84);
 * `widget.manage` decides between the page and the forbidden panel (every widget route needs it, reads included).
 */
async function WidgetPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/widget`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'widget.manage')) return <PageAccess shop={shop.data} page="widget">{null}</PageAccess>;
  return <WidgetView shopId={shopId} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton filters={false} />}>
      <WidgetPage {...props} />
    </Suspense>
  );
}
