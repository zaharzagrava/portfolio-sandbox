import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { ApiKeysView } from '@/components/seller/developers/api-keys-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { config } from '@/lib/config';
import { shopCan } from '@/lib/seller/permissions';
import { readCursor, type RawSearchParams } from '@/lib/seller/search-params';
import { readApiKeys, readShop } from '@/lib/server/seller.server';

export const metadata: Metadata = { title: 'API keys' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/**
 * The API keys of a shop (W04 US4): the session is required first with the full address as `returnTo` (AS-84), the member's
 * `shop.manage` decides between the page and the forbidden panel (AS-54), and the first page of keys seeds the client
 * query. A failed first read is not an error page: the view fetches it again and shows the problem.
 */
async function ApiKeysPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/developers/api-keys`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'shop.manage')) return <PageAccess shop={shop.data} page="api-keys">{null}</PageAccess>;

  const serverParams = { cursor: readCursor(raw.cursor) };
  const first = await readApiKeys(shopId, serverParams);
  return <ApiKeysView shopId={shopId} serverParams={serverParams} initialData={first.ok ? first.data : undefined} apiBaseUrl={config.publicApiBaseUrl} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton filters={false} />}>
      <ApiKeysPage {...props} />
    </Suspense>
  );
}
