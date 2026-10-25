import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { WebhooksView } from '@/components/seller/developers/webhooks-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { shopCan } from '@/lib/seller/permissions';
import { readCursor, type RawSearchParams } from '@/lib/seller/search-params';
import { readShop, readWebhooks } from '@/lib/server/seller.server';

export const metadata: Metadata = { title: 'Webhooks' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/** The webhook endpoints of a shop (W04 US5): needs `webhooks.manage` (AS-54); the first page seeds the client query. */
async function WebhooksPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/developers/webhooks`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'webhooks.manage')) return <PageAccess shop={shop.data} page="webhooks">{null}</PageAccess>;

  const serverParams = { cursor: readCursor(raw.cursor) };
  const first = await readWebhooks(shopId, serverParams);
  return <WebhooksView shopId={shopId} serverParams={serverParams} initialData={first.ok ? first.data : undefined} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton filters={false} />}>
      <WebhooksPage {...props} />
    </Suspense>
  );
}
