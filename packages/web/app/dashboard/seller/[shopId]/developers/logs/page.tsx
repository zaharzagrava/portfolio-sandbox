import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { RequestLogsView } from '@/components/seller/developers/request-logs-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { shopCan } from '@/lib/seller/permissions';
import { readLogsParams, type RawSearchParams } from '@/lib/seller/search-params';
import { readRequestLogs, readShop } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/** The request log of a shop (W04 US6): the filters in the URL are read here and the first page seeds the client query. */
async function LogsPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/developers/logs`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'shop.read')) return <PageAccess shop={shop.data} page="logs">{null}</PageAccess>;

  const serverParams = readLogsParams(raw);
  const first = await readRequestLogs(shopId, serverParams);
  return <RequestLogsView shopId={shopId} serverParams={serverParams} initialData={first.ok ? first.data : undefined} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton />}>
      <LogsPage {...props} />
    </Suspense>
  );
}
