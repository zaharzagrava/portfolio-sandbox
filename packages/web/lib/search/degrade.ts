import type { ProductSearchResponse } from '@marketplace-sandbox/contracts';

/**
 * The search API refuses a feature it does not serve yet with `422 unsupported_combination` and the names of the refused
 * parameters (S32 serves facets and meaning search from its second delivery). The page then asks again without that
 * parameter and shows what the shopper still gets: no facet groups (FR-027 renders only what the API gave), and the
 * "Meaning search is unavailable right now. Showing keyword results." notice for `semantic` (AS-21).
 */
export type Degradation = { params: URLSearchParams; semanticRefused: boolean };

const DROPPABLE = ['facets', 'semantic'] as const;

/** `null` when none of the refused parameters can be dropped (the failure is then a real one). */
export function withoutRefused(params: URLSearchParams, refused: readonly string[] | undefined): Degradation | null {
  const names = DROPPABLE.filter((name) => refused?.includes(name) && params.has(name));
  if (names.length === 0) return null;
  const next = new URLSearchParams(params);
  for (const name of names) next.delete(name);
  return { params: next, semanticRefused: names.includes('semantic') };
}

/** The answer to a request that had to drop `semantic`: keyword results, flagged as a degraded meaning search. */
export function asDegradedSemantic(response: ProductSearchResponse): ProductSearchResponse {
  return { ...response, mode: 'lexical', degraded: [...new Set([...response.degraded, 'semantic_unavailable'])] };
}
