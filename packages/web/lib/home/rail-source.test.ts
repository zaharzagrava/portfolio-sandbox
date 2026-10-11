import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { emptyResponse, problemResponse, PRODUCT_ID, searchResponse, trendingBody } from '@/lib/test/msw-handlers';

const cacheLife = vi.fn();
const cacheTag = vi.fn();
vi.mock('next/cache', () => ({ cacheLife: (...a: unknown[]) => cacheLife(...a), cacheTag: (...a: unknown[]) => cacheTag(...a) }));

import { homeRailSource } from '@/lib/home/rail-source';

const trending = (handler: Parameters<typeof http.get>[1]) => server.use(http.get('*/api/trending', handler));
const browse = (handler: Parameters<typeof http.get>[1]) => server.use(http.get('*/api/products/search', handler));

/** The longest lifetime (in seconds) any `cacheLife` call asked for. */
const longestRevalidate = () =>
  Math.max(...cacheLife.mock.calls.map(([life]) => (typeof life === 'object' ? (life.revalidate ?? 0) : Number.POSITIVE_INFINITY)));

beforeEach(() => {
  cacheLife.mockClear();
  cacheTag.mockClear();
});

describe('homeRailSource', () => {
  it('W02 AS-02: trending items become rail cards in rank order, at most eight, cached 30 s under the trending tag', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      rank: i + 1,
      productId: `3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a${String(i).padStart(2, '0')}`,
      title: `Item ${i + 1}`,
      priceMinor: 1000 + i,
      currency: 'EUR',
      category: 'audio',
      score: 10 - i,
    }));
    trending(() => HttpResponse.json(trendingBody({ items })));
    const rail = await homeRailSource();
    expect(rail.kind).toBe('trending');
    expect(rail.cards).toHaveLength(8);
    expect(rail.cards[0]).toMatchObject({ rank: 1, title: 'Item 1', currency: 'EUR', category: 'audio' });
    expect(cacheTag).toHaveBeenCalledWith('trending');
    expect(longestRevalidate()).toBe(30);
  });

  it('W02 AS-03: empty items fall back to the catalogue browse', async () => {
    trending(() => HttpResponse.json(trendingBody({ items: [] })));
    browse(() => HttpResponse.json(searchResponse()));
    const rail = await homeRailSource();
    expect(rail.kind).toBe('catalogue');
    expect(rail.cards[0]).toMatchObject({ id: PRODUCT_ID, title: 'iPhone 17' });
  });

  it.each([
    ['429', () => problemResponse(429, 'rate_limited', { retryAfter: 3 })],
    ['503', () => problemResponse(503, 'trending_unavailable')],
    ['400', () => problemResponse(400, 'validation_failed')],
    ['invalid body', () => HttpResponse.json({ nope: true })],
    ['no body', () => emptyResponse(502)],
    ['network', () => HttpResponse.error()],
  ])('W02 AS-03: trending %s falls back to the catalogue browse', async (_name, answer) => {
    trending(answer);
    browse(() => HttpResponse.json(searchResponse()));
    const rail = await homeRailSource();
    expect(rail.kind).toBe('catalogue');
    expect(rail.cards).toHaveLength(1);
    // the failed trending read is not kept longer than five seconds
    expect(cacheLife.mock.calls.some(([life]) => typeof life === 'object' && life.revalidate !== undefined && life.revalidate <= 5)).toBe(true);
  });

  it('W02 AS-03: a trending read that does not answer within two seconds falls back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      trending(() => new Promise<Response>(() => {}));
      browse(() => HttpResponse.json(searchResponse()));
      const pending = homeRailSource();
      await vi.advanceTimersByTimeAsync(2_100);
      expect((await pending).kind).toBe('catalogue');
    } finally {
      vi.useRealTimers();
    }
  });

  it('W02 AS-03: the browse fallback is read as the first eight products of a browse search', async () => {
    let url: URL | undefined;
    trending(() => HttpResponse.json(trendingBody({ items: [] })));
    browse(({ request }) => {
      url = new URL(request.url);
      return HttpResponse.json(searchResponse());
    });
    await homeRailSource();
    expect(url?.searchParams.get('limit')).toBe('8');
    expect(url?.searchParams.has('q')).toBe(false);
  });

  it('W02 AS-03: both reads failing gives the empty state, and the failures are kept at most five seconds', async () => {
    trending(() => problemResponse(503, 'trending_unavailable'));
    browse(() => problemResponse(503, 'search_unavailable'));
    const rail = await homeRailSource();
    expect(rail).toEqual({ kind: 'empty', cards: [] });
    for (const [life] of cacheLife.mock.calls) {
      expect(life.revalidate).toBeLessThanOrEqual(5);
    }
  });

  it('W02 AS-03: an empty catalogue is the empty state too', async () => {
    trending(() => HttpResponse.json(trendingBody({ items: [] })));
    browse(() => HttpResponse.json(searchResponse({ items: [], total: { value: 0, exact: true } })));
    expect((await homeRailSource()).kind).toBe('empty');
  });

  it('W02 AS-02: no cookie or Authorization header goes with the read', async () => {
    let headers: Headers | undefined;
    trending(({ request }) => {
      headers = request.headers;
      return HttpResponse.json(trendingBody());
    });
    await homeRailSource();
    expect(headers?.get('cookie')).toBeNull();
    expect(headers?.get('authorization')).toBeNull();
  });
});
