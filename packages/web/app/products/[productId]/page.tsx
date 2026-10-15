import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RefCapture } from '@/components/analytics/ref-capture';
import { ProductSections } from '@/components/product/product-sections';
import { ProductSkeleton } from '@/components/product/product-skeleton';
import { ProductUnavailable } from '@/components/product/product-unavailable';
import { siteUrl } from '@/lib/server/endpoints.server';
import { getProductPage } from '@/lib/server/product-page.server';
import { safeHttpsUrl } from '@/lib/safe-url';

type Props = { params: Promise<{ productId: string }> };

/**
 * Title, description, canonical address and Open Graph data come from the same cached read as the page (W02 FR-053). The
 * root layout's title template adds " · Marketplace". A page that does not exist marks itself `noindex` in its body
 * (`ProductUnavailable`), so the head carries one robots tag.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { productId } = await params;
  const result = await getProductPage(productId);
  if (result.state === 'not-found') return { title: 'Product not found' };
  if (result.state !== 'ok') return { title: 'Product unavailable' };

  const { product, gallery } = result.page;
  const url = `${siteUrl().replace(/\/$/, '')}/products/${product.id}`;
  const description = product.description.slice(0, 160);
  const image = safeHttpsUrl(gallery?.[0]?.urls.feed);
  return {
    title: product.title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', title: product.title, description, url, ...(image ? { images: [image] } : {}) },
  };
}

/** One anonymous, cached read of the aggregate; the page shows what it has, or exactly one full-page state. */
async function ProductContent({ params }: Props) {
  const { productId } = await params;
  const result = await getProductPage(productId);
  switch (result.state) {
    case 'ok':
      return <ProductSections page={result.page} siteUrl={siteUrl()} />;
    case 'unavailable':
      return <ProductUnavailable state="unavailable" requestId={result.requestId} />;
    case 'rate-limited':
      return <ProductUnavailable state="rate-limited" retryAfterSeconds={result.retryAfterSeconds} />;
    case 'offline':
      return <ProductUnavailable state="offline" />;
    default:
      return <ProductUnavailable state="not-found" />;
  }
}

export default function ProductPage(props: Props) {
  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      {/* Reads the address on the client (AS-63); its own boundary keeps the rest of the page static. */}
      <Suspense fallback={null}>
        <RefCapture />
      </Suspense>
      <Suspense fallback={<ProductSkeleton />}>
        <ProductContent {...props} />
      </Suspense>
    </div>
  );
}
