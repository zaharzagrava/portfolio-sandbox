import {
  productGallerySchema,
  productPublicSchema,
  recommendationsResponseSchema,
  shopSummarySchema,
  trendingResponseSchema,
  type ProductGalleryItem,
  type ProductPublicView,
  type RecommendationItem,
  type TrendingItem,
} from '@marketplace-sandbox/contracts';

export const TRENDING_RAIL_SIZE = 8;

/** What the product page uses of the BFF aggregate (W02 data-model §4). */
export type ProductPage = {
  product: ProductPublicView;
  shop: { id: string; name: string; slug: string } | null;
  gallery: ProductGalleryItem[] | null;
  recommendations: RecommendationItem[] | null;
  /** Without the product itself, at most eight. */
  trending: TrendingItem[] | null;
  /** The aggregate reported a section error or a section did not parse: do not keep it long. */
  degraded: boolean;
};

/**
 * Parses the aggregate section by section (W02 FR-054): `product` is required (`null` when it does not parse), every
 * other section that is missing or invalid becomes `null` and marks the page degraded. The sections the page does not
 * use are never read.
 */
export function parseProductPage(body: unknown): ProductPage | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const product = productPublicSchema.safeParse(raw.product);
  if (!product.success) return null;

  let degraded = Array.isArray(raw.errors) && raw.errors.length > 0;
  const section = <T>(value: unknown, parse: (input: unknown) => { success: true; data: T } | { success: false }): T | null => {
    if (value === null || value === undefined) return null;
    const result = parse(value);
    if (result.success) return result.data;
    degraded = true;
    return null;
  };

  const shop = section(raw.shop, (v) => shopSummarySchema.safeParse(v));
  const gallery = section(raw.gallery, (v) => productGallerySchema.safeParse(v))?.items ?? null;
  const recommendations = section(raw.recommendations, (v) => recommendationsResponseSchema.safeParse(v))?.items ?? null;
  const trendingAll = section(raw.trending, (v) => trendingResponseSchema.safeParse(v))?.items ?? null;
  const trending = trendingAll?.filter((item) => item.productId !== product.data.id).slice(0, TRENDING_RAIL_SIZE) ?? null;

  return {
    product: product.data,
    shop,
    gallery,
    recommendations: recommendations && recommendations.length > 0 ? recommendations : null,
    trending: trending && trending.length > 0 ? trending : null,
    degraded,
  };
}
