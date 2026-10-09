import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v4, v7 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { inParallel, waitFor } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ApiConfigService } from '@app/common/config';
import { ProductModule } from '@app/domains/catalog';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { CacheModule } from './cache.module';
import { CacheService } from './cache.service';
import { WriteBehindCounter } from './write-behind-counter';

/** SD-34 against the real test Redis/Postgres. */
describe('Cache toolkit (e2e, real Redis)', () => {
  let app: INestApplication;
  let cache: CacheService;
  let redis: RedisService;
  let seedsService: SeedsService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [CacheModule, ProductModule, RateLimitModule, SeedsModule],
      { stores: ['redis'] },
    );
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    cache = app.get(CacheService);
    redis = app.get(RedisService);
    seedsService = app.get(SeedsService);
  });

  afterAll(async () => {
    await app.close();
  });

  const key = () => `spec:cache:${v4()}`;

  it('stampede: 200 concurrent misses on one key → the loader runs once', async () => {
    const k = key();
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 100)); // slow origin
      return { value: 42 };
    };

    const results = await inParallel(200, () =>
      cache.getOrLoad(k, loader, { ttlMs: 60_000 }),
    );

    expect(calls).toBe(1);
    expect(
      results.every(
        (r) =>
          r.status === 'fulfilled' &&
          (r.value as { value: number }).value === 42,
      ),
    ).toBe(true);
  });

  it('cross-instance: a second CacheService (another pod) waits for the lock holder instead of recomputing', async () => {
    const k = key();
    const otherPod = new CacheService(redis, app.get(ApiConfigService));
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 150));
      return 'v';
    };

    await Promise.all([
      cache.getOrLoad(k, loader, { ttlMs: 60_000 }),
      otherPod.getOrLoad(k, loader, { ttlMs: 60_000 }),
    ]);
    expect(calls).toBe(1);
  });

  it('stale-while-revalidate: after expiry the stale value is served immediately and refreshed once in the background', async () => {
    const k = key();
    let version = 1;
    const loader = async () => ({ version: version });
    await cache.getOrLoad(k, loader, { ttlMs: 200, swrMs: 60_000 });

    version = 2;
    await new Promise((r) => setTimeout(r, 300)); // soft-expired, still within SWR

    const served = await cache.getOrLoad(k, loader, {
      ttlMs: 200,
      swrMs: 60_000,
    });
    expect(served).toEqual({ version: 1 }); // no wait for the origin

    await waitFor(
      async () =>
        (await cache.getOrLoad(k, loader, { ttlMs: 60_000, swrMs: 60_000 }))
          ?.version === 2,
      {
        description: 'background refresh',
      },
    );
  });

  it('negative caching: a missing record hits the origin once per negative TTL', async () => {
    const k = key();
    let calls = 0;
    const loader = async () => {
      calls++;
      return null;
    };
    for (let i = 0; i < 5; i++)
      expect(
        await cache.getOrLoad(k, loader, {
          ttlMs: 60_000,
          negativeTtlMs: 10_000,
        }),
      ).toBeNull();
    expect(calls).toBe(1);
  });

  it('invalidate drops L1 copies on other instances via pub/sub', async () => {
    const k = key();
    const otherPod = new CacheService(redis, app.get(ApiConfigService));
    await otherPod.onModuleInit();

    let value = 'old';
    const loader = async () => value;
    await otherPod.getOrLoad(k, loader, { ttlMs: 60_000, l1: 'always' });

    value = 'new';
    await cache.invalidate([k]);

    await waitFor(
      async () =>
        (await otherPod.getOrLoad(k, loader, {
          ttlMs: 60_000,
          l1: 'always',
        })) === 'new',
      {
        description: 'L1 invalidated on the other pod',
      },
    );
    await otherPod.onModuleDestroy();
  });

  it('write-behind counter: drain takes everything atomically; restore puts it back', async () => {
    const counter = new WriteBehindCounter(redis, `spec-${v4()}`);
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        counter.increment(i % 2 ? 'a' : 'b'),
      ),
    );

    const first = await counter.drain();
    expect(Object.fromEntries(first)).toEqual({ a: 50, b: 50 });
    expect((await counter.drain()).size).toBe(0);

    await counter.restore(first);
    expect(Object.fromEntries(await counter.drain())).toEqual({ a: 50, b: 50 });
  });

  describe('GET /api/products/:id', () => {
    beforeEach(async () => {
      await seedsService.clean();
    });

    it('returns the product with an ETag, 304 on If-None-Match, counts the view write-behind', async () => {
      const [product] = await seedsService.createTreelike([
        { __type__: TableName.Product, title: 'iPhone 17 Pro' },
      ]);

      const first = await request(app.getHttpServer())
        .get(`/api/products/${product.id}`)
        .expect(200);
      expect(first.body.title).toBe('iPhone 17 Pro');
      expect(first.headers.etag).toBe(`W/"${product.id}-v${product.version}"`);

      await request(app.getHttpServer())
        .get(`/api/products/${product.id}`)
        .set('If-None-Match', first.headers.etag)
        .expect(304);

      const views = await redis.client.hget('wb:{product-views}', product.id);
      expect(Number(views)).toBe(2);
    });

    it('unknown id → 404 Problem Details, and the miss is negatively cached', async () => {
      const id = v7();
      await request(app.getHttpServer()).get(`/api/products/${id}`).expect(404);
      expect(await redis.client.exists(`product:v1:${id}`)).toBe(1);
    });
  });
});
