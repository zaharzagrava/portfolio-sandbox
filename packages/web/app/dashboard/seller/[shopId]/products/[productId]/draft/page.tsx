import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { DraftLauncher } from '@/components/seller/editor/draft-launcher';
import { DetailPageSkeleton } from '@/components/seller/page-skeletons';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { isUuid } from '@/lib/server/member-read.server';
import { readShop } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string; productId: string }>; searchParams: Promise<RawSearchParams> };

/**
 * The collaborative editor of a product (W04 F1, S06): reading a draft needs `products.read` (the same permission as the
 * inventory); starting, editing and publishing need `products.write`, which the editor checks and the API decides.
 */
async function DraftPage({ params, searchParams }: Props) {
  const [{ shopId, productId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/products/${encodeURIComponent(productId)}/draft`, raw);
  if (!isUuid(productId)) notFound();
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  return (
    <PageAccess shop={shop.data} page="inventory">
      <DraftLauncher shopId={shopId} productId={productId} />
    </PageAccess>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<DetailPageSkeleton />}>
      <DraftPage {...props} />
    </Suspense>
  );
}
