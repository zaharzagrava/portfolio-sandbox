import {
  recommendationsResponseSchema,
  trendingResponseSchema,
} from '@marketplace-sandbox/contracts';
import { Endpoint, enc } from './endpoint';

/** S34 `GET /api/products/:id/recommendations?limit=`: the envelope is forwarded unchanged. */
export const recommendations = (
  productId: string,
  limit = 8,
): Endpoint<ReturnType<typeof recommendationsResponseSchema.parse>> => ({
  name: 'recommendations',
  upstream: 'recommendations',
  method: 'GET',
  path: `/api/products/${enc(productId)}/recommendations`,
  query: { limit: String(limit) },
  schema: recommendationsResponseSchema,
  identity: 'none',
  sharedCache: true,
  breaker: true,
});

/** S35 `GET /api/trending?category=`. */
export const trending = (
  category: string,
): Endpoint<ReturnType<typeof trendingResponseSchema.parse>> => ({
  name: 'trending',
  upstream: 'trending',
  method: 'GET',
  path: '/api/trending',
  query: { category },
  schema: trendingResponseSchema,
  identity: 'none',
  sharedCache: true,
  breaker: true,
});
