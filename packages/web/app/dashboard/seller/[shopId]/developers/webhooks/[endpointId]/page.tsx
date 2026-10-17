import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { WebhookDetailView } from '@/components/seller/developers/webhook-detail-view';
import { DetailPageSkeleton } from '@/components/seller/page-skeletons';
import { shopCan } from '@/lib/seller/permissions';
import { readWebhookAttemptsParams, type RawSearchParams } from '@/lib/seller/search-params';
import { readShop, readWebhook, readWebhookAttempts } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string; endpointId: string }>; searchParams: Promise<RawSearchParams> };

/** One endpoint and its deliveries (W04 US5): `ok`, `event` and `cursor` are the URL state; needs `webhooks.manage` (AS-54). */
async function WebhookPage({ params, searchParams }: Props) {
  const [{ shopId, endpointId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/developers/webhooks/${encodeURIComponent(endpointId)}`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'webhooks.manage')) return <PageAccess shop={shop.data} page="webhooks">{null}</PageAccess>;

  const serverParams = readWebhookAttemptsParams(raw);
  const [endpoint, attempts] = await Promise.all([readWebhook(shopId, endpointId), readWebhookAttempts(shopId, endpointId, serverParams)]);
  if (!endpoint.ok && endpoint.status === 404) notFound();
  return (
    <WebhookDetailView
      shopId={shopId}
      endpointId={endpointId}
      serverParams={serverParams}
      initialEndpoint={endpoint.ok ? endpoint.data : undefined}
      initialAttempts={attempts.ok ? attempts.data : undefined}
    />
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<DetailPageSkeleton />}>
      <WebhookPage {...props} />
    </Suspense>
  );
}
