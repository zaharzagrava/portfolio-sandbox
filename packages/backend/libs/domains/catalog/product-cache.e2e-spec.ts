import { Sequelize } from 'sequelize-typescript';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CacheService } from '@app/infrastructure/cache';
import { RANDOM_SOURCE } from '@app/infrastructure/cache/random-source';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createProduct,
  createProducts,
  recordStatements,
} from '@app/test/utils/catalog-fixtures';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  createShopWorld,
  holdTableLock,
  type ShopWorld,
} from './testing/catalog-spec-kit';

const PRODUCT_SELECT = /FROM "Product" p/;
const get = (t: CatalogTestApp, id: string) =>
  t.http().get(`/api/products/${id}`);

const redisUrl = () => process.env.REDIS_URL ?? 'redis://localhost:6400/0';
const proxyTo = async (url: string) => {
  const target = new URL(url);
  return TcpFaultProxy.start({
    host: target.hostname,
    port: Number(target.port || 6379),
  });
};

const commandCalls = async (redis: RedisService, command: string) => {
  const info = await redis.client.info('commandstats');
  const match = new RegExp(`cmdstat_${command}:calls=(\\d+)`).exec(info);
  return match ? Number(match[1]) : 0;
};

describe('Product cache behaviour', () => {
  let t: CatalogTestApp;
  let w: ShopWorld;
  let redis: RedisService;

  beforeAll(async () => {
    t = await createCatalogApp();
    redis = t.app.get(RedisService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
  });

  it('S05 AS-27: a miss loads the row with one statement and stores it; the next read is a hit with zero statements and an equal body; a write makes the next read a miss again', async () => {
    const product = await createProduct(t.app, w.shop, { version: 2 });
    const outcome = (name: string) =>
      MetricsRegistry.value('catalog_product_read_total', { outcome: name }) ??
      0;
    const missBefore = outcome('miss');
    const hitBefore = outcome('hit');

    const first = await recordStatements(
      t.app,
      () => get(t, product.id),
      PRODUCT_SELECT,
    );
    const second = await recordStatements(
      t.app,
      () => get(t, product.id),
      PRODUCT_SELECT,
    );
    expect(first.statements).toHaveLength(1);
    expect(second.statements).toHaveLength(0);
    expect(second.result.body).toEqual(first.result.body);
    expect(outcome('miss')).toBe(missBefore + 1);
    expect(outcome('hit')).toBe(hitBefore + 1);

    await t
      .as(w.staff)
      .patch(`/api/shops/${w.shop.id}/products/${product.id}`)
      .send({ expectedVersion: 2, priceMinor: 7_000 })
      .expect(200);
    expect(await redis.client.exists(`product:v2:${product.id}`)).toBe(0);
    const third = await recordStatements(
      t.app,
      () => get(t, product.id),
      PRODUCT_SELECT,
    );
    expect(third.statements).toHaveLength(1);
    expect(third.result.body.priceMinor).toBe(7_000);
  });

  it('S05 AS-28: 200 products read for the first time at once: every entry has a lifetime, all within +-10% of the base lifetime, spread over at least 10 distinct values', async () => {
    const products = await createProducts(t.app, w.shop, 200);
    for (let i = 0; i < products.length; i += 50)
      await Promise.all(
        products.slice(i, i + 50).map((p) => get(t, p.id).expect(200)),
      );

    const ttls = await Promise.all(
      products.map((p) => redis.client.pttl(`product:v2:${p.id}`)),
    );
    expect(ttls.every((ttl) => ttl > 0)).toBe(true);
    const base = 60_000 + 300_000;
    for (const ttl of ttls) {
      expect(ttl).toBeGreaterThanOrEqual(base * 0.9);
      expect(ttl).toBeLessThanOrEqual(base * 1.1);
    }
    expect(
      new Set(ttls.map((ttl) => Math.round(ttl / 100))).size,
    ).toBeGreaterThanOrEqual(10);
  });

  it('S05 AS-29: 100 concurrent first reads of one product on one instance cost one statement', async () => {
    const product = await createProduct(t.app, w.shop);
    const { result, statements } = await recordStatements(
      t.app,
      () => Promise.all(Array.from({ length: 100 }, () => get(t, product.id))),
      PRODUCT_SELECT,
    );
    expect(result.every((res) => res.status === 200)).toBe(true);
    expect(new Set(result.map((res) => JSON.stringify(res.body))).size).toBe(1);
    expect(statements).toHaveLength(1);
  });

  it('S05 AS-30: past the fresh lifetime 100 concurrent reads are answered at once from the stored value with one background refresh; beyond the stale window the read is a miss', async () => {
    const product = await createProduct(t.app, w.shop, { priceMinor: 1_000 });
    await get(t, product.id).expect(200);
    // The row changes without any invalidation: only a refresh can bring the new price in.
    await t.app
      .get(Sequelize)
      .query(
        `UPDATE "Product" SET "priceMinor" = 2000, "version" = "version" + 1 WHERE "id" = :id`,
        { replacements: { id: product.id } },
      );
    // 67 s: past the longest jittered fresh lifetime (60 s +10%), inside the shortest stale window.
    t.clock.set(new Date(t.clock.now().getTime() + 67_000));

    // While a real table lock keeps the refresh waiting, nobody can have seen the new row: every answer is the stored
    // value and none of them waited for the database.
    const stale = await recordStatements(
      t.app,
      async () => {
        const lock = await holdTableLock(t.app, 'Product');
        let answers;
        try {
          const started = Date.now();
          answers = await Promise.all(
            Array.from({ length: 100 }, () => get(t, product.id)),
          );
          expect(Date.now() - started).toBeLessThan(1_500);
        } finally {
          await lock.release();
        }
        await waitFor(
          async () => (await get(t, product.id)).body.priceMinor === 2_000,
          { timeoutMs: 5_000, description: 'refreshed value' },
        );
        return answers;
      },
      PRODUCT_SELECT,
    );
    expect(stale.result.every((res) => res.status === 200)).toBe(true);
    expect(stale.result.every((res) => res.body.priceMinor === 1_000)).toBe(
      true,
    );
    expect(stale.statements).toHaveLength(1);

    // The refresh stored a new entry at +67 s; beyond its stale window (60 s + 300 s, +-10%) the read is a miss.
    t.clock.set(new Date(t.clock.now().getTime() + 400_000));
    const miss = await recordStatements(
      t.app,
      () => get(t, product.id),
      PRODUCT_SELECT,
    );
    expect(miss.statements).toHaveLength(1);
    expect(miss.result.body.priceMinor).toBe(2_000);
  });

  it('S05 AS-37: a maximum-size product is cached in at most 32 KiB and only per-product keys exist, however it is read', async () => {
    const product = await createProduct(t.app, w.shop, {
      title: '😀'.repeat(200),
      description: '😀'.repeat(4_000),
      brand: '😀'.repeat(100),
      category: '😀'.repeat(100),
      tags: Array.from(
        { length: 32 },
        (_, i) => '😀'.repeat(46) + String(i).padStart(4, '0'),
      ),
    });
    await createProducts(t.app, w.shop, 20);
    await get(t, product.id).expect(200);
    await t.http().get(`/api/batch/products?ids=${product.id}`).expect(200);
    await t
      .as(w.viewer)
      .get(`/api/shops/${w.shop.id}/products?limit=20`)
      .expect(200);

    const bytes = await redis.client.strlen(`product:v2:${product.id}`);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(32 * 1024);
    const keys = (await redis.client.keys('product:*')).filter(
      (key) => !key.includes(':min'),
    );
    expect(keys.every((key) => /^product:v2:[0-9a-f-]{36}$/.test(key))).toBe(
      true,
    );
  });

  it('S05 AS-34: a write answers 200 while the shared cache is down (the limiter and the database are up), and a versioned invalidation brings the new price in afterwards', async () => {
    // Only the cache's own connection runs through the proxy, so the write path's other dependencies stay healthy.
    const proxy = await proxyTo(redisUrl());
    const proxied = urlConfig(`redis://127.0.0.1:${proxy.port}/0`);
    const cacheRedis = new RedisService(proxied);
    const cache = new CacheService(cacheRedis, proxied);
    await cache.onModuleInit();
    const down = await createCatalogApp({
      overrides: [{ provide: CacheService, useValue: cache }],
    });
    try {
      const world = await createShopWorld(down);
      const seeded = await createProduct(down.app, world.shop, { version: 1 });
      await get(down, seeded.id).expect(200);
      proxy.mode = 'refuse';
      proxy.sever();
      await waitFor(async () => cacheRedis.client.status !== 'ready', {
        timeoutMs: 5_000,
        description: 'cache client noticed the cut',
      });

      const res = await down
        .as(world.staff)
        .patch(`/api/shops/${world.shop.id}/products/${seeded.id}`)
        .send({ expectedVersion: 1, priceMinor: 4_321 })
        .expect(200);
      expect(res.body.version).toBe(2);

      proxy.mode = 'pass';
      await waitFor(async () => (await cacheRedis.client.ping()) === 'PONG', {
        timeoutMs: 15_000,
        description: 'cache reconnected',
      });
      // The writer's delete failed while the cache was down; the event-driven invalidator repairs it (AS-40).
      await cache.invalidateIfOlder(`product:v2:${seeded.id}`, 2);
      const fresh = await get(down, seeded.id).expect(200);
      expect(fresh.body.priceMinor).toBe(4_321);
    } finally {
      proxy.mode = 'pass';
      await down.close();
      await cache.onModuleDestroy();
      await proxy.close();
    }
  });
});

describe('Product cache behaviour on two instances', () => {
  let a: CatalogTestApp;
  let b: CatalogTestApp;
  let w: ShopWorld;

  beforeAll(async () => {
    a = await createCatalogApp();
    b = await createCatalogApp();
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });
  beforeEach(async () => {
    await a.reset();
    w = await createShopWorld(a);
  });

  it('S05 AS-29: 100 concurrent first reads spread over two instances cost at most two statements', async () => {
    const product = await createProduct(a.app, w.shop);
    const onA = recordStatements(
      a.app,
      () => Promise.all(Array.from({ length: 50 }, () => get(a, product.id))),
      PRODUCT_SELECT,
    );
    const onB = recordStatements(
      b.app,
      () => Promise.all(Array.from({ length: 50 }, () => get(b, product.id))),
      PRODUCT_SELECT,
    );
    const [ra, rb] = await Promise.all([onA, onB]);
    expect(
      [...ra.result, ...rb.result].every((res) => res.status === 200),
    ).toBe(true);
    expect(ra.statements.length + rb.statements.length).toBeLessThanOrEqual(2);
  });
});

describe('Product cache hot keys on two instances', () => {
  let a: CatalogTestApp;
  let b: CatalogTestApp;
  let w: ShopWorld;
  const always = { provide: RANDOM_SOURCE, useValue: { next: () => 0 } };

  beforeAll(async () => {
    a = await createCatalogApp({ overrides: [always] });
    b = await createCatalogApp({ overrides: [always] });
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });
  beforeEach(async () => {
    await a.reset();
    w = await createShopWorld(a);
  });

  it('S05 AS-36: a hot product is served from process memory for at most one second, and an update reaches the memory of every instance within a second', async () => {
    const product = await createProduct(a.app, w.shop, {
      version: 1,
      priceMinor: 1_000,
    });
    const key = `product:v2:${product.id}`;
    const redis = a.app.get(RedisService);
    const cacheA = a.app.get(CacheService);

    for (let i = 0; i < 200; i += 50)
      await Promise.all(Array.from({ length: 50 }, () => get(a, product.id)));
    await get(b, product.id).expect(200);
    // The detector promotes a key for the next window; windows roll on the injected clock.
    a.clock.set(new Date(a.clock.now().getTime() + 10_001));
    await get(a, product.id).expect(200);
    await get(a, product.id).expect(200);
    expect(cacheA.l1Has(key)).toBe(true);

    const served = (outcome: string) =>
      MetricsRegistry.value('cache_requests_total', {
        namespace: 'product',
        outcome,
      }) ?? 0;
    const l1Before = served('l1');
    const l2Before = served('l2');
    await Promise.all(Array.from({ length: 100 }, () => get(a, product.id)));
    expect(served('l1') - l1Before).toBe(100);
    expect(served('l2')).toBe(l2Before);

    await a
      .as(w.staff)
      .patch(`/api/shops/${w.shop.id}/products/${product.id}`)
      .send({ expectedVersion: 1, priceMinor: 2_000 })
      .expect(200);
    await waitFor(
      async () =>
        (await get(a, product.id)).body.priceMinor === 2_000 &&
        (await get(b, product.id)).body.priceMinor === 2_000,
      {
        timeoutMs: 1_000,
        intervalMs: 25,
        description: 'both instances see the new price',
      },
    );

    // The in-process copy lives at most one second.
    a.clock.set(new Date(a.clock.now().getTime() + 1_200));
    const afterExpiry = await commandCalls(redis, 'get');
    await get(a, product.id).expect(200);
    expect(await commandCalls(redis, 'get')).toBeGreaterThan(afterExpiry);
  });
});

describe('Product reads with the shared cache down', () => {
  let proxy: TcpFaultProxy;
  let t: CatalogTestApp;
  let w: ShopWorld;

  beforeAll(async () => {
    proxy = await proxyTo(redisUrl());
    t = await createCatalogApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
    });
  });
  afterAll(async () => {
    proxy.mode = 'pass';
    await t.close();
    await proxy.close();
  });
  beforeEach(async () => {
    proxy.mode = 'pass';
    await t.reset();
    w = await createShopWorld(t);
  });

  const degraded = () =>
    MetricsRegistry.value('cache_requests_total', {
      namespace: 'product',
      outcome: 'degraded',
    }) ?? 0;

  it.each(['refuse', 'hang'] as const)(
    'S05 AS-34: with the cache %s-ing, reads answer 200 from the database within 2 s with the same body, no view is counted, and the cache is repopulated when it returns',
    async (mode) => {
      const product = await createProduct(t.app, w.shop, { version: 3 });
      const warm = await get(t, product.id).expect(200);
      await t.app.get(RedisService).client.del(`product:v2:${product.id}`);
      const before = degraded();

      proxy.mode = mode;
      proxy.sever();
      const started = Date.now();
      const res = await get(t, product.id);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(warm.body);
      expect(degraded()).toBeGreaterThan(before);

      proxy.mode = 'pass';
      await waitFor(
        async () => (await t.app.get(RedisService).client.ping()) === 'PONG',
        {
          timeoutMs: 15_000,
          description: 'store reconnected',
        },
      );
      const pending = await t.app
        .get(RedisService)
        .client.hget('counter:{product-views}:pending', product.id);
      expect(Number(pending ?? 0)).toBe(1); // only the warm read before the cut
      await waitFor(
        async () => {
          await get(t, product.id);
          return (
            (await t.app
              .get(RedisService)
              .client.exists(`product:v2:${product.id}`)) === 1
          );
        },
        { timeoutMs: 15_000, description: 'entry repopulated' },
      );
    },
  );

  it('S05 AS-34: SC-005 every read of existing products succeeds within 2 s while the cache is completely unavailable', async () => {
    const products = await createProducts(t.app, w.shop, 20);
    proxy.mode = 'refuse';
    proxy.sever();
    const results = await Promise.all(
      products.map(async (p) => {
        const started = Date.now();
        const res = await get(t, p.id);
        return { status: res.status, ms: Date.now() - started };
      }),
    );
    expect(results.every((r) => r.status === 200 && r.ms < 2_000)).toBe(true);
  });
});

describe('Product reads with the database down or locked', () => {
  let proxy: TcpFaultProxy;
  let t: CatalogTestApp;
  let w: ShopWorld;

  beforeAll(async () => {
    proxy = await TcpFaultProxy.start({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5400),
    });
    t = await createCatalogApp({
      env: { DB_HOST: '127.0.0.1', DB_PORT: String(proxy.port) },
    });
  });
  afterAll(async () => {
    proxy.mode = 'pass';
    await t.close();
    await proxy.close();
  });
  beforeEach(async () => {
    proxy.mode = 'pass';
    await t.reset();
    w = await createShopWorld(t);
  });

  it('S05 AS-35: with the database unreachable a warm product is still served, also inside its stale window; a cold one is a generic 503 problem document with a requestId', async () => {
    const warm = await createProduct(t.app, w.shop, { title: 'Warm one' });
    const cold = await createProduct(t.app, w.shop, { title: 'Cold one' });
    await get(t, warm.id).expect(200);

    proxy.mode = 'refuse';
    proxy.sever();
    await get(t, warm.id).expect(200);
    t.clock.set(new Date(t.clock.now().getTime() + 61_000));
    const stale = await get(t, warm.id);
    expect(stale.status).toBe(200);
    expect(stale.body.title).toBe('Warm one');

    const failed = await get(t, cold.id);
    expect(failed.status).toBe(503);
    expect(failed.headers['content-type']).toMatch(/problem\+json/);
    expect(failed.body.requestId).toBeTruthy();
    expect(JSON.stringify(failed.body)).not.toMatch(
      /select|"Product"|127\.0\.0\.1|ECONN|postgres|sequelize/i,
    );
  });

  it('S05 AS-84: a table lock makes a cold read fail with 503 within 3 s while a warm product is still served', async () => {
    const warm = await createProduct(t.app, w.shop);
    const cold = await createProduct(t.app, w.shop);
    await get(t, warm.id).expect(200);

    const lock = await holdTableLock(t.app, 'Product');
    try {
      const started = Date.now();
      const failed = await get(t, cold.id);
      expect(failed.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect((await get(t, warm.id)).status).toBe(200);
    } finally {
      await lock.release();
    }
    await get(t, cold.id).expect(200);
  });
});

function urlConfig(url: string): ApiConfigService {
  return { get: () => url } as unknown as ApiConfigService;
}
