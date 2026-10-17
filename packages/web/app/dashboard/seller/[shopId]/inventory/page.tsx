import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { InventoryView } from '@/components/seller/inventory/inventory-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { config } from '@/lib/config';
import { shopCan } from '@/lib/seller/permissions';
import { readInventoryParams, type RawSearchParams } from '@/lib/seller/search-params';
import { readInventoryFirstPage, readShop } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/**
 * The inventory of a shop (W04 US3, FR-025): the session is required first with the full address as `returnTo` (AS-84), the
 * member's `products.read` decides between the page and the forbidden panel (AS-54), and the first page of the list for the
 * URL's filters seeds the client query. A failed first read is not an error page: the view fetches it again and shows the
 * problem with "Try again" (AS-31).
 */
async function InventoryPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/inventory`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'products.read')) return <PageAccess shop={shop.data} page="inventory">{null}</PageAccess>;

  const serverParams = readInventoryParams(raw);
  const first = await readInventoryFirstPage(shopId, serverParams);
  return <InventoryView shopId={shopId} serverParams={serverParams} initialData={first.ok ? first.data : undefined} currency={config.platformCurrency} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton />}>
      <InventoryPage {...props} />
    </Suspense>
  );
}
