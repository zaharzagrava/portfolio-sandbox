import {
  productSearchResponseSchema,
  searchClickRequestSchema,
  type ProductSearchResponse,
  type SearchClickRequest,
} from '@marketplace-sandbox/contracts';
import { asDegradedSemantic, withoutRefused } from '@/lib/search/degrade';
import { searchRequestParams, type SearchView } from '@/lib/search/search-view';
import { apiClient } from './client';
import { csrfHeaders } from './csrf';
import { parseBody } from './parse';

export type { ProductSearchResponse };

async function get(params: URLSearchParams, signal: AbortSignal | undefined): Promise<ProductSearchResponse> {
  const { data } = await apiClient.get('/api/products/search', { params, signal, anonymous: true });
  return parseBody(productSearchResponseSchema, data);
}

/** The parameter names of a `422 unsupported_combination` answer. */
function refusedParameters(error: unknown): string[] | undefined {
  const response = (error as { response?: { status?: number; data?: { code?: unknown; parameters?: unknown } } } | null)?.response;
  if (response?.status !== 422 || response.data?.code !== 'unsupported_combination') return undefined;
  return Array.isArray(response.data.parameters) ? response.data.parameters.filter((p): p is string => typeof p === 'string') : undefined;
}

/**
 * `GET /api/products/search` for a view (W02 FR-021): exactly the canonical parameters, `limit=24`, `facets=true`
 * (not for meaning search), parsed with `productSearchResponseSchema`. A failure carries its status, `code` and
 * `requestId` for the error copy (`problemFromError`); an unparsable answer is a failed call. A parameter the API does not
 * serve yet (`unsupported_combination`) is dropped and the request repeated (see `lib/search/degrade.ts`).
 */
export async function fetchSearch(view: SearchView, options: { signal?: AbortSignal } = {}): Promise<ProductSearchResponse> {
  let params = searchRequestParams(view);
  let semanticRefused = false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await get(params, options.signal);
      return semanticRefused ? asDegradedSemantic(response) : response;
    } catch (error) {
      const next = attempt < 2 ? withoutRefused(params, refusedParameters(error)) : null;
      if (!next) throw error;
      params = next.params;
      semanticRefused ||= next.semanticRefused;
    }
  }
}

const sentClicks = new Set<string>();

/**
 * One click record per result per search (W02 FR-035): a background `POST /api/search/clicks` with `keepalive`, so it
 * survives the navigation it accompanies. Every failure is ignored; nothing here can block or break the click.
 */
export function logSearchClick(record: SearchClickRequest): void {
  const parsed = searchClickRequestSchema.safeParse(record);
  if (!parsed.success) return;
  const key = `${parsed.data.searchId}:${parsed.data.productId}`;
  if (sentClicks.has(key)) return;
  sentClicks.add(key);
  try {
    void fetch('/api/search/clicks', {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...csrfHeaders() },
      body: JSON.stringify(parsed.data),
    }).catch(() => undefined);
  } catch {
    // A click record is best-effort.
  }
}

export function __resetSearchClicksForTests(): void {
  sentClicks.clear();
}
