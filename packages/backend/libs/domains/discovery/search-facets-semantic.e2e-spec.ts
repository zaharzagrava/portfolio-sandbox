import {
  productSearchResponseSchema,
  type ProductSearchResponse,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { EventPublisher } from '@app/infrastructure/events/event-publisher';
import { BackfillEmbeddingsJob } from './application/jobs/backfill-embeddings.job';
import { SEARCH_EVENT_PUBLISHER } from './domain/ports';
import { createSearchApp, type SearchTestApp } from './testing/search-app';
import {
  deliver,
  newId,
  productEvent,
  snapshot,
} from './testing/search-events';
import { seedProducts, type Seed } from './testing/search-fixtures';

const counter = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

const band = (price: number) =>
  price < 2_500
    ? 'under_25'
    : price < 5_000
      ? '25_to_50'
      : price < 10_000
        ? '50_to_100'
        : 'over_100';
const BANDS = ['under_25', '25_to_50', '50_to_100', 'over_100'];

const tally = (values: (string | null | undefined)[]) => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key, count]) => ({ key, count }));
};

describe('Search facets and semantic mode', () => {
  let t: SearchTestApp;
  let shopId: string;
  let published: jest.SpyInstance;

  beforeAll(async () => {
    t = await createSearchApp({ engineProxy: false });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetSearch();
    shopId = newId();
    const adapter = t.app.get(SEARCH_EVENT_PUBLISHER, {
      strict: false,
    }) as unknown as { publisher: EventPublisher };
    published = jest.spyOn(adapter.publisher, 'publish');
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const search = (query: Record<string, string | number> = {}) =>
    t.http().get('/api/products/search').query(query);
  const ok = async (query: Record<string, string | number> = {}) => {
    const res = await search(query).expect(200);
    return productSearchResponseSchema.parse(res.body) as ProductSearchResponse;
  };
  const performed = () =>
    published.mock.calls
      .map(([e]) => e as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === 'search.performed');

  const CATEGORIES = ['shoes', 'bags', 'hats'];
  const BRANDS = ['Acme', 'Bolt', 'Crest', 'Dune'];
  const PRICES = [1_000, 2_500, 3_000, 5_000, 7_500, 10_000, 15_000];
  /** 30 visible "widget" products spread over 3 categories, 4 brands (two without one) and every price band. */
  const widgets = (): (Seed & {
    category: string;
    priceMinor: number;
    rating: number;
  })[] =>
    Array.from({ length: 30 }, (_, i) => ({
      title: `Widget ${i}`,
      category: CATEGORIES[i % 3],
      brand: i >= 28 ? '' : BRANDS[i % 4],
      priceMinor: PRICES[i % PRICES.length],
      rating: i % 5,
      quantity: i % 6 === 0 ? 0 : 4,
      inStock: i % 6 !== 0,
    }));

  describe('facets (AS-15 to AS-17)', () => {
    it('S32 AS-15: counts over all matches (not the page), top 20, four price keys in order, average rounded, sums equal the total', async () => {
      const seeds = widgets();
      await seedProducts(t, shopId, seeds);

      const body = await ok({ q: 'widget', facets: 'true', limit: 5 });

      expect(body.items).toHaveLength(5);
      expect(body.total).toEqual({ value: 30, exact: true });
      const facets = body.facets!;
      expect(facets.categories).toEqual(tally(seeds.map((s) => s.category)));
      expect(facets.brands).toEqual(tally(seeds.map((s) => s.brand)));
      expect(facets.brands.reduce((n, b) => n + b.count, 0)).toBe(28);
      expect(facets.priceRanges.map((r) => r.key)).toEqual(BANDS);
      expect(facets.priceRanges).toEqual(
        BANDS.map((key) => ({
          key,
          count: seeds.filter((s) => band(s.priceMinor) === key).length,
        })),
      );
      expect(facets.categories.reduce((n, c) => n + c.count, 0)).toBe(30);
      expect(facets.priceRanges.reduce((n, c) => n + c.count, 0)).toBe(30);
      const mean = seeds.reduce((n, s) => n + s.rating, 0) / seeds.length;
      expect(facets.avgRating).toBe(Math.round(mean * 100) / 100);
      expect(JSON.stringify(facets.avgRating).length).toBeLessThanOrEqual(5);
    });

    it('S32 AS-15: facets also describe a browse listing (no q)', async () => {
      await seedProducts(t, shopId, widgets().slice(0, 6));
      const body = await ok({ facets: 'true' });
      expect(body.mode).toBe('browse');
      expect(body.facets!.categories.reduce((n, c) => n + c.count, 0)).toBe(6);
    });

    it('S32 AS-16: a category selection keeps every category listed while brands and prices narrow to it', async () => {
      const seeds = widgets();
      await seedProducts(t, shopId, seeds);
      const shoes = seeds.filter((s) => s.category === 'shoes');

      const body = await ok({
        q: 'widget',
        category: 'shoes',
        facets: 'true',
      });

      expect(body.total.value).toBe(shoes.length);
      expect(body.items.every((i) => i.category === 'shoes')).toBe(true);
      expect(body.facets!.categories).toEqual(
        tally(seeds.map((s) => s.category)),
      );
      expect(body.facets!.brands).toEqual(tally(shoes.map((s) => s.brand)));
      expect(body.facets!.priceRanges).toEqual(
        BANDS.map((key) => ({
          key,
          count: shoes.filter((s) => band(s.priceMinor) === key).length,
        })),
      );
    });

    it('S32 AS-16: a brand selection does not collapse the brands facet and a price selection does not collapse the price bands', async () => {
      const seeds = widgets();
      await seedProducts(t, shopId, seeds);

      const byBrand = await ok({
        q: 'widget',
        brand: 'Acme',
        facets: 'true',
      });
      const acme = seeds.filter((s) => s.brand === 'Acme');
      expect(byBrand.total.value).toBe(acme.length);
      expect(byBrand.facets!.brands).toEqual(tally(seeds.map((s) => s.brand)));
      expect(byBrand.facets!.categories).toEqual(
        tally(acme.map((s) => s.category)),
      );

      const byPrice = await ok({
        q: 'widget',
        minPriceMinor: 5_000,
        maxPriceMinor: 9_999,
        facets: 'true',
      });
      const mid = seeds.filter(
        (s) => s.priceMinor >= 5_000 && s.priceMinor <= 9_999,
      );
      expect(byPrice.total.value).toBe(mid.length);
      expect(byPrice.facets!.priceRanges).toEqual(
        BANDS.map((key) => ({
          key,
          count: seeds.filter((s) => band(s.priceMinor) === key).length,
        })),
      );
      expect(byPrice.facets!.categories).toEqual(
        tally(mid.map((s) => s.category)),
      );
    });

    it('S32 AS-16: inStock and minRating apply to every facet', async () => {
      const seeds = widgets();
      await seedProducts(t, shopId, seeds);
      const kept = seeds.filter((s) => s.inStock !== false && s.rating >= 3);

      const body = await ok({
        q: 'widget',
        inStock: 'true',
        minRating: 3,
        category: 'bags',
        facets: 'true',
      });

      expect(body.facets!.categories).toEqual(
        tally(kept.map((s) => s.category)),
      );
      expect(body.facets!.priceRanges.reduce((n, r) => n + r.count, 0)).toBe(
        kept.filter((s) => s.category === 'bags').length,
      );
      const bags = kept.filter((s) => s.category === 'bags');
      expect(body.facets!.avgRating).toBe(
        Math.round(
          (bags.reduce((n, s) => n + s.rating, 0) / bags.length) * 100,
        ) / 100,
      );
    });

    it('S32 AS-17: no facets key unless facets=true; an empty result has empty lists, four zero bands and a null average; only the top 20 categories are kept', async () => {
      await seedProducts(
        t,
        shopId,
        Array.from({ length: 25 }, (_, i) => ({
          title: `Gadget ${i}`,
          category: `cat-${String(i).padStart(2, '0')}`,
          // cat-00 has three products, the rest one each: keys break the tie
          ...(i === 0 && { brand: 'Acme' }),
        })).concat(
          Array.from({ length: 2 }, (_, i) => ({
            title: `Gadget extra ${i}`,
            category: 'cat-00',
          })),
        ),
      );

      expect('facets' in (await ok({ q: 'gadget' }))).toBe(false);
      expect('facets' in (await ok({ q: 'gadget', facets: 'false' }))).toBe(
        false,
      );

      const body = await ok({ q: 'gadget', facets: 'true' });
      expect(body.facets!.categories).toHaveLength(20);
      expect(body.facets!.categories[0]).toEqual({ key: 'cat-00', count: 3 });
      expect(body.facets!.categories.slice(1).map((c) => c.key)).toEqual(
        Array.from(
          { length: 19 },
          (_, i) => `cat-${String(i + 1).padStart(2, '0')}`,
        ),
      );

      const empty = await ok({ q: 'zzzzzz', facets: 'true' });
      expect(empty.items).toEqual([]);
      expect(empty.facets).toEqual({
        categories: [],
        brands: [],
        priceRanges: BANDS.map((key) => ({ key, count: 0 })),
        avgRating: null,
      });
    });
  });

  describe('semantic mode (AS-18 to AS-21)', () => {
    beforeEach(() => {
      t.embeddings.concept('winter coat', 'parka');
      t.embeddings.concept('garden hose');
    });

    it('S32 AS-18: a paraphrase finds the parka first; no cursor; at most limit items', async () => {
      const [parka] = await seedProducts(t, shopId, [
        { title: 'Alpine Parka' },
        { title: 'Garden Hose 20 m' },
      ]);

      const body = await ok({ q: 'winter coat', semantic: 'true' });

      expect(body.mode).toBe('semantic');
      expect(body.items[0].id).toBe(parka);
      expect(body.nextCursor).toBeNull();
      expect(body.degraded).toEqual([]);
      expect(JSON.stringify(body)).not.toMatch(/embedding|vector/);
      expect(
        (await ok({ q: 'winter coat', semantic: 'true', limit: 1 })).items,
      ).toHaveLength(1);
      expect(performed().at(-1)?.payload).toMatchObject({ mode: 'semantic' });
    });

    it('S32 AS-18: filters apply before neighbours are chosen, so a filter never starves the result', async () => {
      const outerwear = Array.from({ length: 10 }, (_, i) => ({
        title: `Anorak ${i}`,
        category: 'outerwear',
      }));
      const garden = Array.from({ length: 50 }, (_, i) => ({
        title: `Garden Hose ${i}`,
        category: 'garden',
      }));
      const ids = await seedProducts(t, shopId, [...outerwear, ...garden]);

      const body = await ok({
        q: 'winter coat',
        semantic: 'true',
        category: 'outerwear',
        limit: 10,
      });

      expect(body.items.map((i) => i.id).sort()).toEqual(
        ids.slice(0, 10).sort(),
      );
    });

    it('S32 AS-19: semantic needs q; facets and cursor cannot be combined; no engine query is made for the refusals', async () => {
      await seedProducts(t, shopId, [{ title: 'Alpine Parka' }]);
      const engine = jest.spyOn(t.engine, 'search');
      engine.mockClear();

      for (const q of [{}, { q: '   ' }] as Record<string, string>[]) {
        const res = await search({ ...q, semantic: 'true' }).expect(422);
        expect(res.body.code).toBe('semantic_requires_query');
      }
      const withFacets = await search({
        q: 'parka',
        semantic: 'true',
        facets: 'true',
      }).expect(422);
      expect(withFacets.body.code).toBe('unsupported_combination');
      expect(withFacets.body.parameters).toEqual(
        expect.arrayContaining(['semantic', 'facets']),
      );
      const first = await ok({ q: 'parka', limit: 1 });
      void first;
      const withCursor = await search({
        q: 'parka',
        semantic: 'true',
        cursor: 'abc',
      }).expect(422);
      expect(withCursor.body.code).toBe('unsupported_combination');
      expect(withCursor.body.parameters).toEqual(
        expect.arrayContaining(['semantic', 'cursor']),
      );
      expect(engine).toHaveBeenCalledTimes(1); // only the lexical `first`
    });

    it('S32 AS-19: a product without a vector is absent from semantic results and present in lexical ones; hidden products never appear', async () => {
      const [parka] = await seedProducts(t, shopId, [
        { title: 'Alpine Parka' },
      ]);
      t.embeddings.failing = true;
      const [pending] = await seedProducts(t, shopId, [
        { title: 'Winter coat pending' },
      ]);
      t.embeddings.failing = false;
      const [archived] = await seedProducts(t, shopId, [
        { title: 'Archived parka', status: 'ARCHIVED' },
      ]);
      expect(await t.doc(pending)).toMatchObject({ embeddingPending: true });

      const semantic = await ok({ q: 'winter coat', semantic: 'true' });
      expect(semantic.items.map((i) => i.id)).toEqual([parka]);
      expect(semantic.items.map((i) => i.id)).not.toContain(archived);

      const lexical = await ok({ q: 'winter coat' });
      expect(lexical.items.map((i) => i.id)).toContain(pending);
    });

    it('S32 AS-20: a provider that exceeds the budget degrades to lexical results, labelled, counted and logged, never a 5xx', async () => {
      const [coat] = await seedProducts(t, shopId, [
        { title: 'Winter coat classic' },
      ]);
      t.embeddings.hold();
      const before = counter('search_degraded_total', {
        reason: 'semantic_unavailable',
      });
      const started = Date.now();

      const body = await ok({ q: 'winter coat', semantic: 'true' });

      expect(Date.now() - started).toBeLessThan(1_500);
      expect(body.mode).toBe('lexical');
      expect(body.degraded).toEqual(['semantic_unavailable']);
      expect(body.items.map((i) => i.id)).toContain(coat);
      expect(
        counter('search_degraded_total', { reason: 'semantic_unavailable' }),
      ).toBe(before + 1);
      expect(performed().at(-1)?.payload).toMatchObject({
        mode: 'lexical',
        degraded: ['semantic_unavailable'],
      });

      t.embeddings.release();
      t.embeddings.failing = true;
      const failed = await ok({ q: 'winter coat', semantic: 'true' });
      expect(failed.degraded).toEqual(['semantic_unavailable']);
    });

    it('S32 AS-21: a created product gets a vector (never serialised); a price-only update does not call the provider; a title change does; a provider failure leaves it pending until the backfill job', async () => {
      const productId = newId();
      await deliver(t.app).products(
        productEvent(
          'created',
          snapshot({ productId, shopId, title: 'Alpine Parka' }),
          t.clock.now(),
        ),
      );
      await t.refresh();
      const created = await t.doc(productId);
      expect(created!.embedding).toHaveLength(64);
      expect(JSON.stringify(await ok({ q: 'parka' }))).not.toMatch(/embedding/);

      const callsBefore = t.embeddings.calls.length;
      await deliver(t.app).products(
        productEvent(
          'updated',
          snapshot({
            productId,
            shopId,
            title: 'Alpine Parka',
            priceMinor: 2_000,
            productVersion: 2,
            changedFields: ['priceMinor', 'quantity'],
          }),
          t.clock.now(),
        ),
      );
      expect(t.embeddings.calls).toHaveLength(callsBefore);
      expect((await t.doc(productId))!.embedding).toEqual(created!.embedding);

      await deliver(t.app).products(
        productEvent(
          'updated',
          snapshot({
            productId,
            shopId,
            title: 'Garden Hose 20 m',
            productVersion: 3,
            changedFields: ['title'],
          }),
          t.clock.now(),
        ),
      );
      expect(t.embeddings.calls.length).toBeGreaterThan(callsBefore);
      expect((await t.doc(productId))!.embedding).not.toEqual(
        created!.embedding,
      );

      t.embeddings.failing = true;
      const failedId = newId();
      await deliver(t.app).products(
        productEvent(
          'created',
          snapshot({ productId: failedId, shopId, title: 'Winter coat late' }),
          t.clock.now(),
        ),
      );
      await t.refresh();
      expect(await t.doc(failedId)).toMatchObject({
        embeddingPending: true,
        embedding: null,
      });
      expect((await ok({ q: 'winter coat' })).items.map((i) => i.id)).toContain(
        failedId,
      );
      t.embeddings.failing = false; // the provider is back for the query; the product still has no vector
      expect(
        (await ok({ q: 'winter coat', semantic: 'true' })).items.map(
          (i) => i.id,
        ),
      ).not.toContain(failedId);

      const job = t.app.get(BackfillEmbeddingsJob, { strict: false });
      await expect(job.run()).resolves.toMatchObject({ filled: 1 });
      await expect(job.run()).resolves.toMatchObject({ filled: 0 });
      await t.refresh();
      expect(
        (await ok({ q: 'winter coat', semantic: 'true' })).items.map(
          (i) => i.id,
        ),
      ).toContain(failedId);
    });
  });
});
