import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { ApiVersionView } from '@/components/seller/developers/api-version-view';
import { CardPageSkeleton } from '@/components/seller/page-skeletons';
import { shopCan } from '@/lib/seller/permissions';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { readApiVersion, readShop } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/** The API version of a shop (W04 US6): needs `shop.manage` (AS-54); the pinned state seeds the client query. */
async function ApiVersionPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/developers/api-version`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'shop.manage')) return <PageAccess shop={shop.data} page="api-version">{null}</PageAccess>;

  const state = await readApiVersion(shopId);
  return <ApiVersionView shopId={shopId} initialData={state.ok ? state.data : undefined} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<CardPageSkeleton />}>
      <ApiVersionPage {...props} />
    </Suspense>
  );
}
