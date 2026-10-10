import { z } from 'zod';

/**
 * S35 `GET /api/trending` (specs/domains/S35-trending/contracts/trending-api.md). Query strings arrive as strings; unknown
 * keys are rejected (strict); nothing is truncated or clamped.
 */
export const TRENDING_LIMITS = {
  limit: { min: 1, max: 20, default: 20 },
  category: { min: 1, max: 40, default: 'all' },
  windowMinutes: 60,
} as const;

export const TRENDING_CATEGORY_PATTERN = /^[a-z0-9-]{1,40}$/;

export const trendingQuerySchema = z
  .object({
    category: z
      .string()
      .regex(
        TRENDING_CATEGORY_PATTERN,
        'must be 1 to 40 characters of lowercase letters, digits and hyphen',
      )
      .default(TRENDING_LIMITS.category.default),
    limit: z
      .string()
      .regex(/^[0-9]{1,2}$/, 'must be an integer from 1 to 20')
      .transform((s) => Number(s))
      .refine(
        (n) => n >= TRENDING_LIMITS.limit.min && n <= TRENDING_LIMITS.limit.max,
        { message: 'must be an integer from 1 to 20' },
      )
      .default(TRENDING_LIMITS.limit.default),
  })
  .strict();
export type TrendingQuery = z.infer<typeof trendingQuerySchema>;

export const trendingItemSchema = z.object({
  rank: z.number().int().min(1),
  productId: z.string().uuid(),
  title: z.string(),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  category: z.string(),
  score: z.number().int().min(1),
});
export type TrendingItem = z.infer<typeof trendingItemSchema>;

export const trendingResponseSchema = z.object({
  category: z.string(),
  windowMinutes: z.literal(60),
  generatedAt: z.string().datetime(),
  items: z.array(trendingItemSchema),
});
export type TrendingResponse = z.infer<typeof trendingResponseSchema>;

export const TRENDING_PROBLEM_CODES = [
  'validation_failed',
  'rate_limited',
  'trending_unavailable',
] as const;
