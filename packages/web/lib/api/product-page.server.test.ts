import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { emptyResponse, problemResponse, PRODUCT_ID, SHOP_ID, recommendationsBody, trendingBody } from '@/lib/test/msw-handlers';

const cacheLife = vi.fn();
const cacheTag = vi.fn();
vi.mock('next/cache', () => ({ cacheLife: (...a: unknown[]) => cacheLife(...a), cacheTag: (...a: unknown[]) => cacheTag(...a) }));

import { getProductPage } from '@/lib/server/product-page.server';

const product = {
  id: PRODUCT_ID,
  shopId: SHOP_ID,
  title: 'Apple iPhone 17 Pro 256GB',
  description: 'Line one\nLine two',
  brand: 'Apple',
  category: 'phones',
  priceMinor: 89999,
  currency: 'USD',
  rating: 4.5,
  tags: ['5g', 'phone'],
  inStock: true,
  version: 3,
  viewCount: 10,
  updatedAt: '2026-10-10T10:00:00.000Z',
};

const sections = {
  shop: { id: SHOP_ID, name: 'Acme Store', slug: 'acme' },
  recommendations: recommendationsBody(),
  trending: trendingBody({ category: 'phones' }),
  flags: null,
  chatUnread: null,
  discussions: null,
  videos: null,
  gallery: {
    items: [
      { mediaId: '5f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b', position: 0, urls: { thumb: 'https://m.example/t.jpg', feed: 'https://m.example/f.jpg', full: 'https://m.example/F.jpg' }, width: 800, height: 800 },
    ],
  },
  pickup: null,
  flashSale: null,
  auction: null,
  errors: [],
};

const bff = (body: Record<string, unknown> | (() => Response)) =>
  server.use(http.get('*/api/bff/product-page/:id', () => (typeof body === 'function' ? body() : HttpResponse.json(body as never))));

beforeEach(() => {
  cacheLife.mockClear();
  cacheTag.mockClear();
});

describe('getProductPage', () => {
  it('W02 AS-32: a full answer becomes the page, cached 15 s under product:{id}', async () => {
    bff({ product, ...sections });
    const result = await getProductPage(PRODUCT_ID);
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(result.page.product.title).toBe('Apple iPhone 17 Pro 256GB');
    expect(result.page.shop).toEqual(sections.shop);
    expect(result.page.gallery?.[0]?.urls.feed).toBe('https://m.example/f.jpg');
    expect(result.page.degraded).toBe(false);
    expect(cacheTag).toHaveBeenCalledWith(`product:${PRODUCT_ID}`);
    expect(cacheLife).toHaveBeenCalledWith(expect.objectContaining({ revalidate: 15 }));
  });

  it('W02 AS-69: the read sends no cookie, Authorization or X-Anonymous-Id', async () => {
    let headers: Headers | undefined;
    server.use(
      http.get('*/api/bff/product-page/:id', ({ request }) => {
        headers = request.headers;
        return HttpResponse.json({ product, ...sections });
      }),
    );
    await getProductPage(PRODUCT_ID);
    for (const name of ['cookie', 'authorization', 'x-anonymous-id']) expect(headers?.get(name)).toBeNull();
  });

  it('W02 AS-34: every optional section can be null; the page keeps the product', async () => {
    bff({ product, ...sections, shop: null, recommendations: null, trending: null, gallery: null, errors: [{ section: 'shop', code: 'UPSTREAM_TIMEOUT', retryable: true }] });
    const result = await getProductPage(PRODUCT_ID);
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(result.page).toMatchObject({ shop: null, gallery: null, recommendations: null, trending: null, degraded: true });
  });

  it('W02 AS-34: a response with errors is kept at most 5 seconds', async () => {
    bff({ product, ...sections, errors: [{ section: 'gallery', code: 'BUDGET_EXCEEDED', retryable: true }], gallery: null });
    await getProductPage(PRODUCT_ID);
    expect(cacheLife).toHaveBeenCalledWith(expect.objectContaining({ revalidate: 5 }));
  });

  it('W02 AS-34: an optional section that does not parse is treated as missing and the result is not kept long', async () => {
    bff({ product, ...sections, shop: { nope: true }, gallery: { items: 'bad' } });
    const result = await getProductPage(PRODUCT_ID);
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') return;
    expect(result.page.shop).toBeNull();
    expect(result.page.gallery).toBeNull();
    expect(result.page.degraded).toBe(true);
    expect(cacheLife).toHaveBeenCalledWith(expect.objectContaining({ revalidate: 5 }));
  });

  it('W02 AS-39: empty rails are missing; trending drops the product itself and is cut to eight', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a${String(i + 10).padStart(2, '0')}`);
    const trendingItems = [PRODUCT_ID, ...ids].map((productId, i) => ({ rank: i + 1, productId, title: `T${i}`, priceMinor: 100, currency: 'USD', category: 'phones', score: 5 }));
    bff({ product, ...sections, recommendations: recommendationsBody({ items: [] }), trending: trendingBody({ category: 'phones', items: trendingItems }) });
    const result = await getProductPage(PRODUCT_ID);
    if (result.state !== 'ok') throw new Error('expected ok');
    expect(result.page.recommendations).toBeNull();
    expect(result.page.trending).toHaveLength(8);
    expect(result.page.trending?.some((item) => item.productId === PRODUCT_ID)).toBe(false);
  });

  it('W02 AS-39: a trending list that is only the product itself is missing', async () => {
    bff({ product, ...sections, trending: trendingBody({ items: [{ rank: 1, productId: PRODUCT_ID, title: 'Self', priceMinor: 1, currency: 'USD', category: 'phones', score: 1 }] }) });
    const result = await getProductPage(PRODUCT_ID);
    if (result.state !== 'ok') throw new Error('expected ok');
    expect(result.page.trending).toBeNull();
  });

  it.each([
    ['404', () => problemResponse(404, 'not_found'), { state: 'not-found' }],
    ['malformed product', () => HttpResponse.json({ product: { id: 1 }, ...sections }), { state: 'unavailable' }],
    ['503', () => problemResponse(503, 'upstream_unavailable', { requestId: 'req-9' }), { state: 'unavailable', requestId: 'req-9' }],
    ['502', () => problemResponse(502, 'upstream_invalid', { requestId: 'req-8' }), { state: 'unavailable', requestId: 'req-8' }],
    ['500 without body', () => emptyResponse(500), { state: 'unavailable' }],
    ['429', () => problemResponse(429, 'rate_limited', { retryAfter: 7 }), { state: 'rate-limited', retryAfterSeconds: 7 }],
    ['network', () => HttpResponse.error(), { state: 'offline' }],
  ])('W02 AS-33: %s maps to the page state', async (_name, answer, expected) => {
    bff(answer);
    const result = await getProductPage(PRODUCT_ID);
    expect(result).toMatchObject(expected);
    // a failed read is kept at most five seconds
    expect(cacheLife).toHaveBeenCalledWith(expect.objectContaining({ revalidate: 5 }));
  });

  it('W02 AS-33: a malformed id is not found without a request', async () => {
    let requests = 0;
    server.use(
      http.get('*/api/bff/product-page/:id', () => {
        requests += 1;
        return HttpResponse.json({ product, ...sections });
      }),
    );
    expect(await getProductPage('not-a-uuid')).toEqual({ state: 'not-found' });
    expect(requests).toBe(0);
  });
});
