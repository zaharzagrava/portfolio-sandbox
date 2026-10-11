import { HttpResponse } from 'msw';
import {
  productSearchResponseSchema,
  recommendationsResponseSchema,
  suggestResponseSchema,
  trendingResponseSchema,
  type ProductSearchResponse,
  type RecommendationsResponse,
  type SuggestResponse,
  type TrendingResponse,
} from '@marketplace-sandbox/contracts';

/**
 * Shared W02 test fixtures. Success bodies are parsed with the contract schema when they are built, so a fixture that
 * drifts from the wire shape fails loudly instead of letting a component test pass against an invented shape.
 */

export const PRODUCT_ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
export const SHOP_ID = '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f';

/** An RFC 9457 problem response (`application/problem+json`) with the stable `code`, `requestId` and optional `Retry-After`. */
export function problemResponse(
  status: number,
  code: string,
  options: { retryAfter?: number; requestId?: string; errors?: { field: string; code: string }[]; title?: string; detail?: string } = {},
): Response {
  return HttpResponse.json(
    {
      type: `https://marketplace.example/problems/${code}`,
      title: options.title ?? 'Server title that the UI must never show',
      status,
      detail: options.detail ?? 'Server detail that the UI must never show',
      instance: '/test',
      code,
      requestId: options.requestId ?? 'req-test-1',
      ...(options.errors ? { errors: options.errors } : {}),
    },
    {
      status,
      headers: {
        'content-type': 'application/problem+json',
        ...(options.retryAfter !== undefined ? { 'retry-after': String(options.retryAfter) } : {}),
      },
    },
  );
}

/** A response without any body (a proxy page or a dropped connection answer). */
export const emptyResponse = (status: number): Response => new HttpResponse(null, { status });

export function searchResponse(overrides: Partial<ProductSearchResponse> = {}): ProductSearchResponse {
  return productSearchResponseSchema.parse({
    searchId: 'search-1',
    mode: 'lexical',
    items: [
      {
        id: PRODUCT_ID,
        shopId: SHOP_ID,
        title: 'iPhone 17',
        brand: 'Apple',
        category: 'phones',
        priceMinor: 89999,
        currency: 'USD',
        rating: 4.5,
        inStock: true,
        imageUrl: null,
        sponsored: false,
        position: 0,
      },
    ],
    total: { value: 1, exact: true },
    nextCursor: null,
    facets: { categories: [{ key: 'phones', count: 1 }], brands: [{ key: 'apple', count: 1 }], priceRanges: [], avgRating: 4.5 },
    degraded: [],
    ...overrides,
  });
}

export function suggestBody(prefix: string, texts: string[] = [], overrides: Partial<SuggestResponse> = {}): SuggestResponse {
  return suggestResponseSchema.parse({
    prefix,
    suggestions: texts.map((text) => ({ text, source: 'query' })),
    degraded: [],
    ...overrides,
  });
}

export function trendingBody(overrides: Partial<TrendingResponse> = {}): TrendingResponse {
  return trendingResponseSchema.parse({
    category: 'all',
    windowMinutes: 60,
    generatedAt: '2026-10-10T12:07:10.000Z',
    items: [
      { rank: 1, productId: PRODUCT_ID, title: 'Headphones B', priceMinor: 1999, currency: 'EUR', category: 'audio', score: 35 },
    ],
    ...overrides,
  });
}

export function recommendationsBody(overrides: Partial<RecommendationsResponse> = {}): RecommendationsResponse {
  return recommendationsResponseSchema.parse({
    type: 'bought-together',
    items: [{ productId: PRODUCT_ID, title: 'Case', priceMinor: 1500, currency: 'USD', score: 0.9, hops: 1 }],
    ...overrides,
  });
}
