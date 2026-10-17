import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { IntegrationDetailView } from '@/components/seller/integrations/integration-detail-view';
import { DetailPageSkeleton } from '@/components/seller/page-skeletons';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { isUuid } from '@/lib/server/member-read.server';
import { readShop } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string; integrationId: string }>; searchParams: Promise<RawSearchParams> };

/** One integration with its quarantine, stock conflicts and reconciliations (`?tab=`); a path id that is not a UUID is never sent. */
async function IntegrationPage({ params, searchParams }: Props) {
  const [{ shopId, integrationId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/integrations/${encodeURIComponent(integrationId)}`, raw);
  if (!isUuid(integrationId)) notFound();
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  return (
    <PageAccess shop={shop.data} page="integrations">
      <IntegrationDetailView shopId={shopId} integrationId={integrationId} />
    </PageAccess>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<DetailPageSkeleton />}>
      <IntegrationPage {...props} />
    </Suspense>
  );
}
