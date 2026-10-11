import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { emptyResponse, problemResponse, searchResponse } from '@/lib/test/msw-handlers';

const cacheLife = vi.fn();
const cacheTag = vi.fn();
vi.mock('next/cache', () => ({ cacheLife: (...a: unknown[]) => cacheLife(...a), cacheTag: (...a: unknown[]) => cacheTag(...a) }));

import { categoryShortcuts } from '@/lib/home/category-shortcuts';

const facets = (handler: Parameters<typeof http.get>[1]) => server.use(http.get('*/api/products/search', handler));

beforeEach(() => {
  cacheLife.mockClear();
  cacheTag.mockClear();
});

describe('categoryShortcuts', () => {
  it('W02 AS-01: the first eight category facets become links to /search?category=<key>', async () => {
    const categories = Array.from({ length: 10 }, (_, i) => ({ key: `home-living-${i}`, count: 10 - i }));
    let url: URL | undefined;
    facets(({ request }) => {
      url = new URL(request.url);
      return HttpResponse.json(searchResponse({ facets: { categories, brands: [], priceRanges: [], avgRating: null } }));
    });
    const links = await categoryShortcuts();
    expect(links).toHaveLength(8);
    expect(links[0]).toEqual({ key: 'home-living-0', label: 'Home living 0', href: '/search?category=home-living-0' });
    expect(url?.searchParams.get('facets')).toBe('true');
    expect(url?.searchParams.get('limit')).toBe('1');
    expect(cacheTag).toHaveBeenCalledWith('search-facets');
    expect(cacheLife.mock.calls[0]?.[0]).toMatchObject({ revalidate: 60 });
  });

  it('W02 AS-01: a category key is encoded in the address', async () => {
    facets(() =>
      HttpResponse.json(searchResponse({ facets: { categories: [{ key: 'a&b c', count: 1 }], brands: [], priceRanges: [], avgRating: null } })),
    );
    expect((await categoryShortcuts())[0]?.href).toBe('/search?category=a%26b+c');
  });

  it.each([
    ['429', () => problemResponse(429, 'rate_limited', { retryAfter: 2 })],
    ['503', () => problemResponse(503, 'search_unavailable')],
    ['no body', () => emptyResponse(500)],
    ['invalid body', () => HttpResponse.json({ nope: 1 })],
    ['network', () => HttpResponse.error()],
  ])('W02 AS-01: %s omits the row, and the failure is kept at most five seconds', async (_name, answer) => {
    facets(answer);
    expect(await categoryShortcuts()).toEqual([]);
    expect(cacheLife.mock.calls[0]?.[0].revalidate).toBeLessThanOrEqual(5);
  });

  it('W02 AS-01: a response without facets omits the row', async () => {
    facets(() => HttpResponse.json(searchResponse({ facets: undefined })));
    expect(await categoryShortcuts()).toEqual([]);
  });
});
