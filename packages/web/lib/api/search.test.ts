import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { problemFromError } from '@/lib/api/errors';
import { PRODUCT_ID, problemResponse, searchResponse } from '@/lib/test/msw-handlers';
import { __resetSearchClicksForTests, fetchSearch, logSearchClick } from '@/lib/api/search';

beforeEach(() => __resetSearchClicksForTests());

describe('fetchSearch', () => {
  it('W02 AS-10: asks for 24 results with facets and a cursor, never a from', async () => {
    let url: URL | undefined;
    server.use(
      http.get('*/api/products/search', ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(searchResponse());
      }),
    );
    await fetchSearch({ q: 'espresso', category: 'coffee', minPriceMinor: 1000, maxPriceMinor: 50000, sort: 'price-desc', cursor: 'abc' });
    expect(Object.fromEntries(url!.searchParams)).toEqual({
      q: 'espresso',
      category: 'coffee',
      minPriceMinor: '1000',
      maxPriceMinor: '50000',
      sort: 'price-desc',
      facets: 'true',
      limit: '24',
      cursor: 'abc',
    });
    expect(url!.searchParams.has('from')).toBe(false);
  });

  it('W02 AS-21: semantic search sends no facets', async () => {
    let url: URL | undefined;
    server.use(
      http.get('*/api/products/search', ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(searchResponse({ mode: 'semantic', facets: undefined }));
      }),
    );
    await fetchSearch({ q: 'warm coat', semantic: true });
    expect(url!.searchParams.get('semantic')).toBe('true');
    expect(url!.searchParams.has('facets')).toBe(false);
  });

  it('W02 AS-10: reads items, total.exact, degraded and the facet keys', async () => {
    server.use(
      http.get('*/api/products/search', () =>
        HttpResponse.json(searchResponse({ total: { value: 10_000, exact: false }, degraded: ['semantic_unavailable'], searchId: 's-9' })),
      ),
    );
    const response = await fetchSearch({ q: 'a' });
    expect(response.items).toHaveLength(1);
    expect(response.total).toEqual({ value: 10_000, exact: false });
    expect(response.degraded).toEqual(['semantic_unavailable']);
    expect(response.facets?.categories[0]?.key).toBe('phones');
    expect(response.searchId).toBe('s-9');
  });

  it('W02 AS-24: a problem answer keeps its status, code and request id for the error copy', async () => {
    server.use(http.get('*/api/products/search', () => problemResponse(422, 'invalid_cursor', { requestId: 'req-7' })));
    const error = await fetchSearch({ q: 'a', cursor: 'x' }).catch((e: unknown) => e);
    expect(problemFromError(error)).toMatchObject({ status: 422, code: 'invalid_cursor', requestId: 'req-7' });
  });

  it('W02 AS-24: an unparsable body is a failed call (5xx)', async () => {
    server.use(http.get('*/api/products/search', () => HttpResponse.json({ hits: [] })));
    const error = await fetchSearch({ q: 'a' }).catch((e: unknown) => e);
    expect(problemFromError(error).status).toBeGreaterThanOrEqual(500);
  });

  it('W02 AS-24: a network failure has status 0', async () => {
    server.use(http.get('*/api/products/search', () => HttpResponse.error()));
    const error = await fetchSearch({ q: 'a' }).catch((e: unknown) => e);
    expect(problemFromError(error).status).toBe(0);
  });

  it('W02 AS-31: pickup coordinates are not part of a normal search request', async () => {
    let url: URL | undefined;
    server.use(
      http.get('*/api/products/search', ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(searchResponse());
      }),
    );
    await fetchSearch({ q: 'a' });
    expect(url!.searchParams.has('lat')).toBe(false);
    expect(url!.searchParams.has('lng')).toBe(false);
  });
});

describe('logSearchClick', () => {
  const record = { searchId: 'search-1', productId: PRODUCT_ID, position: 3 };

  it('W02 AS-23: sends one keepalive record with the API position', async () => {
    const bodies: unknown[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    server.use(
      http.post('*/api/search/clicks', async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    logSearchClick(record);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual(record);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', keepalive: true });
    fetchSpy.mockRestore();
  });

  it('W02 AS-23: one record per result per search', async () => {
    let calls = 0;
    server.use(
      http.post('*/api/search/clicks', () => {
        calls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    logSearchClick(record);
    logSearchClick(record);
    logSearchClick({ ...record, position: 4, productId: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a99' });
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it.each([
    ['422', () => problemResponse(422, 'invalid_search_id')],
    ['429', () => problemResponse(429, 'rate_limited', { retryAfter: 5 })],
    ['500', () => new HttpResponse(null, { status: 500 })],
    ['network', () => HttpResponse.error()],
  ])('W02 AS-23: a %s answer is ignored without a throw', async (_name, answer) => {
    server.use(http.post('*/api/search/clicks', answer));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    expect(() => logSearchClick(record)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('W02 AS-23: an invalid record is not sent', async () => {
    let calls = 0;
    server.use(
      http.post('*/api/search/clicks', () => {
        calls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    logSearchClick({ searchId: '', productId: 'nope', position: -1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(0);
  });
});
