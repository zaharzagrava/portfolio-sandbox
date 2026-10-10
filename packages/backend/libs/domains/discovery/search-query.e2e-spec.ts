import { randomUUID } from 'node:crypto';
import {
  productSearchResponseSchema,
  searchEventSchemas,
  type ProductSearchResponse,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import { SEARCH_EVENT_PUBLISHER } from './domain/ports';
import { createSearchApp, type SearchTestApp } from './testing/search-app';
import {
  deliver,
  newId,
  offboardingStarted,
  productDeleted,
  productEvent,
  shopDeleted,
  shopStatusEvent,
  snapshot,
} from './testing/search-events';
import { seedProducts } from './testing/search-fixtures';

const counter = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Public product search API', () => {
  let t: SearchTestApp;
  let shopId: string;
  let published: jest.SpyInstance;
  let engineCalls: jest.SpyInstance;

  beforeAll(async () => {
    t = await createSearchApp({ engineProxy: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetSearch();
    shopId = newId();
    // the very publisher instance the search module uses
    const adapter = t.app.get(SEARCH_EVENT_PUBLISHER, { strict: false }) as unknown as {
      publisher: EventPublisher;
    };
    published = jest.spyOn(adapter.publisher, 'publish');
    engineCalls = jest.spyOn(t.engine, 'search');
  });
  afterEach(() => jest.restoreAllMocks());

  const search = (query: Record<string, string | number> = {}) =>
    t.http().get('/api/products/search').query(query);
  const ok = async (query: Record<string, string | number> = {}) => {
    const res = await search(query).expect(200);
    return productSearchResponseSchema.parse(res.body) as ProductSearchResponse;
  };
  const titles = (r: ProductSearchResponse) => r.items.map((i) => i.title);
  const performed = () =>
    published.mock.calls
      .map(([e]) => e as { type: string; aggregateId: string; payload: Record<string, unknown> })
      .filter((e) => e.type === 'search.performed');

  describe('lexical search (AS-01 to AS-03)', () => {
    it('S32 AS-01: 200 with the response schema, private no-store, one engine query and one search.performed event', async () => {
      const [p1, p2, p3] = await seedProducts(t, shopId, [
        { title: 'iPhone 17 Pro Case', brand: 'Acme', category: 'cases' },
        { title: 'AirPods Pro', category: 'audio' },
        { title: 'iPhone 17 Screen Protector', category: 'cases' },
      ]);
      engineCalls.mockClear();

      const res = await search({ q: 'iphone' }).expect(200);

      expect(res.headers['cache-control']).toBe('private, no-store');
      const body = productSearchResponseSchema.parse(res.body);
      expect(body.mode).toBe('lexical');
      expect(body.items.map((i) => i.id).sort()).toEqual([p1, p3].sort());
      expect(body.items.map((i) => i.id)).not.toContain(p2);
      expect(body.items.map((i) => i.position)).toEqual([0, 1]);
      expect(body.total).toEqual({ value: 2, exact: true });
      expect(body.nextCursor).toBeNull();
      expect(body.degraded).toEqual([]);
      expect(body.searchId.length).toBeGreaterThan(10);
      expect('facets' in body).toBe(false);
      expect(Object.keys(body.items[0]).sort()).toEqual(
        ['brand', 'category', 'currency', 'id', 'imageUrl', 'inStock', 'position', 'priceMinor', 'rating', 'shopId', 'sponsored', 'title'].sort(),
      );
      expect(JSON.stringify(res.body)).not.toMatch(/embedding|_score|browseScore|description/);
      expect(engineCalls).toHaveBeenCalledTimes(1);

      expect(performed()).toHaveLength(1);
      const event = performed()[0];
      expect(event.aggregateId).toBe(body.searchId);
      expect(event.payload).toMatchObject({
        searchId: body.searchId,
        query: 'iphone',
        results: 2,
        mode: 'lexical',
        degraded: [],
        surface: 'http',
      });
      expect(
        searchEventSchemas['search.performed'].safeParse({
          eventId: (event as unknown as { eventId: string }).eventId,
          type: 'search.performed',
          version: 1,
          occurredAt: (event as unknown as { occurredAt: string }).occurredAt,
          aggregateId: event.aggregateId,
          payload: event.payload,
        }).success,
      ).toBe(true);
    });

    it('S32 AS-02: tolerates typos, ranks exact above fuzzy, needs the first letter, finds nothing for nonsense', async () => {
      const [p1, p2] = await seedProducts(t, shopId, [
        { title: 'iPhone 17 Pro Case' },
        { title: 'AirPods Pro' },
        { title: 'Case iPhone' },
        { title: 'Cose iPhone' },
      ]);
      expect((await ok({ q: 'iphnoe' })).items.map((i) => i.id)).toContain(p1);
      expect((await ok({ q: 'aipods' })).items.map((i) => i.id)).toContain(p2);
      expect((await ok({ q: 'xpone' })).items).toEqual([]);

      const ranked = titles(await ok({ q: 'case' }));
      expect(ranked.indexOf('Case iPhone')).toBeLessThan(ranked.indexOf('Cose iPhone'));
      expect((await ok({ q: 'xase' })).items).toEqual([]);
    });

    it('S32 AS-03: a title match outranks brand, description and tags in that order', async () => {
      const ids = await seedProducts(t, shopId, [
        { title: 'Espresso', brand: 'Acme', description: 'plain', tags: [] },
        { title: 'Plain thing', brand: 'Espresso', description: 'plain', tags: [] },
        { title: 'Plain thing', brand: 'Acme', description: 'about espresso', tags: [] },
        { title: 'Plain thing', brand: 'Acme', description: 'plain', tags: ['espresso'] },
      ]);
      expect((await ok({ q: 'espresso' })).items.map((i) => i.id)).toEqual(ids);
    });
  });

  describe('browse, boosts and visibility (AS-04 to AS-07)', () => {
    it('S32 AS-04: without q (also q= and blanks) every visible product is listed by business score then id, with no event', async () => {
      const [a, b, c] = await seedProducts(t, shopId, [
        { title: 'Plain', quantity: 0, inStock: false },
        { title: 'Popular', quantity: 3, popularity: 8, rating: 4 },
        { title: 'Stocked', quantity: 3 },
      ]);
      for (const q of [undefined, '', '%20%20'] as const) {
        const res = await search(q === undefined ? {} : { q: decodeURIComponent(q) }).expect(200);
        const body = productSearchResponseSchema.parse(res.body);
        expect(body.mode).toBe('browse');
        expect(body.items.map((i) => i.id)).toEqual([b, c, a]);
      }
      expect(performed()).toHaveLength(0);
    });

    it('S32 AS-05: each boost signal alone moves a product up; missing signals are neutral', async () => {
      const rank = async (a: object, b: object) => {
        await t.resetSearch();
        const other = newId();
        const [x, y] = await seedProducts(t, shopId, [
          { title: 'Widget', ...a },
          { title: 'Widget', ...b, shopId: (b as { plan?: string }).plan ? other : shopId },
        ]);
        const ids = (await ok({ q: 'widget' })).items.map((i) => i.id);
        return { first: ids[0], x, y };
      };
      let r = await rank({ quantity: 5 }, { quantity: 0, inStock: false });
      expect(r.first).toBe(r.x);
      r = await rank({ rating: 1 }, { rating: 4.5 });
      expect(r.first).toBe(r.y);
      r = await rank({ popularity: 2 }, { popularity: 8 });
      expect(r.first).toBe(r.y);
      r = await rank({ plan: 'STARTER' }, { plan: 'PRO' });
      expect(r.first).toBe(r.y);
      r = await rank({}, { sponsored: true });
      expect(r.first).toBe(r.y);
      const sponsoredItem = (await ok({ q: 'widget' })).items.find((i) => i.id === r.y)!;
      expect(sponsoredItem.sponsored).toBe(true);

      await t.resetSearch();
      const [bare] = await seedProducts(t, shopId, [{ title: 'Brand new thing' }]);
      expect((await ok({ q: 'brand' })).items.map((i) => i.id)).toEqual([bare]);
    });

    it('S32 AS-06: boosts never bury an exact title match', async () => {
      const [exact, boosted] = await seedProducts(t, shopId, [
        { title: 'Espresso Machine', quantity: 0, inStock: false, rating: 0 },
        {
          title: 'Kitchen appliance',
          description: 'a machine for the kitchen',
          quantity: 9,
          rating: 5,
          popularity: 10,
          sponsored: true,
          plan: 'PRO',
        },
      ]);
      const ids = (await ok({ q: 'espresso machine' })).items.map((i) => i.id);
      expect(ids[0]).toBe(exact);
      expect(ids).toContain(boosted);
      expect((await t.doc(boosted))!.browseScore).toBeLessThanOrEqual(4);
    });

    it('S32 AS-07: archived, deleted and closed-shop products never appear; restoring or reinstating brings them back', async () => {
      const closed = (status: 'SUSPENDED' | 'DELETING' | 'DELETED') => newId() && status;
      void closed;
      const shops = { suspended: newId(), deleting: newId(), deleted: newId() };
      const [visible, archived, deleted, suspended, deleting, gone] = [
        newId(), newId(), newId(), newId(), newId(), newId(),
      ];
      const lamp = (productId: string, over = {}) =>
        productEvent('created', snapshot({ productId, shopId, title: 'Desk lamp', ...over }));
      await deliver(t.app).products(
        lamp(visible),
        lamp(archived),
        lamp(deleted),
        productEvent('created', snapshot({ productId: suspended, shopId: shops.suspended, title: 'Desk lamp' })),
        productEvent('created', snapshot({ productId: deleting, shopId: shops.deleting, title: 'Desk lamp' })),
        productEvent('created', snapshot({ productId: gone, shopId: shops.deleted, title: 'Desk lamp' })),
      );
      await deliver(t.app).products(
        productEvent('archived', snapshot({ productId: archived, shopId, title: 'Desk lamp', status: 'ARCHIVED', productVersion: 2 })),
        productDeleted(deleted, shopId, 2),
      );
      await deliver(t.app).shops(
        shopStatusEvent(shops.suspended, 'SUSPENDED', 2, t.clock.now()),
        offboardingStarted(shops.deleting, t.clock.now()),
        shopDeleted(shops.deleted, t.clock.now()),
      );
      await t.refresh();

      const body = await ok({ q: 'lamp' });
      expect(body.items.map((i) => i.id)).toEqual([visible]);
      expect(body.total).toEqual({ value: 1, exact: true });

      await deliver(t.app).products(
        productEvent('restored', snapshot({ productId: archived, shopId, title: 'Desk lamp', productVersion: 3 })),
      );
      await deliver(t.app).shops(shopStatusEvent(shops.suspended, 'ACTIVE', 3, t.clock.now()));
      await t.refresh();
      expect((await ok({ q: 'lamp' })).items.map((i) => i.id).sort()).toEqual(
        [visible, archived, suspended].sort(),
      );
    });
  });

  describe('sort, paging and validation (AS-08 to AS-10)', () => {
    it('S32 AS-08: price-asc, price-desc and newest order with an id tie-break and repeat identically; relevance without q is browse', async () => {
      const ids = await seedProducts(t, shopId, [
        { title: 'Item', priceMinor: 100 },
        { title: 'Item', priceMinor: 100 },
        { title: 'Item', priceMinor: 250 },
        { title: 'Item', priceMinor: 500 },
        { title: 'Item', priceMinor: 900 },
      ]);
      const priceOf = new Map(ids.map((id, i) => [id, [100, 100, 250, 500, 900][i]]));
      const order = async (sort: string) => (await ok({ q: 'item', sort })).items.map((i) => i.id);

      const asc = await order('price-asc');
      expect(asc.map((id) => priceOf.get(id))).toEqual([100, 100, 250, 500, 900]);
      expect(asc.slice(0, 2)).toEqual([...asc.slice(0, 2)].sort());
      const desc = await order('price-desc');
      expect(desc.map((id) => priceOf.get(id))).toEqual([900, 500, 250, 100, 100]);
      expect(desc.slice(3)).toEqual([...desc.slice(3)].sort());
      expect(await order('newest')).toEqual([...ids].reverse());
      expect(await order('price-asc')).toEqual(asc);
      expect((await ok({ sort: 'relevance' })).mode).toBe('browse');
    });

    it('S32 AS-09: pages of 20, 20 and 5 without gap or duplicate; a cursor of another search or an altered one is 422 with no engine query; inserting between pages still answers 200', async () => {
      const all = await seedProducts(
        t,
        shopId,
        Array.from({ length: 45 }, (_, i) => ({ title: `Cable ${i}` })),
      );
      const seen: string[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];
      let first: ProductSearchResponse | null = null;
      do {
        const page: ProductSearchResponse = await ok({ q: 'cable', limit: 20, ...(cursor ? { cursor } : {}) });
        first ??= page;
        expect(page.total).toEqual({ value: 45, exact: true });
        sizes.push(page.items.length);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(sizes).toEqual([20, 20, 5]);
      expect(new Set(seen).size).toBe(45);
      expect([...seen].sort()).toEqual([...all].sort());

      const issued = first!.nextCursor!;
      engineCalls.mockClear();
      const bad: Record<string, string | number>[] = [
        { q: 'charger', limit: 20, cursor: issued },
        { q: 'cable', limit: 20, cursor: issued, category: 'x' },
        { q: 'cable', limit: 20, cursor: issued, sort: 'price-asc' },
        { q: 'cable', limit: 20, cursor: issued.slice(0, -4) },
        { q: 'cable', limit: 20, cursor: `${issued.slice(0, -2)}AA` },
        { q: 'cable', limit: 20, cursor: '***not base64url***' },
      ];
      for (const query of bad) {
        const res = await search(query).expect(422);
        expect(res.body.code).toBe('invalid_cursor');
      }
      expect(engineCalls).not.toHaveBeenCalled();

      await seedProducts(t, shopId, [{ title: 'Cable newcomer' }]);
      await search({ q: 'cable', limit: 20, cursor: issued }).expect(200);
    });

    it('S32 AS-10: every validation class answers 400 validation_failed naming its parameter with no engine query; a reversed price range is 422', async () => {
      await seedProducts(t, shopId, [{ title: 'Anything' }]);
      engineCalls.mockClear();
      const bad: [string, Record<string, string | number>][] = [
        ['limit', { limit: 0 }],
        ['limit', { limit: 51 }],
        ['limit', { limit: 'abc' }],
        ['q', { q: 'x'.repeat(101) }],
        ['minRating', { minRating: 6 }],
        ['minRating', { minRating: -1 }],
        ['minPriceMinor', { minPriceMinor: -1 }],
        ['minPriceMinor', { minPriceMinor: 1.5 }],
        ['inStock', { inStock: 'maybe' }],
        ['sort', { sort: 'popular' }],
        ['category', { category: 'c'.repeat(101) }],
        ['brand', { brand: 'b'.repeat(101) }],
        ['size', { size: 10 }],
        ['from', { from: 10 }],
        ['priceMin', { priceMin: 10 }],
        ['priceMax', { priceMax: 10 }],
        ['ratingMin', { ratingMin: 3 }],
        ['bogus', { bogus: 1 }],
        ['facets', { facets: 'yes' }],
      ];
      for (const [field, query] of bad) {
        const res = await search(query).expect(400);
        expect(res.headers['content-type']).toContain('problem+json');
        expect(res.body).toMatchObject({ code: 'validation_failed', status: 400 });
        expect(res.body.requestId).toBeDefined();
        expect(JSON.stringify(res.body.errors ?? res.body)).toContain(field);
      }
      const range = await search({ minPriceMinor: 500, maxPriceMinor: 100 }).expect(422);
      expect(range.body.code).toBe('invalid_price_range');
      expect(engineCalls).not.toHaveBeenCalled();
    });
  });

  describe('hostile input, limits and failure (AS-11 to AS-14)', () => {
    it('S32 AS-11: operators, wildcards, backslashes, emoji, fullwidth and control characters are plain text and never fail', async () => {
      const [iphone] = await seedProducts(t, shopId, [
        { title: 'iPhone 17 Case', priceMinor: 1_000 },
        { title: 'Phone stand', priceMinor: 500 },
      ]);
      for (const q of [
        '"iphone" OR price:[0 TO 1]',
        'title:iphone AND NOT case',
        '\\\\',
        '('.repeat(100),
        '🙂🙂🙂',
        'iphone\u0000\u0007 case',
      ])
        await search({ q }).expect(200);
      expect((await ok({ q: 'iph*' })).items.map((i) => i.id)).not.toContain(iphone);
      expect((await ok({ q: 'ＩＰＨＯＮＥ' })).items.map((i) => i.id)).toContain(iphone);
      expect((await ok({ q: 'iphone\u0000\u0007' })).items.map((i) => i.id)).toContain(iphone);
    });

    it('S32 AS-12: anonymous and signed-in callers are served alike; one caller over 120 a minute gets 429 with Retry-After while others are unaffected', async () => {
      await seedProducts(t, shopId, [{ title: 'Public thing' }]);
      const user = await t.newUser();
      const a = await ok({ q: 'public' });
      const b = productSearchResponseSchema.parse(
        (await t.as(user).get('/api/products/search?q=public').expect(200)).body,
      );
      expect(titles(a)).toEqual(titles(b));

      let limited = 0;
      for (let i = 0; i < 125; i++) {
        const res = await search({ q: 'public' });
        if (res.status === 429) {
          limited++;
          expect(res.headers['retry-after']).toBeDefined();
          expect(res.body.status).toBe(429);
        }
      }
      expect(limited).toBeGreaterThan(0);
      await t.as(user).get('/api/products/search?q=public').expect(200);
    });

    it('S32 AS-13: an engine that refuses or hangs answers 503 search_unavailable within the budget, with no leak; it recovers', async () => {
      await seedProducts(t, shopId, [{ title: 'Resilient' }]);
      const before = counter('search_unavailable_total');

      t.proxy!.mode = 'refuse';
      const refused = await search({ q: 'resilient' }).expect(503);
      expect(refused.body).toMatchObject({ code: 'search_unavailable', status: 503 });
      expect(refused.headers['retry-after']).toBe('1');
      expect(refused.body.requestId).toBeDefined();
      expect(JSON.stringify(refused.body)).not.toMatch(/elastic|ECONN|stack|127\.0\.0\.1/i);

      t.proxy!.mode = 'hang';
      const started = Date.now();
      const slow = await search({ q: 'resilient' }).expect(503);
      expect(Date.now() - started).toBeLessThan(1_600);
      expect(slow.body.code).toBe('search_unavailable');

      expect(counter('search_unavailable_total')).toBe(before + 2);
      expect(performed()).toHaveLength(0);

      t.proxy!.mode = 'pass';
      t.proxy!.sever();
      expect(titles(await ok({ q: 'resilient' }))).toEqual(['Resilient']);
    });

    it('S32 AS-14: filters are an AND, never reorder what remains, and an empty answer is a normal 200 with its event', async () => {
      const [a, b, c] = await seedProducts(t, shopId, [
        { title: 'Wire headset', category: 'audio', brand: 'Acme', priceMinor: 2_000, rating: 4.5, quantity: 3 },
        { title: 'Wire headset pro', category: 'audio', brand: 'Acme', priceMinor: 5_000, rating: 4.1, quantity: 3 },
        { title: 'Wire headset mini', category: 'video', brand: 'Other', priceMinor: 500, rating: 2, quantity: 0, inStock: false },
      ]);
      const filtered = await ok({
        q: 'wire headset',
        category: 'audio',
        brand: 'Acme',
        minPriceMinor: 1_000,
        maxPriceMinor: 9_999,
        minRating: 4,
        inStock: 'true',
      });
      expect(filtered.items.map((i) => i.id).sort()).toEqual([a, b].sort());
      const unfiltered = (await ok({ q: 'wire headset' })).items.map((i) => i.id).filter((id) => id !== c);
      expect(filtered.items.map((i) => i.id)).toEqual(unfiltered);
      await ok({ category: 'audio' });

      published.mockClear();
      const none = await ok({ q: 'wire headset', category: 'nonexistent' });
      expect(none).toMatchObject({ items: [], total: { value: 0, exact: true }, nextCursor: null });
      expect(performed()[0].payload).toMatchObject({ results: 0, filters: ['category'] });
    });
  });

  describe('route precedence and the old catalog cases (T057)', () => {
    it('S32 AS-01: /products/search is served by discovery while /products/:id still reads the catalog and search is not a 400 of the catalog pipe', async () => {
      await seedProducts(t, shopId, [{ title: 'Route check' }]);
      expect((await ok({ q: 'route' })).items).toHaveLength(1);
      const res = await t.http().get(`/api/products/${randomUUID()}`);
      expect(res.status).toBe(404);
      expect(res.body.code).not.toBe('validation_failed');
      const notAnId = await t.http().get('/api/products/not-a-uuid');
      expect(notAnId.status).toBe(400);
    });

    it('S32 AS-14: the old catalog search cases hold over HTTP: text and pagination, price range, rating, sort by price and by newest', async () => {
      await seedProducts(t, shopId, [
        { title: 'Apple iPhone' },
        { title: 'Apple iPad' },
        { title: 'Samsung Galaxy' },
      ]);
      const apple = await ok({ q: 'Apple', limit: 1 });
      expect(apple.items).toHaveLength(1);
      expect(apple.total.value).toBe(2);
      const next = await ok({ q: 'Apple', limit: 1, cursor: apple.nextCursor! });
      expect(next.items[0].id).not.toBe(apple.items[0].id);

      await t.resetSearch();
      await seedProducts(t, shopId, [
        { title: 'Cheap Phone', priceMinor: 10_000, rating: 3.5, createdAt: '2026-01-01T00:00:00.000Z' },
        { title: 'Mid Phone', priceMinor: 30_000, rating: 4.2, createdAt: '2026-01-05T00:00:00.000Z' },
        { title: 'Expensive Phone', priceMinor: 80_000, rating: 4.8, createdAt: '2026-01-10T00:00:00.000Z' },
      ]);
      expect(titles(await ok({ minPriceMinor: 20_000, maxPriceMinor: 50_000 }))).toEqual(['Mid Phone']);
      expect(titles(await ok({ minRating: 4 })).sort()).toEqual(['Expensive Phone', 'Mid Phone']);
      expect(titles(await ok({ sort: 'price-asc' }))).toEqual(['Cheap Phone', 'Mid Phone', 'Expensive Phone']);
      expect(titles(await ok({ sort: 'price-desc' }))).toEqual(['Expensive Phone', 'Mid Phone', 'Cheap Phone']);
      expect(titles(await ok({ sort: 'newest' }))).toEqual(['Expensive Phone', 'Mid Phone', 'Cheap Phone']);
    });
  });
});

describe('Public product search API without the limiter store', () => {
  let t: SearchTestApp;

  beforeAll(async () => {
    t = await createSearchApp({ redisProxy: true });
  });
  afterAll(() => t.close());
  beforeEach(() => t.resetSearch());

  it('S32 AS-12: when the limiter store is down searches are still served (fail open)', async () => {
    const shopId = newId();
    await seedProducts(t, shopId, [{ title: 'Still served' }]);
    t.redisProxy!.mode = 'refuse';
    t.redisProxy!.sever();
    const res = await t.http().get('/api/products/search?q=served').expect(200);
    expect(res.body.items).toHaveLength(1);
  });
});
