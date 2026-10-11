import type { ProductCardProps } from '@/components/product-card';

/**
 * Catalog contracts of the core API and their mapping to UI props. The product id doubles as the URL
 * slug (`/products/<id>`): the API has no slug field.
 */

/** GET /api/products/:id */
export interface ProductDetail {
  id: string;
  sellerId: string | null;
  title: string;
  description: string;
  brand: string;
  category: string;
  price: number; // cents
  rating: number;
  tags: string[];
  /** Not exposed by the catalog API any more (only `inStock`). */
  quantity: number | null;
  inStock: boolean;
  viewCount: number;
}

/** GET /api/products/:id as the catalog API serves it (money in minor units, the owning shop, no stock count). */
export function normalizeProduct(raw: Record<string, unknown> & { priceMinor: number }): ProductDetail {
  return { ...raw, price: raw.priceMinor, sellerId: null, quantity: null } as unknown as ProductDetail;
}

/** GET /api/products/search → items[] (S31; money in minor units, `total` carries an exactness flag) */
export interface SearchItem {
  id: string;
  shopId: string;
  title: string;
  brand: string | null;
  category: string;
  priceMinor: number;
  currency: string;
  rating: number;
  inStock: boolean;
  imageUrl: string | null;
  sponsored: boolean;
  position: number;
}

export interface SearchResponse {
  items: SearchItem[];
  total: { value: number; exact: boolean };
  nextCursor?: string | null;
  facets?: { categories?: { key: string; count: number }[]; brands?: { key: string; count: number }[] };
}

/** GET /api/products/:id/recommendations */
export interface Recommendation {
  productId: string;
  title: string;
  price: number;
  score: number;
  hops: 1 | 2;
}

/** GET /api/suggest */
export interface SuggestResponse {
  queries: string[];
  products: string[];
  partial: boolean;
}

export function hitToCard(item: SearchItem): ProductCardProps {
  return {
    id: item.id,
    slug: item.id,
    name: item.title || 'Untitled product',
    shopName: item.brand ?? '',
    price: Number(item.priceMinor ?? 0),
    rating: Number(item.rating ?? 0),
    reviewsCount: 0,
  };
}

export function recommendationToCard(r: Recommendation): ProductCardProps {
  return { id: r.productId, slug: r.productId, name: r.title, shopName: '', price: Number(r.price), rating: 0, reviewsCount: 0 };
}

/** Autocomplete list: popular queries first, then product titles, without duplicates (case-insensitive), capped. */
export function suggestionsFrom(res: Partial<SuggestResponse> | null | undefined, limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...(res?.queries ?? []), ...(res?.products ?? [])]) {
    const key = s.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s.trim());
    if (out.length === limit) break;
  }
  return out;
}

/** Server-side base URL of the core API (Server Components can't use the Next proxy's relative URLs). */
export const serverApiUrl = () => process.env.API_URL ?? 'http://localhost:8000';
