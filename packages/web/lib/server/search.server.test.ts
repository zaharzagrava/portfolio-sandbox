import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { searchResponse } from '@/lib/test/msw-handlers';

vi.mock('next/cache', () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

import { getSearchFirstView } from '@/lib/server/search.server';

const refuse = (parameter: string) =>
  HttpResponse.json({ code: 'unsupported_combination', status: 422, parameters: [parameter] }, { status: 422, headers: { 'content-type': 'application/problem+json' } });

describe('getSearchFirstView', () => {
  it('W02 AS-10: reads the results of the address view with the canonical parameters', async () => {
    let url: URL | undefined;
    server.use(
      http.get('*/api/products/search', ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(searchResponse());
      }),
    );
    const response = await getSearchFirstView({ q: 'espresso', category: 'coffee' });
    expect(response?.items).toHaveLength(1);
    expect(Object.fromEntries(url!.searchParams)).toEqual({ q: 'espresso', category: 'coffee', facets: 'true', limit: '24' });
  });

  it('W02 AS-14: drops facets when the API does not serve them yet', async () => {
    server.use(
      http.get('*/api/products/search', ({ request }) =>
        new URL(request.url).searchParams.has('facets') ? refuse('facets') : HttpResponse.json(searchResponse({ facets: undefined })),
      ),
    );
    const response = await getSearchFirstView({ q: 'a' });
    expect(response?.facets).toBeUndefined();
    expect(response?.items).toHaveLength(1);
  });

  it('W02 AS-21: flags a meaning search the API cannot serve yet', async () => {
    server.use(
      http.get('*/api/products/search', ({ request }) =>
        new URL(request.url).searchParams.has('semantic') ? refuse('semantic') : HttpResponse.json(searchResponse({ facets: undefined })),
      ),
    );
    const response = await getSearchFirstView({ q: 'a', semantic: true });
    expect(response?.degraded).toContain('semantic_unavailable');
  });

  it('W02 AS-24: a failed read gives null, so the browser asks again and shows the error', async () => {
    server.use(http.get('*/api/products/search', () => HttpResponse.json({ code: 'search_unavailable' }, { status: 503 })));
    expect(await getSearchFirstView({ q: 'a' })).toBeNull();
  });

  it('W02 AS-10: the read carries no cookie or Authorization header', async () => {
    let headers: Headers | undefined;
    server.use(
      http.get('*/api/products/search', ({ request }) => {
        headers = request.headers;
        return HttpResponse.json(searchResponse());
      }),
    );
    await getSearchFirstView({});
    expect(headers?.get('cookie')).toBeNull();
    expect(headers?.get('authorization')).toBeNull();
  });
});
