import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { OrdersView } from '@/components/seller/orders/orders-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { shopCan } from '@/lib/seller/permissions';
import { readOrdersParams, type RawSearchParams } from '@/lib/seller/search-params';
import { readShop, readShopOrders } from '@/lib/server/seller.server';

export const metadata: Metadata = { title: 'Orders' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/**
 * The shop's order slices (W04 US8, AS-83): session first with the full address as `returnTo` (AS-84), `orders.read`
 * decides between the page and the forbidden panel, and the first read seeds the client query. A failed read is not an
 * error page: the view asks again and shows the problem with "Try again".
 */
async function OrdersPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/orders`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'orders.read')) return <PageAccess shop={shop.data} page="orders">{null}</PageAccess>;

  const serverParams = readOrdersParams(raw);
  const first = await readShopOrders(shopId, serverParams);
  return <OrdersView shopId={shopId} serverParams={serverParams} initialData={first.ok ? first.data : undefined} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton action={false} selectOnly />}>
      <OrdersPage {...props} />
    </Suspense>
  );
}
