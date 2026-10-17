import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { UsageView } from '@/components/seller/developers/usage-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { shopCan } from '@/lib/seller/permissions';
import { readUsageParams, type RawSearchParams } from '@/lib/seller/search-params';
import { readShop, readUsage } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/** The API usage of a shop (W04 US6): `days` and `livemode` are the URL state; the report for them seeds the client query. */
async function UsagePage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/developers/usage`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'shop.read')) return <PageAccess shop={shop.data} page="usage">{null}</PageAccess>;

  const serverParams = readUsageParams(raw);
  const report = await readUsage(shopId, serverParams);
  return <UsageView shopId={shopId} serverParams={serverParams} initialData={report.ok ? report.data : undefined} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton filters={false} />}>
      <UsagePage {...props} />
    </Suspense>
  );
}
