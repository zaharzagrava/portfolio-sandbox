import { z } from 'zod';

/**
 * S32 public product search (specs/domains/S32-product-search/contracts/http-api.md). Query strings arrive as strings:
 * booleans accept only the literals 'true' | 'false' (no '1', 'TRUE', ''), numbers only digit strings (no '1e3', '',
 * ' 5', '+5', '-1', '0x10'). Unknown keys are rejected (strict).
 *
 * `q`: normalisation (trim, NFKC, whitespace collapse, control characters) is NOT done here, the backend does it, and the
 * 100-character cap applies to the normalised value, so the service enforces it. The schema only carries a raw guard of
 * 400 characters so an absurd payload is rejected before normalisation; a `q` that is empty after normalisation is
 * the service's concern (browse mode).
 */
export const SEARCH_LIMITS = {
  q: { max: 100, rawMax: 400 },
  facetText: { max: 100 },
  page: { min: 1, max: 50, default: 20 },
  shopPage: { min: 1, max: 50, default: 25 },
  cursor: { max: 1_000 },
} as const;

/** Digit string only, coerced to a safe integer. */
export const digitsToInt = z
  .string()
  .regex(/^[0-9]{1,15}$/, 'must be a non-negative integer')
  .transform((s) => Number(s));

/** 'true' | 'false' only. */
export const boolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

export const SEARCH_SORTS = [
  'relevance',
  'price-asc',
  'price-desc',
  'newest',
] as const;
export const searchSortSchema = z.enum(SEARCH_SORTS);
export type SearchSort = z.infer<typeof searchSortSchema>;

export const SEARCH_MODES = ['browse', 'lexical', 'semantic'] as const;
export const searchModeSchema = z.enum(SEARCH_MODES);
export type SearchMode = z.infer<typeof searchModeSchema>;

/** Decimal rating 0..5, digits with an optional fraction ('4', '4.5'). */
const ratingString = z
  .string()
  .regex(/^[0-9](\.[0-9]{1,2})?$/, 'must be a number between 0 and 5')
  .transform((s) => Number(s))
  .refine((n) => n >= 0 && n <= 5, { message: 'must be between 0 and 5' });

const facetText = z.string().min(1).max(SEARCH_LIMITS.facetText.max);

export const productSearchQuerySchema = z
  .object({
    q: z.string().max(SEARCH_LIMITS.q.rawMax).optional(),
    category: facetText.optional(),
    brand: facetText.optional(),
    minPriceMinor: digitsToInt.optional(),
    maxPriceMinor: digitsToInt.optional(),
    minRating: ratingString.optional(),
    inStock: boolString.optional(),
    sort: searchSortSchema.optional(),
    facets: boolString.optional(),
    semantic: boolString.optional(),
    limit: digitsToInt
      .refine(
        (n) => n >= SEARCH_LIMITS.page.min && n <= SEARCH_LIMITS.page.max,
        { message: 'must be 1..50' },
      )
      .default(SEARCH_LIMITS.page.default),
    cursor: z.string().min(1).max(SEARCH_LIMITS.cursor.max).optional(),
  })
  .strict();
export type ProductSearchQuery = z.infer<typeof productSearchQuerySchema>;

export const productSearchItemSchema = z
  .object({
    id: z.string().uuid(),
    shopId: z.string().uuid(),
    title: z.string(),
    brand: z.string().nullable(),
    category: z.string(),
    priceMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    rating: z.number(),
    inStock: z.boolean(),
    imageUrl: z.string().nullable(),
    sponsored: z.boolean(),
    position: z.number().int().nonnegative(),
  })
  .strict();
export type ProductSearchItem = z.infer<typeof productSearchItemSchema>;

export const searchFacetBucketSchema = z
  .object({ key: z.string(), count: z.number().int().nonnegative() })
  .strict();

export const PRICE_RANGE_KEYS = [
  'under_25',
  '25_to_50',
  '50_to_100',
  'over_100',
] as const;

export const searchFacetsSchema = z
  .object({
    categories: z.array(searchFacetBucketSchema),
    brands: z.array(searchFacetBucketSchema),
    priceRanges: z.array(
      z
        .object({
          key: z.enum(PRICE_RANGE_KEYS),
          count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    avgRating: z.number().nullable(),
  })
  .strict();
export type SearchFacets = z.infer<typeof searchFacetsSchema>;

export const productSearchResponseSchema = z
  .object({
    searchId: z.string().min(1),
    mode: searchModeSchema,
    items: z.array(productSearchItemSchema),
    total: z
      .object({ value: z.number().int().nonnegative(), exact: z.boolean() })
      .strict(),
    nextCursor: z.string().nullable(),
    facets: searchFacetsSchema.optional(),
    degraded: z.array(z.string()),
  })
  .strict();
export type ProductSearchResponse = z.infer<typeof productSearchResponseSchema>;
