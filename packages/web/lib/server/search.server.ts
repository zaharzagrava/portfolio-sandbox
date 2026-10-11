import 'server-only';
import { cacheLife, cacheTag } from 'next/cache';
import { productSearchResponseSchema, type ProductSearchResponse } from '@marketplace-sandbox/contracts';
import { apiUrl } from '@/lib/server/endpoints.server';
import { readPublic, type ReadResult } from '@/lib/server/read.server';
import { asDegradedSemantic, withoutRefused } from '@/lib/search/degrade';
import { searchRequestParams, type SearchView } from '@/lib/search/search-view';

const FAILED_LIFE = { stale: 30, revalidate: 5, expire: 6 } as const;

/** The first eight products of a browse search: the home rail's fallback (W02 FR-003). Shared, 30 s. */
export async function getCatalogueBrowse(): Promise<ReadResult<ProductSearchResponse>> {
  'use cache';
  cacheTag('catalogue-browse');
  const result = await readPublic(`${apiUrl()}/api/products/search?limit=8`, productSearchResponseSchema);
  cacheLife(result.ok ? { stale: 30, revalidate: 30, expire: 60 } : FAILED_LIFE);
  return result;
}

/** A browse search with facets and one result: the home page's category shortcuts (W02 FR-004). Shared, 60 s. */
export async function getCategoryFacets(): Promise<ReadResult<ProductSearchResponse>> {
  'use cache';
  cacheTag('search-facets');
  const result = await readPublic(`${apiUrl()}/api/products/search?facets=true&limit=1`, productSearchResponseSchema);
  cacheLife(result.ok ? { stale: 60, revalidate: 60, expire: 120 } : FAILED_LIFE);
  return result;
}

/**
 * The first view of `/search` (W02 FR-022): one anonymous read for the address' view, never cached on the server. Returns
 * `null` when the read fails, so the page renders the shell and the browser asks again (and shows the error form).
 */
export async function getSearchFirstView(view: SearchView): Promise<ProductSearchResponse | null> {
  let params = searchRequestParams(view);
  let semanticRefused = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await readPublic(`${apiUrl()}/api/products/search?${params.toString()}`, productSearchResponseSchema, { timeoutMs: 3_000 });
    if (result.ok) return semanticRefused ? asDegradedSemantic(result.data) : result.data;
    // A parameter the API does not serve yet is dropped, as the browser's request does (lib/search/degrade.ts).
    const next = result.code === 'unsupported_combination' ? withoutRefused(params, result.parameters) : null;
    if (!next) return null;
    params = next.params;
    semanticRefused ||= next.semanticRefused;
  }
  return null;
}
