import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  productBatchItemSchema,
  productPublicSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CacheService } from '@app/infrastructure/cache';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  ManualTimeSource,
  TimeSource,
} from '@app/infrastructure/rate-limit/time-source';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import {
  createProduct,
  recordStatements,
} from '@app/test/utils/catalog-fixtures';
import { ProductViewsJobs } from './infra/product-views.jobs';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  createShopWorld,
  stableProblem,
  type ShopWorld,
} from './testing/catalog-spec-kit';

const PRODUCT_SELECT = /FROM "Product" p/;
const VIEWS_PENDING = 'counter:{product-views}:pending';

describe('Public product read API', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;
  let redis: RedisService;
  let w: ShopWorld;

  const pendingViews = async (id: string) =>
    Number((await redis.client.hget(VIEWS_PENDING, id)) ?? 0);
  const entryKeys = async () => redis.client.keys('product:v2:*');
  const setShopState = (shopId: string, status: string) =>
    sequelize.query(
      `INSERT INTO "ProductShopState" ("shopId","status","shopVersion","updatedAt") VALUES (:shopId,:status,2,now())
       ON CONFLICT ("shopId") DO UPDATE SET "status" = :status`,
      { replacements: { shopId, status } },
    );

  beforeAll(async () => {
    t = await createCatalogApp();
    sequelize = t.app.get(Sequelize);
    redis = t.app.get(RedisService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('detail (AS-23 to AS-26)', () => {
    it('S05 AS-23: anyone reads a visible product: public view, ETag, Cache-Control, one cache entry, one view counted', async () => {
      const product = await createProduct(t.app, w.shop, {
        version: 3,
        quantity: 9,
        tags: ['winter'],
      });
      const res = await t.http().get(`/api/products/${product.id}`).expect(200);

      const view = productPublicSchema.parse(res.body);
      expect(view).toMatchObject({
        id: product.id,
        shopId: w.shop.id,
        version: 3,
        inStock: true,
        priceMinor: 10_000,
        currency: 'USD',
        tags: ['winter'],
      });
      expect(res.body).not.toHaveProperty('quantity');
      expect(res.body).not.toHaveProperty('status');
      expect(res.body).not.toHaveProperty('sellerId');
      expect(res.headers.etag).toBe(`W/"${product.id}-v3"`);
      expect(res.headers['cache-control']).toBe(
        'public, s-maxage=15, stale-while-revalidate=30',
      );
      expect(await entryKeys()).toEqual([`product:v2:${product.id}`]);
      await waitUntil(async () => (await pendingViews(product.id)) === 1);
    });

    it('S05 AS-24: If-None-Match with the current ETag is 304 with an empty body and counts a view; after an update the old tag gets 200 and a new tag', async () => {
      const product = await createProduct(t.app, w.shop, { version: 1 });
      const first = await t
        .http()
        .get(`/api/products/${product.id}`)
        .expect(200);
      const etag = first.headers.etag as string;

      const cached = await t
        .http()
        .get(`/api/products/${product.id}`)
        .set('If-None-Match', etag)
        .expect(304);
      expect(cached.text).toBe('');
      expect(cached.headers.etag).toBe(etag);
      await waitUntil(async () => (await pendingViews(product.id)) === 2);

      await t
        .as(w.staff)
        .patch(`/api/shops/${w.shop.id}/products/${product.id}`)
        .send({ expectedVersion: 1, priceMinor: 5_000 })
        .expect(200);
      const fresh = await t
        .http()
        .get(`/api/products/${product.id}`)
        .set('If-None-Match', etag)
        .expect(200);
      expect(fresh.headers.etag).toBe(`W/"${product.id}-v2"`);
      expect(fresh.body.priceMinor).toBe(5_000);
    });

    it('S05 AS-25: archived, sandbox and closed-shop products and unknown ids all answer the same 404 with s-maxage=5 and count no view', async () => {
      const archived = await createProduct(t.app, w.shop, {
        status: 'ARCHIVED',
      });
      const sandbox = await createProduct(t.app, w.shop, { isSandbox: true });
      const suspended = await createShopWorld(t);
      const deleting = await createShopWorld(t);
      const deleted = await createShopWorld(t);
      const inSuspended = await createProduct(t.app, suspended.shop);
      const inDeleting = await createProduct(t.app, deleting.shop);
      const inDeleted = await createProduct(t.app, deleted.shop);
      await setShopState(suspended.shop.id, 'SUSPENDED');
      await setShopState(deleting.shop.id, 'DELETING');
      await setShopState(deleted.shop.id, 'DELETED');
      const visible = await createProduct(t.app, w.shop);
      const unknown = randomUUID();

      const baseline = await t
        .http()
        .get(`/api/products/${unknown}`)
        .expect(404);
      expect(baseline.body.code).toBe('product_not_found');
      expect(baseline.headers['cache-control']).toBe('public, s-maxage=5');

      for (const hidden of [
        archived,
        sandbox,
        inSuspended,
        inDeleting,
        inDeleted,
      ]) {
        const res = await t
          .http()
          .get(`/api/products/${hidden.id}`)
          .expect(404);
        expect(stableProblem(res.body)).toEqual(stableProblem(baseline.body));
        expect(res.headers['cache-control']).toBe('public, s-maxage=5');
        expect(await pendingViews(hidden.id)).toBe(0);
      }
      expect(await pendingViews(unknown)).toBe(0);

      await t.http().get(`/api/products/${visible.id}`).expect(200);
    });

    it('S05 AS-66: 5 served reads are counted, the flush adds 5 to viewCount, empties the pending counter and leaves version and updatedAt alone', async () => {
      const product = await createProduct(t.app, w.shop, { version: 3 });
      const row = () =>
        sequelize.query<{
          viewCount: string;
          version: number;
          updatedAt: Date;
        }>(
          `SELECT "viewCount", "version", "updatedAt" FROM "Product" WHERE id = :id`,
          { replacements: { id: product.id }, type: QueryTypes.SELECT },
        );
      const [before] = await row();

      for (let i = 0; i < 5; i++) {
        await t.http().get(`/api/products/${product.id}`).expect(200);
      }
      await waitUntil(async () => (await pendingViews(product.id)) === 5);

      const jobs = new ProductViewsJobs(redis, {} as JobsService, sequelize);
      await jobs.flush();

      const [after] = await row();
      expect(Number(after.viewCount)).toBe(Number(before.viewCount) + 5);
      expect(after.version).toBe(before.version);
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(await pendingViews(product.id)).toBe(0);
    });

    it.each([['not-a-uuid'], ['x'.repeat(300)], ['12345']])(
      'S05 AS-26: the malformed id %s is 400 with zero database statements and no cache access',
      async (id) => {
        const getOrLoad = jest.spyOn(CacheService.prototype, 'getOrLoad');
        const { result, statements } = await recordStatements(t.app, () =>
          t.http().get(`/api/products/${id}`),
        );
        expect(result.status).toBe(400);
        expect(result.body.code).toBe('validation_failed');
        expect(statements).toEqual([]);
        expect(getOrLoad).not.toHaveBeenCalled();
        expect(await entryKeys()).toEqual([]);
      },
    );
  });

  describe('archive and restore seen by the public (AS-16, AS-17)', () => {
    it('S05 AS-16: right after archive the public detail is 404 and the batch route returns null for the product', async () => {
      const product = await createProduct(t.app, w.shop, { version: 4 });
      await t.http().get(`/api/products/${product.id}`).expect(200);
      await t
        .as(w.staff)
        .post(`/api/shops/${w.shop.id}/products/${product.id}/archive`)
        .send({ expectedVersion: 4 })
        .expect(200);

      await t.http().get(`/api/products/${product.id}`).expect(404);
      const batch = await t
        .http()
        .get(`/api/batch/products?ids=${product.id}`)
        .expect(200);
      expect(batch.body).toEqual([null]);
    });

    it('S05 AS-17: right after restore the public detail is 200 again, although a not-found was cached', async () => {
      const product = await createProduct(t.app, w.shop, {
        version: 5,
        status: 'ARCHIVED',
      });
      await t.http().get(`/api/products/${product.id}`).expect(404);
      await t
        .as(w.staff)
        .post(`/api/shops/${w.shop.id}/products/${product.id}/restore`)
        .send({ expectedVersion: 5 })
        .expect(200);
      const res = await t.http().get(`/api/products/${product.id}`).expect(200);
      expect(res.body.version).toBe(6);
    });
  });

  describe('negative caching (AS-31)', () => {
    it('S05 AS-31: an id that does not exist is looked up once per 10 s; after the negative lifetime the database is asked again', async () => {
      const unknown = randomUUID();
      const { statements } = await recordStatements(
        t.app,
        async () => {
          await t.http().get(`/api/products/${unknown}`).expect(404);
          await t.http().get(`/api/products/${unknown}`).expect(404);
        },
        PRODUCT_SELECT,
      );
      expect(statements).toHaveLength(1);

      t.clock.set(new Date(t.clock.now().getTime() + 13_000));
      const later = await recordStatements(
        t.app,
        () => t.http().get(`/api/products/${unknown}`).expect(404),
        PRODUCT_SELECT,
      );
      expect(later.statements).toHaveLength(1);
    });

    it('S05 AS-31: a negative entry is gone once the product is created by the write path', async () => {
      const id = randomUUID();
      await t.http().get(`/api/products/${id}`).expect(404);
      const created = await t
        .as(w.staff)
        .post(`/api/shops/${w.shop.id}/products`)
        .send({ title: 'T', brand: 'B', category: 'c', priceMinor: 100 })
        .expect(201);
      await t.http().get(`/api/products/${created.body.id}`).expect(200);
    });
  });

  describe('batch read for the BFF (AS-38)', () => {
    it('S05 AS-38: ids come back in request order with null for invisible ones, duplicates repeat, headers are set', async () => {
      const a = await createProduct(t.app, w.shop, { title: 'A', quantity: 0 });
      const c = await createProduct(t.app, w.shop, { title: 'C' });
      const archived = await createProduct(t.app, w.shop, {
        status: 'ARCHIVED',
      });
      const sandbox = await createProduct(t.app, w.shop, { isSandbox: true });
      const closed = await createShopWorld(t);
      const inClosed = await createProduct(t.app, closed.shop);
      await setShopState(closed.shop.id, 'SUSPENDED');
      const unknown = randomUUID();

      const ids = [
        a.id,
        unknown,
        c.id,
        archived.id,
        a.id,
        sandbox.id,
        inClosed.id,
      ];
      const res = await t
        .http()
        .get(`/api/batch/products?ids=${ids.join(',')}`)
        .expect(200);

      expect(res.headers['cache-control']).toBe('public, max-age=10');
      const body = res.body as unknown[];
      expect(body).toHaveLength(7);
      expect(
        body.map((item) => (item ? (item as { id: string }).id : null)),
      ).toEqual([a.id, null, c.id, null, a.id, null, null]);
      expect(productBatchItemSchema.parse(body[0])).toMatchObject({
        id: a.id,
        shopId: w.shop.id,
        title: 'A',
        priceMinor: 10_000,
        currency: 'USD',
        inStock: false,
        category: 'electronics',
        rating: 0,
      });
    });

    it('S05 AS-38: 100 cold ids are loaded with one statement; a second call is served from the cache', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 100; i++)
        ids.push((await createProduct(t.app, w.shop)).id);
      const cold = await recordStatements(
        t.app,
        () =>
          t
            .http()
            .get(`/api/batch/products?ids=${ids.join(',')}`)
            .expect(200),
        PRODUCT_SELECT,
      );
      expect(cold.statements).toHaveLength(1);
      expect((cold.result.body as unknown[]).every(Boolean)).toBe(true);

      const warm = await recordStatements(
        t.app,
        () =>
          t
            .http()
            .get(`/api/batch/products?ids=${ids.join(',')}`)
            .expect(200),
        PRODUCT_SELECT,
      );
      expect(warm.statements).toHaveLength(0);
    });

    it('S05 AS-38: more than 100 ids, none and a malformed id are 400 validation_failed', async () => {
      const many = Array.from({ length: 101 }, () => randomUUID()).join(',');
      for (const query of [
        `ids=${many}`,
        'ids=',
        '',
        `ids=${randomUUID()},nope`,
      ]) {
        const res = await t
          .http()
          .get(`/api/batch/products?${query}`)
          .expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
    });
  });
});

describe('Public product read limits', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;

  beforeAll(async () => {
    // The limiter reads the store's wall clock unless told otherwise. Pin it to the start of a window so a run that
    // crosses a real minute boundary cannot let the weighted previous window decay and admit more than 600.
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
    t = await createCatalogApp({
      overrides: [
        { provide: TimeSource, useValue: new ManualTimeSource(windowStart) },
      ],
    });
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S05 AS-32: 700 reads of random ids from one address: 600 answer 404 with at most one lookup per id, the rest 429 with Retry-After', async () => {
    const ids = Array.from({ length: 700 }, () => randomUUID());
    const { result, statements } = await recordStatements(
      t.app,
      async () => {
        const out: Array<{ status: number; retry?: string }> = [];
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = await Promise.all(
            ids
              .slice(i, i + 50)
              .map((id) => t.http().get(`/api/products/${id}`)),
          );
          out.push(
            ...chunk.map((res) => ({
              status: res.status,
              retry: res.headers['retry-after'] as string | undefined,
            })),
          );
        }
        return out;
      },
      PRODUCT_SELECT,
    );
    const ok = result.filter((r) => r.status === 404);
    const limited = result.filter((r) => r.status === 429);
    expect(ok).toHaveLength(600);
    expect(limited).toHaveLength(100);
    expect(limited.every((r) => Number(r.retry) > 0)).toBe(true);
    expect(statements.length).toBeLessThanOrEqual(600);
    await sequelize.query('SELECT 1', { type: QueryTypes.SELECT });
  });

  it('S05 AS-38: the 121st batch request of one address within the minute is 429', async () => {
    const id = randomUUID();
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++)
      statuses.push(
        (await t.http().get(`/api/batch/products?ids=${id}`)).status,
      );
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
  });
});

describe('Public product read with the shared store down', () => {
  let proxy: TcpFaultProxy;
  let t: CatalogTestApp;
  let w: ShopWorld;

  beforeAll(async () => {
    const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    proxy = await TcpFaultProxy.start({
      host: url.hostname,
      port: Number(url.port || 6379),
    });
    t = await createCatalogApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
    });
  });
  afterAll(async () => {
    proxy.mode = 'pass';
    await t.close();
    await proxy.close();
  });

  it('S05 AS-33: when the limiter store is unreachable the read is served (fail open) and the failure is counted', async () => {
    await t.reset();
    w = await createShopWorld(t);
    const product = await createProduct(t.app, w.shop);
    const unavailable = () =>
      MetricsRegistry.value('rate_limit_store_unavailable_total', {
        policy: 'catalog.product-read.ip',
        fail_mode: 'open',
      }) ?? 0;
    const before = unavailable();

    proxy.mode = 'refuse';
    proxy.sever();
    await waitUntil(
      async () => unavailable() > before,
      10_000,
      async () => {
        await t.http().get(`/api/products/${product.id}`);
      },
    );
    const res = await t.http().get(`/api/products/${product.id}`).expect(200);
    expect(productPublicSchema.parse(res.body).id).toBe(product.id);
    expect(unavailable()).toBeGreaterThan(before);
    proxy.mode = 'pass';
  });
});

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
  poke?: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    if (poke) await poke();
    await new Promise((r) => setTimeout(r, 50));
  }
}
