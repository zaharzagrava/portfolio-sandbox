import { normaliseQuery } from './query-text';

export type SuggestionSource = 'query' | 'catalog' | 'typo';
export interface BlendedSuggestion {
  text: string;
  source: SuggestionSource;
}

/** Share of the slots popular queries get first; the catalog never takes more than `CATALOG_CAP`. */
const QUERY_SHARE = 0.6;
export const CATALOG_CAP = 5;
export const TYPO_CAP = 5;

const key = (text: string): string => normaliseQuery(text).toLowerCase();

/**
 * The answer of `/suggest` from what each source returned (FR-007, FR-013): de-duplicates on normalised text (the first
 * occurrence wins, queries before catalog), gives `⌈0.6 × limit⌉` slots to queries and at most five to the catalog, hands
 * unused slots to the other source, and uses typo completions only when the other two returned nothing.
 */
export function blendSuggestions(input: {
  limit: number;
  queries: string[];
  catalog: string[];
  typo?: string[];
}): BlendedSuggestion[] {
  const seen = new Set<string>();
  const fresh = (texts: string[]): string[] =>
    texts.filter((text) => {
      const k = key(text);
      if (k.length === 0 || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  const queries = fresh(input.queries);
  const catalog = fresh(input.catalog);
  if (queries.length === 0 && catalog.length === 0)
    return fresh(input.typo ?? [])
      .slice(0, Math.min(input.limit, TYPO_CAP))
      .map((text) => ({ text, source: 'typo' as const }));

  const queryGoal = Math.ceil(QUERY_SHARE * input.limit);
  let queryTake = Math.min(queries.length, queryGoal);
  const catalogTake = Math.min(
    catalog.length,
    CATALOG_CAP,
    input.limit - queryTake,
  );
  queryTake = Math.min(queries.length, input.limit - catalogTake);
  return [
    ...queries
      .slice(0, queryTake)
      .map((text) => ({ text, source: 'query' as const })),
    ...catalog
      .slice(0, catalogTake)
      .map((text) => ({ text, source: 'catalog' as const })),
  ];
}
