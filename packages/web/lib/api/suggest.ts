import { z } from 'zod';
import { suggestResponseSchema } from '@marketplace-sandbox/contracts';
import { apiClient } from './client';
import { parseBody } from './parse';

export const SUGGESTION_LIMIT = 8;
export const SUGGEST_MAX_LENGTH = 100;

/**
 * `suggestResponseSchema` of the contracts, relaxed in the two places the API may grow: an unknown `source` and unknown
 * `degraded` reasons are accepted (the UI shows neither; W02 FR-012, FR-013).
 */
const lenientSuggestResponseSchema = suggestResponseSchema.extend({
  suggestions: z.array(suggestResponseSchema.shape.suggestions.element.extend({ source: z.string() })),
  degraded: z.array(z.string()),
});

/** `GET /api/suggest?q=<prefix>&limit=8`: the suggestion texts in the order given (W02 FR-011). */
export async function fetchSuggestions(prefix: string, options: { signal?: AbortSignal } = {}): Promise<string[]> {
  const { data } = await apiClient.get('/api/suggest', {
    params: { q: prefix, limit: SUGGESTION_LIMIT },
    signal: options.signal,
    anonymous: true,
  });
  return parseBody(lenientSuggestResponseSchema, data).suggestions.map((suggestion) => suggestion.text);
}
