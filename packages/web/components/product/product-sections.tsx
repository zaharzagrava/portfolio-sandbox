import { AskProduct } from '@/components/product/ask-product';
import { Breadcrumb } from '@/components/product/breadcrumb';
import { Gallery } from '@/components/product/gallery';
import { JsonLd } from '@/components/seo/json-ld';
import { ProductDiscussions } from '@/components/product/product-discussions';
import { ProductRails } from '@/components/product/product-rails';
import { ProductSummary } from '@/components/product/product-summary';
import { ProductTabs } from '@/components/product/product-tabs';
import { PurchaseArea } from '@/components/product/purchase-area';
import { SectionBoundary } from '@/components/product/section-boundary';
import { facetLabel } from '@/lib/search/facet-label';
import { searchHref } from '@/lib/routes';
import { productJsonLd } from '@/lib/seo/product-jsonld';
import { safeHttpsUrl } from '@/lib/safe-url';
import type { ProductPage } from '@/lib/product/parse-page';
import Link from 'next/link';

/** The tab bar of this build: tabs whose panel is not built yet (Pickup near me) are not offered. */
const TABS = [
  { id: 'details', label: 'Details' },
  { id: 'ask', label: 'Ask about this product' },
  { id: 'discussions', label: 'Discussions' },
] as const;

function DetailsPanel({ category, brand }: { category: string; brand: string }) {
  return (
    <dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Category</dt>
      <dd>
        <Link href={searchHref({ category })} className="underline-offset-2 hover:underline">
          {facetLabel(category)}
        </Link>
      </dd>
      {brand ? (
        <>
          <dt className="text-muted-foreground">Brand</dt>
          <dd>
            <Link href={searchHref({ brand })} className="underline-offset-2 hover:underline">
              {brand}
            </Link>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * Everything the product page renders from the parsed aggregate (W02 FR-054): the product is always there, every other
 * section is optional and, when missing, leaves its place empty (the gallery shows the placeholder). The purchase area and
 * the tabs never wait for an optional section, and the codes of `errors` never reach the page.
 */
export function ProductSections({ page, siteUrl }: { page: ProductPage; siteUrl: string }) {
  const { product, shop, gallery, recommendations, trending } = page;
  const imageUrl = safeHttpsUrl(gallery?.[0]?.urls.feed);
  return (
    <>
      <JsonLd json={productJsonLd(product, { siteUrl, imageUrl })} />
      <Breadcrumb category={product.category} title={product.title} />

      <div className="mb-12 grid grid-cols-1 gap-10 lg:grid-cols-2">
        <SectionBoundary fallback={<div className="aspect-square w-full rounded-lg bg-muted" data-testid="gallery-placeholder" />}>
          <Gallery items={gallery} title={product.title} />
        </SectionBoundary>
        <ProductSummary product={product} shop={shop}>
          <PurchaseArea
            productId={product.id}
            category={product.category}
            inStock={product.inStock}
            priceMinor={product.priceMinor}
            currency={product.currency}
          />
        </ProductSummary>
      </div>

      <ProductTabs
        tabs={TABS}
        panels={{
          details: <DetailsPanel category={product.category} brand={product.brand} />,
          ask: <AskProduct productId={product.id} />,
          discussions: <ProductDiscussions productId={product.id} />,
        }}
      />

      <SectionBoundary>
        <ProductRails recommendations={recommendations} trending={trending} category={product.category} />
      </SectionBoundary>
    </>
  );
}
