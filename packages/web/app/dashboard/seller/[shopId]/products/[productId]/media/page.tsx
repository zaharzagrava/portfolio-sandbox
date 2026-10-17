import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { GalleryView } from '@/components/seller/media/gallery-view';
import { DetailPageSkeleton } from '@/components/seller/page-skeletons';
import { isUuid } from '@/lib/server/member-read.server';
import { readShop } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string; productId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The photos of one product (W04 F6, S29): the gallery needs `products.read` (the same permission as the inventory). */
async function PhotosPage({ params, searchParams }: Props) {
  const [{ shopId, productId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/products/${encodeURIComponent(productId)}/media`, raw);
  if (!isUuid(productId)) notFound();
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  return (
    <PageAccess shop={shop.data} page="inventory">
      <GalleryView shopId={shopId} productId={productId} />
    </PageAccess>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<DetailPageSkeleton />}>
      <PhotosPage {...props} />
    </Suspense>
  );
}
