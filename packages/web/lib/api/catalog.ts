/**
 * The product shape the cart (W03) still reads: `GET /api/products/:id` mapped to cents under `price`. The storefront
 * (W02) does not use it: search, suggestions, rails and the product page parse their own contract schemas
 * (`lib/api/search.ts`, `suggest.ts`, `lib/server/*.server.ts`).
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
