/** Shared between the API (reads), the projector (invalidation) and the worker (view flush). */
export const productCacheKey = (id: string) => `product:v1:${id}`;

export const PRODUCT_VIEWS_COUNTER = 'product-views';

export interface ProductDetailDto {
  id: string;
  sellerId: string | null;
  title: string;
  description: string;
  brand: string;
  category: string;
  price: number;
  rating: number;
  tags: string[];
  quantity: number;
  inStock: boolean;
  version: number;
  viewCount: number;
}
