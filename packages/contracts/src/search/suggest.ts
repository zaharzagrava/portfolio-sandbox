import { z } from 'zod';

/**
 * S33 autocomplete `GET /suggest` (specs/domains/S33-autocomplete/contracts/suggest-api.md). Query strings arrive as
 * strings. `q` is reduced by the backend (trim, NFKC, whitespace, control characters) and the 100-character cap applies
 * to the reduced value, so the service enforces it; the schema only carries a raw guard so an absurd payload is
 * rejected first. Unknown keys are rejected (strict).
 */
export const SUGGEST_LIMITS = {
  q: { max: 100, rawMax: 400 },
  limit: { min: 1, max: 10, default: 8 },
} as const;

export const suggestQuerySchema = z
  .object({
    q: z.string().max(SUGGEST_LIMITS.q.rawMax),
    limit: z
      .string()
      .regex(/^[0-9]{1,2}$/, 'must be an integer from 1 to 10')
      .transform((s) => Number(s))
      .refine(
        (n) => n >= SUGGEST_LIMITS.limit.min && n <= SUGGEST_LIMITS.limit.max,
        { message: 'must be an integer from 1 to 10' },
      )
      .optional(),
  })
  .strict();
export type SuggestQuery = z.infer<typeof suggestQuerySchema>;

/** Clients accept an unknown `source` (a later source is an additive change, V.7). */
export const SUGGESTION_SOURCES = ['query', 'catalog', 'typo'] as const;
export const SUGGEST_DEGRADED_REASONS = [
  'catalog_timeout',
  'catalog_unavailable',
  'typo_fallback_timeout',
  'typo_fallback_unavailable',
  'query_index_unavailable',
] as const;
export type SuggestDegradedReason = (typeof SUGGEST_DEGRADED_REASONS)[number];

export const suggestResponseSchema = z.object({
  prefix: z.string(),
  suggestions: z.array(
    z.object({
      text: z.string().min(1),
      source: z.enum(SUGGESTION_SOURCES),
    }),
  ),
  degraded: z.array(z.enum(SUGGEST_DEGRADED_REASONS)),
});
export type SuggestResponse = z.infer<typeof suggestResponseSchema>;

export const SUGGEST_PROBLEM_CODES = ['validation_failed', 'rate_limited'] as const;
