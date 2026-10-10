import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { ProductQueryService } from '@app/domains/catalog';
import { ShopQueryService } from '@app/domains/tenancy';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  countRedisCommands,
  createTrendingApp,
  deleteTrendingTopics,
  sleep,
  storedEvent,
  windowOf,
  type TrendingTestApp,
} from './testing/trending.fixtures';

const CACHEABLE = 'public, max-age=30, s-maxage=30';
const ws = windowOf;

describe('Trending products API', () => {
  let t: TrendingTestApp;

  beforeAll(async () => {
    // Redis goes through a fault proxy that passes everything until a spec flips its mode (AS-14)
    t = await createTrendingApp({ redisProxy: true });
  });
  afterAll(async () => {
    await t.close();
    await deleteTrendingTopics();
  });
  beforeEach(async () => {
    await t.clean();
  });
  afterEach(() => jest.restoreAllMocks());

  const get = (query: Record<string, string> = {}) =>
    t.http().get('/api/trending').query(query);
  const ids = (body: { items: { productId: string }[] }) =>
    body.items.map((i) => i.productId);

  describe('US1 - what is trending in the last hour', () => {
    it('S35 AS-01: dataset T through the real consumer answers the weighted ranking with the cacheable header and no state change', async () => {
      const d = await t.seedDatasetT();
      const windows = ['12:00', '12:01', '12:02', '12:03'].map(ws);
      // aggregates, merge records and seen keys; the ranking cache entry a read may add is not part of the stored state
      const stored = async () =>
        (await t.keys()).filter((k) => !k.startsWith('trending:v1:'));
      const stateBefore = {
        keys: await stored(),
        aggregates: await Promise.all(
          windows.map((w) => t.aggregate('all', w)),
        ),
      };

      const res = await get({ category: 'audio' }).expect(200);

      expect(res.headers['cache-control']).toBe(CACHEABLE);
      expect(res.headers['set-cookie']).toBeUndefined();
      const body = await t.trending({ category: 'audio' });
      expect(res.body).toEqual(body);
      expect(body).toEqual({
        category: 'audio',
        windowMinutes: 60,
        generatedAt: t.clock.now().toISOString(),
        items: [
          {
            rank: 1,
            productId: d.B.id,
            title: 'Headphones B',
            priceMinor: 9_900,
            currency: 'USD',
            category: 'audio',
            score: 35,
          },
          {
            rank: 2,
            productId: d.A.id,
            title: 'Speaker A',
            priceMinor: 4_900,
            currency: 'USD',
            category: 'audio',
            score: 30,
          },
          {
            rank: 3,
            productId: d.C.id,
            title: 'Cable C',
            priceMinor: 900,
            currency: 'USD',
            category: 'audio',
            score: 3,
          },
        ],
      });
      // a GET changes no state
      expect(await stored()).toEqual(stateBefore.keys);
      expect(
        await Promise.all(windows.map((w) => t.aggregate('all', w))),
      ).toEqual(stateBefore.aggregates);
    });

    it('S35 AS-02: no category and category=all are identical; items carry the catalog category', async () => {
      const d = await t.seedDatasetT();
      const omitted = await t.trending();
      const all = await t.trending({ category: 'all' });
      expect(omitted).toEqual(all);
      expect(all.category).toBe('all');
      expect(all.items.map((i) => [i.productId, i.score, i.category])).toEqual([
        [d.B.id, 35, 'audio'],
        [d.A.id, 30, 'audio'],
        [d.D.id, 22, 'cameras'],
        [d.C.id, 3, 'audio'],
      ]);
      expect(
        (await t.trending({ category: 'cameras' })).items.map(
          (i) => i.productId,
        ),
      ).toEqual([d.D.id]);
    });

    it('S35 AS-41: the response the home page renders lists the dataset T products in order with priceMinor, currency and the product id for the link; an empty window is a 200 with no items (the catalogue fallback)', async () => {
      const d = await t.seedDatasetT();
      const body = await t.trending({ category: 'all' });
      expect(
        body.items.map((i) => [i.title, i.priceMinor, i.currency, i.productId]),
      ).toEqual([
        ['Headphones B', 9_900, 'USD', d.B.id],
        ['Speaker A', 4_900, 'USD', d.A.id],
        ['Camera D', expect.any(Number), 'USD', d.D.id],
        ['Cable C', 900, 'USD', d.C.id],
      ]);
      const empty = await get({ category: 'no-such-category' }).expect(200);
      expect(empty.body.items).toEqual([]);
    });

    it('S35 AS-03: limit defaults to 20, accepts 1 and 20, returns the best N, and nothing is clamped', async () => {
      const d = await t.seedDatasetT();
      expect(ids(await t.trending({ limit: '2' }))).toEqual([d.B.id, d.A.id]);
      expect(await t.trending({ limit: '1' })).toMatchObject({
        items: [{ productId: d.B.id }],
      });
      expect((await t.trending({ limit: '20' })).items).toHaveLength(4);
      for (const bad of ['0', '21', '-1', 'abc', '2.5', '']) {
        const res = await get({ limit: bad }).expect(400);
        expect(t.problem(res.body).code).toBe('validation_failed');
        expect(res.body.errors.map((e: { field: string }) => e.field)).toEqual([
          'limit',
        ]);
      }
    });

    it('S35 AS-04: invalid category and unknown parameters answer 400 problem+json and consult no store', async () => {
      await t.seedDatasetT();
      const counter = countRedisCommands();
      const products = jest.spyOn(
        ProductQueryService.prototype,
        'getProductsByIds',
      );
      const shops = jest.spyOn(ShopQueryService.prototype, 'getShopsByIds');
      try {
        const bad: [Record<string, string>, string][] = [
          [{ category: '' }, 'category'],
          [{ category: 'a'.repeat(41) }, 'category'],
          [{ category: 'Audio' }, 'category'],
          [{ category: 'a b' }, 'category'],
          [{ category: 'a:b' }, 'category'],
          [{ category: '{x}' }, 'category'],
          [{ category: 'a*' }, 'category'],
          [{ category: 'é' }, 'category'],
          [{ foo: '1' }, 'foo'],
        ];
        for (const [query, field] of bad) {
          const res = await get(query).expect(400);
          const p = t.problem(res.body);
          expect(p.code).toBe('validation_failed');
          expect(res.body.status).toBe(400);
          expect(
            res.body.errors.map((e: { field: string }) => e.field),
          ).toContain(field);
          expect(res.headers['content-type']).toMatch(
            /application\/problem\+json/,
          );
          expect(res.headers['cache-control']).toBe('no-store');
        }
        // 40 characters is fine and is never truncated
        await get({ category: 'a'.repeat(40) }).expect(200);
        expect(counter.unions).toBe(1);
        expect(products).not.toHaveBeenCalled();
        expect(shops).not.toHaveBeenCalled();
      } finally {
        counter.stop();
      }
    });

    it('S35 AS-06: no traffic or an unknown category is a 200 with empty items, never a 404', async () => {
      await t.seedDatasetT();
      for (const category of ['garden', 'no-such-category']) {
        const res = await get({ category }).expect(200);
        expect(res.body).toEqual({
          category,
          windowMinutes: 60,
          generatedAt: t.clock.now().toISOString(),
          items: [],
        });
        expect(res.headers['cache-control']).toBe(CACHEABLE);
      }
    });

    it('S35 AS-07: every caller gets the same body; an invalid token is ignored; nothing identifying leaks into headers, logs or labels', async () => {
      await t.seedDatasetT();
      const buyer = await t.newUser();
      const seller = await t.newUser();
      await createShop(t.app, seller);
      const logged: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation(
            (...args: unknown[]) => void logged.push(JSON.stringify(args)),
          );

      const responses = [
        await get({ category: 'audio' }),
        await t.as(buyer).get('/api/trending?category=audio'),
        await t.as(seller).get('/api/trending?category=audio'),
        await t
          .http()
          .get('/api/trending?category=audio')
          .set('Authorization', 'Bearer not.a.valid.token'),
      ];
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual(responses[0].body);
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(res.headers['cache-control']).toBe(CACHEABLE);
        expect(res.headers.vary ?? '').not.toMatch(/cookie|authorization/i);
      }
      const text = logged.join('\n');
      for (const secret of [
        buyer.id,
        buyer.email,
        seller.id,
        'not.a.valid.token',
        buyer.bearer,
      ])
        expect(text).not.toContain(secret);
      for (const name of [
        'trending_requests_total',
        'trending_ranking_cache_total',
        'trending_dependency_failures_total',
      ])
        for (const labels of MetricsRegistry.labelSets(name))
          expect(
            Object.keys(labels).every((k) =>
              ['outcome', 'result', 'dependency'].includes(k),
            ),
          ).toBe(true);
    });

    it('S35 AS-08: the 301st request in a minute is a 429 rate_limited with Retry-After and no-store; a downed limiter store still answers', async () => {
      // the limiter is per address (S50 covers other addresses; a spec cannot change the address of a request)
      await t.seedDatasetT();
      let last;
      for (let i = 0; i < 300; i++) last = await get({ category: 'audio' });
      expect(last!.status).toBe(200);

      const limited = await get({ category: 'audio' }).expect(429);
      expect(t.problem(limited.body).code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(limited.headers['cache-control']).toBe('no-store');

      for (const command of ['evalsha', 'eval', 'script'] as const)
        jest
          .spyOn(t.redis.client, command)
          .mockRejectedValue(new Error('limiter store down'));
      await get({ category: 'audio' }).expect(200);
      await get({ category: 'audio' }).expect(200);
    });

    it('S35 AS-09: 400 and 429 are never cached', async () => {
      const bad = await get({ limit: '0' }).expect(400);
      expect(bad.headers['cache-control']).toBe('no-store');
      expect(bad.headers['content-type']).toMatch(/application\/problem\+json/);
    });

    it('S35 AS-15: fifty concurrent cold reads share one aggregate read; a different category has its own; limits share one ranking', async () => {
      await t.seedDatasetT(); // reads nothing: the ranking is not cached yet
      const counter = countRedisCommands();
      try {
        const results = await Promise.all([
          ...Array.from({ length: 50 }, () => get()),
          get({ category: 'cameras' }),
        ]);
        expect(results.map((r) => r.status)).toEqual(Array(51).fill(200));
        for (const r of results.slice(0, 50))
          expect(r.body).toEqual(results[0].body);
        expect(counter.unions).toBe(2);

        counter.reset();
        await get({ limit: '2' }).expect(200);
        await get({ limit: '20' }).expect(200);
        expect(counter.unions).toBe(0); // both served from the ranking cached just above
      } finally {
        counter.stop();
      }
    });
  });

  describe('US2 - only products a buyer can buy, in the category asked', () => {
    /** Ten candidates N1..N10 by score; their state is set by the caller. */
    const ranking = (productIds: string[]) =>
      productIds.map((productId, i) => ({ productId, score: 100 - i }));

    it('S35 AS-10: hidden candidates are dropped and replaced from the pool, with one batched lookup of each kind', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const suspended = await createShop(t.app, owner, { status: 'SUSPENDED' });
      const n = [
        await createProduct(t.app, shop, { quantity: 0, title: 'N1' }),
        await createProduct(t.app, shop, { status: 'ARCHIVED', title: 'N2' }),
        await createProduct(t.app, shop, { isSandbox: true, title: 'N3' }),
        await createProduct(t.app, suspended, { title: 'N4' }),
      ];
      const ghost = randomUUID(); // N5: deleted from the catalog
      const visible = await Promise.all(
        [6, 7, 8, 9, 10].map((i) =>
          createProduct(t.app, shop, { title: `N${i}` }),
        ),
      );
      await t.seedRanking(
        ranking([...n.map((p) => p.id), ghost, ...visible.map((p) => p.id)]),
      );
      const products = jest.spyOn(
        ProductQueryService.prototype,
        'getProductsByIds',
      );
      const shops = jest.spyOn(ShopQueryService.prototype, 'getShopsByIds');

      const body = await t.trending({ limit: '4' });

      expect(body.items.map((i) => [i.rank, i.title])).toEqual([
        [1, 'N6'],
        [2, 'N7'],
        [3, 'N8'],
        [4, 'N9'],
      ]);
      expect(body.items.map((i) => i.score)).toEqual([95, 94, 93, 92]);
      // the pool is min(3 x 4, 60) of the ten candidates, looked up in one batch each
      expect(products).toHaveBeenCalledTimes(1);
      expect(products.mock.calls[0][0]).toHaveLength(10);
      expect(shops).toHaveBeenCalledTimes(1);
      expect(shops.mock.calls[0][0]).toHaveLength(2);
    });

    it('S35 AS-11: the catalog category is authoritative: a product counted under a wrong category is absent from it', async () => {
      const d = await t.seedProducts();
      await t.produce([
        // a client claims the camera D is audio
        ...Array.from({ length: 5 }, () =>
          storedEvent({ productId: d.D.id, category: 'audio', at: '12:00:10' }),
        ),
        ...Array.from({ length: 3 }, () =>
          storedEvent({ productId: d.B.id, category: 'audio', at: '12:00:20' }),
        ),
        ...Array.from({ length: 2 }, () =>
          storedEvent({
            productId: d.D.id,
            category: 'cameras',
            at: '12:00:30',
          }),
        ),
        storedEvent({
          productId: randomUUID(),
          category: 'audio',
          at: '12:30:00',
        }),
      ]);
      await t.settle();
      t.clock.set(new Date('2026-10-10T12:31:00Z'));

      const audio = await t.trending({ category: 'audio' });
      expect(ids(audio)).toEqual([d.B.id]);
      const all = await t.trending({ category: 'all' });
      expect(all.items.find((i) => i.productId === d.D.id)).toMatchObject({
        category: 'cameras',
        score: 7,
      });
      const cameras = await t.trending({ category: 'cameras' });
      expect(cameras.items).toEqual([
        expect.objectContaining({ productId: d.D.id, score: 2 }),
      ]);
    });

    it('S35 AS-12: fewer than asked are not padded, and all hidden is an empty list', async () => {
      const d = await t.seedDatasetT();
      expect(
        (await t.trending({ limit: '20', category: 'audio' })).items,
      ).toHaveLength(3);
      await t.app
        .get(Sequelize)
        .query(`UPDATE "Product" SET "quantity" = 0 WHERE "shopId" = :shop`, {
          replacements: { shop: d.shopId },
        });
      const res = await get({ category: 'audio' }).expect(200);
      expect(res.body.items).toEqual([]);
      expect(res.headers['cache-control']).toBe(CACHEABLE);
    });

    it('S35 AS-13: a stock or price change shows at origin at once, while the ranking is still cached', async () => {
      const d = await t.seedDatasetT();
      const first = await t.trending({ category: 'audio' });
      expect(ids(first)).toEqual([d.B.id, d.A.id, d.C.id]);
      const db = t.app.get(Sequelize);
      await db.query(`UPDATE "Product" SET "quantity" = 0 WHERE "id" = :id`, {
        replacements: { id: d.B.id },
      });
      await db.query(
        `UPDATE "Product" SET "priceMinor" = 5100 WHERE "id" = :id`,
        { replacements: { id: d.A.id } },
      );
      const counter = countRedisCommands();
      try {
        const second = await t.trending({ category: 'audio' });
        expect(ids(second)).toEqual([d.A.id, d.C.id]);
        expect(second.items[0]).toMatchObject({
          rank: 1,
          priceMinor: 5_100,
          currency: 'USD',
        });
        expect(counter.unions).toBe(0); // the ranking came from the cache, the facts from the origin
      } finally {
        counter.stop();
      }
    });

    describe('AS-14 - a dependency fails or is too slow', () => {
      const expect503 = async (query: Record<string, string> = {}) => {
        const res = await get(query).expect(503);
        const p = t.problem(res.body);
        expect(p.code).toBe('trending_unavailable');
        expect(res.headers['retry-after']).toBe('5');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['content-type']).toMatch(
          /application\/problem\+json/,
        );
        expect(res.body.items).toBeUndefined();
        return res;
      };
      const failures = (dependency: string) =>
        MetricsRegistry.value('trending_dependency_failures_total', {
          dependency,
        }) ?? 0;

      it('S35 AS-14: the aggregate store down or slower than 100 ms is a 503, not a list', async () => {
        await t.seedDatasetT();
        const proxy = t.redisProxy!;
        const before = failures('aggregate') + failures('cache');
        proxy.mode = 'refuse';
        await expect503();
        proxy.mode = 'pass';
        await sleep(300); // the client reconnects
        proxy.delayMs = 150;
        await expect503({ category: 'audio' });
        proxy.delayMs = 0;
        expect(
          failures('aggregate') + failures('cache'),
        ).toBeGreaterThanOrEqual(before + 2);
        await sleep(300);
        await get({ category: 'audio' }).expect(200); // back to normal
      });

      it('S35 AS-14: the product lookup failing or slower than 100 ms is a 503 and is not retried', async () => {
        await t.seedDatasetT();
        const before = failures('product');
        const failing = jest
          .spyOn(ProductQueryService.prototype, 'getProductsByIds')
          .mockRejectedValue(new Error('catalog down'));
        await expect503();
        expect(failing).toHaveBeenCalledTimes(1);
        failing.mockImplementation(
          (() =>
            new Promise((r) => setTimeout(() => r(new Map()), 250))) as never,
        );
        await expect503({ category: 'audio' });
        expect(failing).toHaveBeenCalledTimes(2);
        expect(failures('product') - before).toBe(2);
      });

      it('S35 AS-14: the shop lookup failing or slower than 50 ms is a 503 and is not retried', async () => {
        await t.seedDatasetT();
        const before = failures('shop');
        const failing = jest
          .spyOn(ShopQueryService.prototype, 'getShopsByIds')
          .mockRejectedValue(new Error('tenancy down'));
        await expect503();
        expect(failing).toHaveBeenCalledTimes(1);
        failing.mockImplementation(
          (() =>
            new Promise((r) => setTimeout(() => r(new Map()), 120))) as never,
        );
        await expect503({ category: 'audio' });
        expect(failing).toHaveBeenCalledTimes(2);
        expect(failures('shop') - before).toBe(2);
      });

      it('S35 AS-14: a failing cache is a 503, never a list built without it', async () => {
        await t.seedDatasetT();
        const before = failures('cache') + failures('aggregate');
        jest
          .spyOn(t.app.get(CacheService, { strict: false }), 'getOrLoad')
          .mockRejectedValue(new Error('cache down'));
        await expect503();
        expect(failures('cache') + failures('aggregate')).toBe(before + 1);
      });
    });
  });
});
