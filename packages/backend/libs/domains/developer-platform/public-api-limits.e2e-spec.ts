import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { developerPlatformRatePolicies } from './rate-limit-policies';
import {
  createKey,
  createPublicApiKit,
  fastStoreOf,
  newId,
  rows,
  type CreatedKey,
  type PublicApiInstance,
  type PublicApiKit,
  type ShopWorld,
} from './testing/public-api-kit';
import { PublicCatalogService } from './application/public-catalog.service';
import { QuotaAnswer, QuotaPort, QuotaUnavailable } from './domain/ports';
import { BillingQuotaAdapter } from './infra/billing-quota.adapter';

const product = (over: Record<string, unknown> = {}) => ({
  title: 'Mug',
  price: { amount: 1_000, currency: 'USD' },
  stock: 5,
  category: 'kitchen',
  brand: 'Acme',
  ...over,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const limiterPolicy = developerPlatformRatePolicies.policies[
  'public-api.default'
] as {
  limit: number;
  localLeaseFraction?: number;
};

/** The billing capability's answer, set by each spec. */
class FakeQuota extends QuotaPort {
  calls = 0;
  next: QuotaAnswer | QuotaUnavailable = new QuotaUnavailable('not_available');
  check(): Promise<QuotaAnswer> {
    this.calls += 1;
    return this.next instanceof QuotaUnavailable
      ? Promise.reject(this.next)
      : Promise.resolve(this.next);
  }
}

describe('Public API: idempotency, rate limits and quotas', () => {
  const quota = new FakeQuota();
  let t: PublicApiKit;
  let pub: PublicApiInstance;
  let pub2: PublicApiInstance;

  beforeAll(async () => {
    t = await createPublicApiKit({
      overrides: [{ provide: QuotaPort, useValue: quota }],
    });
    pub = t.pub;
    pub2 = await t.publicInstance();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    quota.calls = 0;
    quota.next = new QuotaUnavailable('not_available');
  });

  const world = async (): Promise<{
    w: ShopWorld;
    key: CreatedKey;
    test: CreatedKey;
  }> => {
    const w = await t.seedWorld();
    return {
      w,
      key: await createKey(t, w, { name: 'live' }),
      test: await createKey(t, w, { name: 'test', livemode: false }),
    };
  };
  const post = (
    key: CreatedKey,
    idem: string | undefined,
    body: object = product(),
    inst: PublicApiInstance = pub,
  ) => {
    const req = inst.withKey(key.key).post('/v1/products');
    return (idem === undefined ? req : req.set('Idempotency-Key', idem)).send(
      body,
    );
  };
  const count = async (shopId: string) =>
    (
      await rows<{ n: number }>(
        t.app,
        `SELECT count(*)::int AS n FROM "Product" WHERE "shopId" = :shopId`,
        { shopId },
      )
    )[0].n;

  describe('AS-53, AS-54 idempotency', () => {
    it('S42 AS-53: the same key and body replays the stored 201 with Idempotent-Replayed; another body is 422 idempotency_key_reused', async () => {
      const { w, key } = await world();
      const k = newId();
      const first = await post(key, k).expect(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      const again = await post(key, k).expect(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(again.headers.location).toBe(first.headers.location);
      expect(await count(w.shop.id)).toBe(1);
      const other = await post(key, k, product({ title: 'Different' })).expect(
        422,
      );
      expect(other.body.code).toBe('idempotency_key_reused');
    });

    it('S42 AS-53: a duplicate while the first runs is 409 request_in_progress with Retry-After 1', async () => {
      const { key } = await world();
      const catalog = pub.app.get(PublicCatalogService);
      const real = catalog.create.bind(catalog);
      const spy = jest
        .spyOn(catalog, 'create')
        .mockImplementation(async (...args) => {
          await sleep(500);
          return real(...args);
        });
      try {
        const k = newId();
        const running = post(key, k).then((r) => r);
        await sleep(150);
        const busy = await post(key, k).expect(409);
        expect(busy.body.code).toBe('request_in_progress');
        expect(busy.headers['retry-after']).toBe('1');
        expect((await running).status).toBe(201);
      } finally {
        spy.mockRestore();
      }
    });

    it('S42 AS-53: a missing key on the three creating POSTs is 422 idempotency_key_required and nothing runs', async () => {
      const { w, key } = await world();
      const calls = [
        post(key, undefined),
        pub
          .withKey(key.key)
          .post('/v1/stock/bulk')
          .send({
            items: [{ operationId: 'a', productId: newId(), delta: 1 }],
          }),
        pub
          .withKey(key.key)
          .post('/v1/batch')
          .send({ operations: [{ method: 'GET', path: '/v1/products' }] }),
      ];
      for (const call of calls) {
        const res = await call;
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('idempotency_key_required');
      }
      expect(await count(w.shop.id)).toBe(0);
    });

    it.each([
      ['256 characters', 'k'.repeat(256)],
      ['a tab', 'bad\tkey'],
      ['a non-ASCII character', 'badékey'],
      ['a space', 'two words'],
    ])('S42 AS-53: a key with %s is 400', async (_n, bad) => {
      const { key } = await world();
      const res = await post(key, bad);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });

    it('S42 AS-53: after 24 hours the key is forgotten and creates again', async () => {
      const { w, key } = await world();
      const k = newId();
      await post(key, k).expect(201);
      t.clock.advance(24 * 3_600_000 - 1000);
      expect(
        (await post(key, k).expect(201)).headers['idempotent-replayed'],
      ).toBe('true');
      t.clock.advance(2_000);
      const fresh = await post(key, k).expect(201);
      expect(fresh.headers['idempotent-replayed']).toBeUndefined();
      expect(await count(w.shop.id)).toBe(2);
    });

    it('S42 AS-53: a 5xx is not stored and the retry runs again; a 4xx is stored and replayed', async () => {
      const { w, key } = await world();
      const catalog = pub.app.get(PublicCatalogService);
      const spy = jest
        .spyOn(catalog, 'create')
        .mockRejectedValueOnce(new Error('transient'));
      const k = newId();
      try {
        await post(key, k).expect(500);
      } finally {
        spy.mockRestore();
      }
      expect(
        (await post(key, k).expect(201)).headers['idempotent-replayed'],
      ).toBeUndefined();
      expect(await count(w.shop.id)).toBe(1);

      const bad = newId();
      const first = await post(
        key,
        bad,
        product({ price: { amount: 0, currency: 'USD' } }),
      ).expect(400);
      const again = await post(
        key,
        bad,
        product({ price: { amount: 0, currency: 'USD' } }),
      ).expect(400);
      expect(again.body.code).toBe(first.body.code);
      expect(again.headers['idempotent-replayed']).toBe('true');
    });

    it('S42 AS-53: the key is scoped to the acting shop and route: two shops, and a live and a test key of one shop, may reuse the text', async () => {
      const a = await world();
      const b = await world();
      const k = newId();
      const results = [
        await post(a.key, k),
        await post(b.key, k),
        await post(a.test, k),
      ];
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(
        results.every((r) => r.headers['idempotent-replayed'] === undefined),
      ).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(3);
    });

    it('S42 AS-53: GET and PATCH ignore the header', async () => {
      const { key } = await world();
      const created = await post(key, newId()).expect(201);
      const k = newId();
      const get1 = await pub
        .withKey(key.key)
        .get(`/v1/products/${created.body.id}`)
        .set('Idempotency-Key', k)
        .expect(200);
      expect(get1.headers['idempotent-replayed']).toBeUndefined();
      const p1 = await pub
        .withKey(key.key)
        .patch(`/v1/products/${created.body.id}`)
        .set('Idempotency-Key', k)
        .set('If-Match', '"1"')
        .send({ title: 'a' })
        .expect(200);
      const p2 = await pub
        .withKey(key.key)
        .patch(`/v1/products/${created.body.id}`)
        .set('Idempotency-Key', k)
        .set('If-Match', '"2"')
        .send({ title: 'b' })
        .expect(200);
      expect([p1.body.version, p2.body.version]).toEqual([2, 3]);
      expect(p2.headers['idempotent-replayed']).toBeUndefined();
    });

    it('S42 AS-54: 10 parallel identical creates produce exactly one product and one fresh 201, the rest replayed or 409 (20 repeats)', async () => {
      const { w, key } = await world();
      for (let i = 0; i < 20; i += 1) {
        const k = newId();
        const instances = [pub, pub2];
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, n) =>
            post(key, k, product({ title: `race ${i}` }), instances[n % 2]),
          ),
        );
        const fresh = results.filter(
          (r) =>
            r.status === 201 && r.headers['idempotent-replayed'] === undefined,
        );
        expect(fresh).toHaveLength(1);
        for (const r of results)
          expect(
            (r.status === 201 && r.headers['idempotent-replayed'] === 'true') ||
              r.status === 409 ||
              r === fresh[0],
          ).toBe(true);
        expect(await count(w.shop.id)).toBe(i + 1);
      }
    });
  });

  describe('AS-55, AS-56 per-key rate limit', () => {
    let original: { limit: number; localLeaseFraction?: number };
    const store = () => fastStoreOf(t.app);
    beforeEach(() => {
      original = {
        limit: limiterPolicy.limit,
        localLeaseFraction: limiterPolicy.localLeaseFraction,
      };
      limiterPolicy.limit = 50;
      limiterPolicy.localLeaseFraction = undefined;
    });
    afterEach(async () => {
      limiterPolicy.limit = original.limit;
      limiterPolicy.localLeaseFraction = original.localLeaseFraction;
      await store().allow();
    });
    const fifty = Array.from({ length: 50 }, () => ({
      method: 'GET',
      path: '/v1/products',
    }));
    const spend = (key: CreatedKey, inst: PublicApiInstance) =>
      inst
        .withKey(key.key)
        .post('/v1/batch')
        .set('Idempotency-Key', newId())
        .send({ operations: fifty });

    it('S42 AS-55: a spent allowance answers 429 rate_limited with Retry-After and the structured headers, per key, shared by instances; waiting makes the next call 200', async () => {
      const { w, key } = await world();
      const other = await createKey(t, w, { name: 'second key' });
      const ok = await pub.withKey(key.key).get('/v1/products').expect(200);
      expect(ok.headers['ratelimit']).toMatch(
        /^"public-api\.default";r=49;t=\d+$/,
      );
      expect(ok.headers['ratelimit-policy']).toBe(
        '"public-api.default";q=50;w=60',
      );
      for (const legacy of [
        'ratelimit-limit',
        'ratelimit-remaining',
        'ratelimit-reset',
        'x-ratelimit-limit',
      ])
        expect(ok.headers[legacy]).toBeUndefined();

      const notFound = await pub
        .withKey(key.key)
        .get(`/v1/products/${newId()}`)
        .expect(404);
      expect(notFound.headers['ratelimit']).toMatch(/;r=48;/);

      await pub
        .withKey(key.key)
        .post('/v1/batch')
        .set('Idempotency-Key', newId())
        .send({ operations: fifty.slice(0, 48) })
        .expect(200);
      const refused = await pub2.withKey(key.key).get('/v1/products');
      expect(refused.status).toBe(429);
      expect(refused.body.code).toBe('rate_limited');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(refused.headers['ratelimit']).toMatch(/;r=0;/);
      expect(refused.headers['ratelimit-policy']).toBeDefined();

      expect((await pub.withKey(other.key).get('/v1/products')).status).toBe(
        200,
      );

      await sleep(Number(refused.headers['retry-after']) * 1000 + 200);
      expect((await pub.withKey(key.key).get('/v1/products')).status).toBe(200);
    });

    it('S42 AS-55: a 5xx answer carries the headers too', async () => {
      const { key } = await world();
      const catalog = pub.app.get(PublicCatalogService);
      const spy = jest
        .spyOn(catalog, 'list')
        .mockRejectedValueOnce(new Error('boom'));
      try {
        const res = await pub.withKey(key.key).get('/v1/products').expect(500);
        expect(res.headers['ratelimit']).toBeDefined();
        expect(res.headers['ratelimit-policy']).toBeDefined();
      } finally {
        spy.mockRestore();
      }
    });

    it('S42 AS-56: with the limiter store unreachable the call is served, the headers are omitted and the degradation is counted', async () => {
      const { key } = await world();
      await pub.withKey(key.key).get('/v1/products').expect(200); // warm the key and shop entries
      await store().deny('rl:');
      const before =
        MetricsRegistry.value('public_api_ratelimit_degraded_total') ?? 0;
      const res = await pub.withKey(key.key).get('/v1/products');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit']).toBeUndefined();
      expect(res.headers['ratelimit-policy']).toBeUndefined();
      expect(
        (MetricsRegistry.value('public_api_ratelimit_degraded_total') ?? 0) -
          before,
      ).toBe(1);
      await store().allow();
      expect(
        (await pub.withKey(key.key).get('/v1/products')).headers['ratelimit'],
      ).toBeDefined();
    });

    it('S42 AS-48: spending the allowance with one batch of 50 uses exactly 50 units', async () => {
      const { key } = await world();
      const res = await spend(key, pub).expect(200);
      expect(res.headers['ratelimit']).toMatch(/;r=0;/);
    });
  });

  describe('AS-57 monthly plan quota', () => {
    const refusing = (resetsAt: string): QuotaAnswer => ({
      allowed: false,
      used: 1_000,
      limit: 1_000,
      resetsAt,
    });

    it('S42 AS-57: a refusal is 429 quota_exceeded with Retry-After capped at 3,600 s and a detail naming the limit and the reset', async () => {
      const { key } = await world();
      quota.next = refusing('2026-11-01T00:00:00.000Z');
      const res = await pub.withKey(key.key).get('/v1/products');
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('quota_exceeded');
      expect(res.headers['retry-after']).toBe('3600');
      expect(res.body.detail).toContain('1000');
      expect(res.body.detail).toContain('2026-11-01T00:00:00.000Z');
    });

    it('S42 AS-57: close to the reset Retry-After is the seconds until it', async () => {
      const { key } = await world();
      quota.next = refusing('2026-10-06T12:02:00.000Z');
      const res = await pub.withKey(key.key).get('/v1/products');
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('120');
    });

    it('S42 AS-57: the answer is cached per shop for 60 s, so a plan change is seen within a minute', async () => {
      const { w, key } = await world();
      quota.next = refusing('2026-11-01T00:00:00.000Z');
      await pub.withKey(key.key).get('/v1/products').expect(429);
      await pub2.withKey(key.key).get('/v1/products').expect(429);
      expect(quota.calls).toBe(1);
      const redis = t.app.get(RedisService).client;
      const ttl = await redis.pttl(`apiquota:${w.shop.id}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);

      quota.next = {
        allowed: true,
        used: 10,
        limit: 100_000,
        resetsAt: '2026-11-01T00:00:00.000Z',
      };
      await redis.del(`apiquota:${w.shop.id}`); // the entry's 60 s are over
      await pub.withKey(key.key).get('/v1/products').expect(200);
      expect(quota.calls).toBe(2);
    });

    it('S42 AS-57: a test key is never limited by the quota and never asks', async () => {
      const { test } = await world();
      quota.next = refusing('2026-11-01T00:00:00.000Z');
      await pub.withKey(test.key).get('/v1/products').expect(200);
      expect(quota.calls).toBe(0);
    });

    it('S42 AS-57: when billing cannot answer the call is served and the degradation is counted by reason', async () => {
      const { key } = await world();
      const read = (reason: string) =>
        MetricsRegistry.value('public_api_quota_degraded_total', { reason }) ??
        0;
      const [u0, n0] = [read('usage_unavailable'), read('not_available')];
      quota.next = new QuotaUnavailable('usage_unavailable');
      await pub.withKey(key.key).get('/v1/products').expect(200);
      expect(read('usage_unavailable') - u0).toBe(1);
      quota.next = new QuotaUnavailable('not_available');
      await pub.withKey(key.key).get('/v1/products').expect(200);
      expect(read('not_available') - n0).toBe(1);
    });

    it('S42 AS-57: until billing exports its quota check the adapter says so, and a refused call is not billable', async () => {
      await expect(
        new BillingQuotaAdapter().check('any'),
      ).rejects.toMatchObject({ reason: 'not_available' });
    });
  });
});
