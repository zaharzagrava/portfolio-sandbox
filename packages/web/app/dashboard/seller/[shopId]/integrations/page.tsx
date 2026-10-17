import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { IntegrationsView } from '@/components/seller/integrations/integrations-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { readShop } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/**
 * The integrations of a shop (W04 F3, S08): needs `integrations.manage`. The OAuth round trip comes back here with
 * `?connected=` or `?error=`; the guard keeps the whole address as `returnTo`.
 */
async function IntegrationsPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/integrations`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  return (
    <PageAccess shop={shop.data} page="integrations">
      <IntegrationsView shopId={shopId} />
    </PageAccess>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton filters={false} />}>
      <IntegrationsPage {...props} />
    </Suspense>
  );
}
