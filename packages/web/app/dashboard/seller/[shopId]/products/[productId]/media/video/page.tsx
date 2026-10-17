import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { VideoUploadView } from '@/components/seller/media/video-upload-view';
import { DetailPageSkeleton } from '@/components/seller/page-skeletons';
import { isUuid } from '@/lib/server/member-read.server';
import { readShop } from '@/lib/server/seller.server';

type Props = { params: Promise<{ shopId: string; productId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The videos of one product (W04 F6, S30): upload, resume, processing state; needs `products.read`. */
async function VideoPage({ params, searchParams }: Props) {
  const [{ shopId, productId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/products/${encodeURIComponent(productId)}/media/video`, raw);
  if (!isUuid(productId)) notFound();
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  return (
    <PageAccess shop={shop.data} page="inventory">
      <VideoUploadView shopId={shopId} productId={productId} />
    </PageAccess>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<DetailPageSkeleton />}>
      <VideoPage {...props} />
    </Suspense>
  );
}
