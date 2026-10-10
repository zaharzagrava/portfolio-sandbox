import { z } from 'zod';

/**
 * S34 `GET /products/:productId/recommendations` (specs/domains/S34-recommendations/contracts/recommendations-api.md).
 * Query strings arrive as strings; unknown keys are rejected (strict).
 */
export const RECOMMENDATION_LIMITS = {
  limit: { min: 1, max: 20, default: 8 },
} as const;

export const RECOMMENDATION_TYPES = ['bought-together'] as const;

export const recommendationsQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[0-9]{1,2}$/, 'must be an integer from 1 to 20')
      .transform((s) => Number(s))
      .refine(
        (n) =>
          n >= RECOMMENDATION_LIMITS.limit.min &&
          n <= RECOMMENDATION_LIMITS.limit.max,
        { message: 'must be an integer from 1 to 20' },
      )
      .optional(),
    type: z.enum(RECOMMENDATION_TYPES).optional(),
  })
  .strict();
export type RecommendationsQuery = z.infer<typeof recommendationsQuerySchema>;

export const recommendationItemSchema = z.object({
  productId: z.string().uuid(),
  title: z.string(),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  /** Cosine score rounded to 4 decimals. */
  score: z
    .number()
    .gt(0)
    .lte(1)
    .refine((n) => Math.round(n * 1e4) / 1e4 === n, {
      message: 'at most 4 decimals',
    }),
  /** 1: bought together directly; 2: through a neighbour (cold-start expansion). */
  hops: z.union([z.literal(1), z.literal(2)]),
});
export type RecommendationItem = z.infer<typeof recommendationItemSchema>;

export const recommendationsResponseSchema = z.object({
  type: z.literal('bought-together'),
  items: z.array(recommendationItemSchema),
});
export type RecommendationsResponse = z.infer<
  typeof recommendationsResponseSchema
>;

export const RECOMMENDATION_PROBLEM_CODES = [
  'validation_failed',
  'product_not_found',
  'rate_limited',
  'recommendations_unavailable',
] as const;
