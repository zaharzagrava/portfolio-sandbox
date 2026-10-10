import { cacheKey } from '@app/infrastructure/cache';

/** Entry of the public product detail (`product:v2:<id>`): shared by the API (reads), the writers and the projector. */
export const productCacheKey = (id: string) => cacheKey('product', 2, id);

export const PRODUCT_VIEWS_COUNTER = 'product-views';
