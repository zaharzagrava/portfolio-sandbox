import { z } from 'zod';
import { SEARCH_LIMITS, digitsToInt } from './product-search';

/**
 * S32 shop-scoped product search. `q` is required, 1..100 after the backend's normalisation (see product-search.ts for
 * why the schema only carries the raw guard).
 */
export const shopProductSearchQuerySchema = z
  .object({
    q: z.string().min(1).max(SEARCH_LIMITS.q.rawMax),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    limit: digitsToInt
      .refine(
        (n) => n >= SEARCH_LIMITS.shopPage.min && n <= SEARCH_LIMITS.shopPage.max,
        { message: 'must be 1..50' },
      )
      .default(SEARCH_LIMITS.shopPage.default),
    cursor: z.string().min(1).max(SEARCH_LIMITS.cursor.max).optional(),
  })
  .strict();
export type ShopProductSearchQuery = z.infer<
  typeof shopProductSearchQuerySchema
>;

export const shopProductSearchItemSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    priceMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    quantity: z.number().int(),
    status: z.enum(['ACTIVE', 'ARCHIVED']),
    rank: z.number(),
  })
  .strict();
export type ShopProductSearchItem = z.infer<typeof shopProductSearchItemSchema>;

export const shopProductSearchResponseSchema = z
  .object({
    items: z.array(shopProductSearchItemSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ShopProductSearchResponse = z.infer<
  typeof shopProductSearchResponseSchema
>;
