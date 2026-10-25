import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { DocumentsView } from '@/components/seller/knowledge/documents-view';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { shopCan } from '@/lib/seller/permissions';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { readShop } from '@/lib/server/seller.server';

export const metadata: Metadata = { title: 'Help documents' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/**
 * Knowledge documents and the help-center question box (W04 US10, S47): session first with the full address as `returnTo`
 * (AS-84); `products.read` decides between the page and the forbidden panel. The list is read in the browser, where it is
 * polled while a document is being indexed.
 */
async function KnowledgePage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/knowledge`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'products.read')) return <PageAccess shop={shop.data} page="knowledge">{null}</PageAccess>;
  return <DocumentsView shopId={shopId} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton />}>
      <KnowledgePage {...props} />
    </Suspense>
  );
}
