import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { v4 } from 'uuid';
import { inParallel, waitFor } from '@app/test/utils/async-helpers';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { AllExceptionsFilter } from '@app/common/exceptions-filter/exceptions-filter';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import { HealthModule } from '@app/infrastructure/health/health.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import {
  CacheInstance,
  createCacheInstance,
} from './testing/cache-fixture.module';
import {
  FixtureStore,
  HttpCachingFixtureModule,
} from './testing/http-caching-fixture';
import { WriteBehindCounter } from './write-behind-counter';

@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    RequestContextModule,
    ErrorUtilsModule,
    HealthModule,
    HttpCachingFixtureModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
class CacheE2eHttpModule {}

/**
 * Smoke of the cache toolkit against the real test Redis. The earlier copy of this file imported the catalog's
 * `ProductModule` (a cross-domain import); the product route cases now live in the catalog's own
 * `product-read.e2e-spec.ts` and the HTTP cases here use the toolkit's neutral fixture.
 */
describe('Cache toolkit (e2e, real Redis)', () => {
  let one: CacheInstance;
  let two: CacheInstance;

  beforeAll(async () => {
    one = await createCacheInstance();
    two = await createCacheInstance();
  });

  afterAll(async () => {
    await Promise.all([one.close(), two.close()]);
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
      one.cache.getOrLoad(k, loader, { ttlMs: 60_000 }),
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
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 150));
      return 'v';
    };

    await Promise.all([
      one.cache.getOrLoad(k, loader, { ttlMs: 60_000 }),
      two.cache.getOrLoad(k, loader, { ttlMs: 60_000 }),
    ]);
    expect(calls).toBe(1);
  });

  it('stale-while-revalidate: after expiry the stale value is served immediately and refreshed once in the background', async () => {
    const k = key();
    let version = 1;
    const loader = async () => ({ version: version });
    await one.cache.getOrLoad(k, loader, { ttlMs: 200, swrMs: 60_000 });

    version = 2;
    one.clock.advance(300); // soft-expired, still within SWR (the toolkit reads the injected clock)

    const served = await one.cache.getOrLoad(k, loader, {
      ttlMs: 200,
      swrMs: 60_000,
    });
    expect(served).toEqual({ version: 1 }); // no wait for the origin

    await waitFor(
      async () =>
        (
          await one.cache.getOrLoad(k, loader, {
            ttlMs: 60_000,
            swrMs: 60_000,
          })
        )?.version === 2,
      { description: 'background refresh' },
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
        await one.cache.getOrLoad(k, loader, {
          ttlMs: 60_000,
          negativeTtlMs: 10_000,
        }),
      ).toBeNull();
    expect(calls).toBe(1);
  });

  it('invalidate drops L1 copies on other instances via pub/sub', async () => {
    const k = key();
    let value = 'old';
    const loader = async () => value;
    await two.cache.getOrLoad(k, loader, { ttlMs: 60_000, l1: 'always' });

    value = 'new';
    await one.cache.invalidate([k]);

    await waitFor(
      async () =>
        (await two.cache.getOrLoad(k, loader, {
          ttlMs: 60_000,
          l1: 'always',
        })) === 'new',
      { description: 'L1 invalidated on the other pod' },
    );
  });

  it('write-behind counter: drain takes everything atomically; restore puts it back', async () => {
    const counter = new WriteBehindCounter(one.redis, `spec-${v4()}`);
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

  describe('GET /api/fixture/docs/:id (neutral fixture replacing the product route cases)', () => {
    let app: INestApplication;
    let store: FixtureStore;
    const tenant = { 'x-tenant': 'tenant-a' };

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CacheE2eHttpModule],
      }).compile();
      app = moduleRef.createNestApplication();
      configureHttpApp(app, {
        useStructuredLogger: false,
        processHandlers: false,
      });
      await app.init();
      store = app.get(FixtureStore);
    });

    afterAll(async () => {
      await app.close();
    });

    it('returns the document with an ETag and answers 304 on If-None-Match', async () => {
      store.put({ id: 'c1', version: 4, tenant: 'tenant-a', title: 'Phone' });

      const first = await request(app.getHttpServer())
        .get('/api/fixture/docs/c1')
        .set(tenant)
        .expect(200);
      expect(first.body.title).toBe('Phone');
      expect(first.headers.etag).toBe('W/"c1-v4"');

      const repeat = await request(app.getHttpServer())
        .get('/api/fixture/docs/c1')
        .set(tenant)
        .set('If-None-Match', first.headers.etag)
        .expect(304);
      expect(repeat.text).toBe('');
    });

    it('unknown id → 404 Problem Details', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/fixture/docs/${v4()}`)
        .set(tenant)
        .expect(404);
      expect(res.headers['content-type']).toContain('problem+json');
    });
  });
});
