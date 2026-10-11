import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { problemFromError } from '@/lib/api/errors';
import { searchResponse } from '@/lib/test/msw-handlers';
import { fetchSearch } from '@/lib/api/search';

/** S32 serves facets and meaning search from its second delivery: until then the API refuses them (422). */
const refuse = (parameter: string) =>
  HttpResponse.json({ code: 'unsupported_combination', status: 422, parameters: [parameter] }, { status: 422, headers: { 'content-type': 'application/problem+json' } });

describe('fetchSearch while the API does not serve facets or meaning search yet', () => {
  it('W02 AS-14: a refused facets parameter is dropped and the request repeated; the page then has no facet groups', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get('*/api/products/search', ({ request }) => {
        const facets = new URL(request.url).searchParams.get('facets');
        seen.push(facets);
        return facets ? refuse('facets') : HttpResponse.json(searchResponse({ facets: undefined }));
      }),
    );
    const response = await fetchSearch({ q: 'a' });
    expect(seen).toEqual(['true', null]);
    expect(response.facets).toBeUndefined();
    expect(response.items).toHaveLength(1);
  });

  it('W02 AS-21: a refused semantic parameter gives keyword results flagged semantic_unavailable', async () => {
    server.use(
      http.get('*/api/products/search', ({ request }) =>
        new URL(request.url).searchParams.get('semantic') ? refuse('semantic') : HttpResponse.json(searchResponse({ mode: 'lexical', facets: undefined })),
      ),
    );
    const response = await fetchSearch({ q: 'warm coat', semantic: true });
    expect(response.mode).toBe('lexical');
    expect(response.degraded).toEqual(['semantic_unavailable']);
  });

  it('W02 AS-24: any other unsupported combination is still a failure', async () => {
    server.use(http.get('*/api/products/search', () => refuse('cursor')));
    const error = await fetchSearch({ q: 'a' }).catch((e: unknown) => e);
    expect(problemFromError(error)).toMatchObject({ status: 422, code: 'unsupported_combination' });
  });

  it('W02 AS-24: it does not repeat forever', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/products/search', () => {
        calls += 1;
        return refuse('facets');
      }),
    );
    await fetchSearch({ q: 'a' }).catch(() => undefined);
    expect(calls).toBeLessThanOrEqual(3);
  });
});
