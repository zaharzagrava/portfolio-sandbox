import { Logger, type LoggerService } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { ShopStatusChanged } from '@app/domains/tenancy';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  clearRateLimits,
  createKey,
  createPublicApiKit,
  exec,
  fastStoreOf,
  newId,
  rows,
  seedOrder,
  type CreatedKey,
  type PublicApiInstance,
  type PublicApiKit,
} from './testing/public-api-kit';
import { KeyVerifier } from './application/key-verifier.service';
import { PublicApiProjectorModule } from './public-api-projector.module';
import { PublicApiShopLifecycleConsumer } from './infra/consumers';
import { hashSecret } from './domain/api-key-format';

const failures = (reason: string) =>
  MetricsRegistry.value('public_api_auth_failures_total', { reason }) ?? 0;
const randomBase62 = (n: number) =>
  Array.from({ length: n }, () =>
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(
      Math.floor(Math.random() * 62),
    ),
  ).join('');

describe('Public API: authentication, scopes and tenant isolation', () => {
  let t: PublicApiKit;
  let pub2: PublicApiInstance;

  beforeAll(async () => {
    t = await createPublicApiKit({
      dashboardImports: [PublicApiProjectorModule],
    });
    pub2 = await t.publicInstance();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const world = async (scopes?: string[], livemode = true) => {
    const w = await t.seedWorld();
    const key = await createKey(t, w, {
      ...(scopes ? { scopes } : {}),
      livemode,
    });
    return { w, key };
  };

  describe('AS-13 one refusal for every bad key', () => {
    it('S42 AS-13: every way of presenting a bad credential answers the same 401 invalid_api_key with WWW-Authenticate', async () => {
      const { w, key } = await world();
      const revoked = await createKey(t, w, { name: 'revoked' });
      await t
        .as(w.owner)
        .delete(`/api/shops/${w.shop.id}/developers/keys/${revoked.id}`)
        .expect(204);
      const expiring = await createKey(t, w, {
        name: 'expiring',
        expiresAt: '2026-10-06T12:30:00.000Z',
      });
      const [, , prefix, secret] = key.key.split('_');
      const wrongSecret = `sk_live_${prefix}_${randomBase62(32)}`;
      const unknown = `sk_live_${randomBase62(12)}_${randomBase62(32)}`;

      const cases: Array<
        [
          string,
          () => PromiseLike<{
            status: number;
            headers: Record<string, string>;
            body: any;
          }>,
        ]
      > = [
        ['no Authorization', () => t.pub.http().get('/v1/products')],
        [
          'Basic scheme',
          () =>
            t.pub
              .http()
              .get('/v1/products')
              .set('Authorization', `Basic ${secret}`),
        ],
        [
          'empty Bearer',
          () =>
            t.pub.http().get('/v1/products').set('Authorization', 'Bearer '),
        ],
        [
          'malformed token',
          () =>
            t.pub
              .http()
              .get('/v1/products')
              .set('Authorization', 'Bearer not-a-key'),
        ],
        ['unknown prefix', () => t.pub.withKey(unknown).get('/v1/products')],
        ['wrong secret', () => t.pub.withKey(wrongSecret).get('/v1/products')],
        ['revoked key', () => t.pub.withKey(revoked.key).get('/v1/products')],
        [
          'expired key',
          () => {
            t.clock.advance(31 * 60_000);
            return t.pub.withKey(expiring.key).get('/v1/products');
          },
        ],
        [
          'key in the query string',
          () => t.pub.http().get(`/v1/products?api_key=${key.key}`),
        ],
      ];
      const bodies: Array<{
        title: string;
        detail: string;
        type: string;
        code: string;
      }> = [];
      for (const [label, send] of cases) {
        await clearRateLimits(t.app);
        const res = await send();
        expect({ label, status: res.status }).toEqual({ label, status: 401 });
        expect(res.headers['www-authenticate']).toBe('Bearer');
        expect(res.body.code).toBe('invalid_api_key');
        bodies.push(res.body);
      }
      const [first] = bodies;
      for (const b of bodies) {
        expect(b.title).toBe(first.title);
        expect(b.detail).toBe(first.detail);
        expect(b.type).toBe(first.type);
      }
    });

    it('S42 AS-13: an unknown prefix and a wrong secret take about the same time', async () => {
      const { key } = await world();
      const prefix = key.key.split('_')[2];
      const time = async (raw: string) => {
        const samples: number[] = [];
        for (let i = 0; i < 25; i += 1) {
          await clearRateLimits(t.app);
          const start = process.hrtime.bigint();
          await t.pub.withKey(raw).get('/v1/products').expect(401);
          samples.push(Number(process.hrtime.bigint() - start) / 1e6);
        }
        samples.sort((a, b) => a - b);
        return samples[Math.floor(samples.length / 2)];
      };
      const wrong = await time(`sk_live_${prefix}_${randomBase62(32)}`);
      const unknown = await time(
        `sk_live_${randomBase62(12)}_${randomBase62(32)}`,
      );
      // medians within 3x of each other plus a small absolute allowance: a lookup that skipped the hash would be far off
      expect(Math.max(wrong, unknown)).toBeLessThan(
        Math.min(wrong, unknown) * 3 + 15,
      );
    });
  });

  describe('AS-14 failed-authentication throttle', () => {
    it('S42 AS-14: the 31st failure in a minute from one address is 429 rate_limited with Retry-After; a valid key is still served; each failure is counted by reason', async () => {
      const { key } = await world();
      const before = {
        malformed: failures('malformed'),
        unknown: failures('unknown'),
        mismatch: failures('mismatch'),
      };
      const attempts: Array<() => ReturnType<typeof t.pub.http> | any> = [
        ...Array.from(
          { length: 10 },
          () => () => t.pub.http().get('/v1/products'),
        ),
        ...Array.from(
          { length: 10 },
          () => () =>
            t.pub
              .withKey(`sk_live_${randomBase62(12)}_${randomBase62(32)}`)
              .get('/v1/products'),
        ),
        ...Array.from(
          { length: 10 },
          () => () =>
            t.pub
              .withKey(`sk_live_${key.key.split('_')[2]}_${randomBase62(32)}`)
              .get('/v1/products'),
        ),
      ];
      for (const send of attempts) expect((await send()).status).toBe(401);
      expect(failures('malformed') - before.malformed).toBe(10);
      expect(failures('unknown') - before.unknown).toBe(10);
      expect(failures('mismatch') - before.mismatch).toBe(10);

      const thirtyFirst = await t.pub.http().get('/v1/products');
      expect(thirtyFirst.status).toBe(429);
      expect(thirtyFirst.body.code).toBe('rate_limited');
      expect(Number(thirtyFirst.headers['retry-after'])).toBeGreaterThanOrEqual(
        1,
      );
      expect((await t.pub.withKey(key.key).get('/v1/products')).status).toBe(
        200,
      );
      expect(JSON.stringify(thirtyFirst.body)).not.toMatch(
        /malformed|unknown|mismatch/,
      );
    });

    it('S42 AS-14: revoked and expired keys are counted with their own reason', async () => {
      const { w, key } = await world();
      const expiring = await createKey(t, w, {
        expiresAt: '2026-10-06T12:30:00.000Z',
      });
      await t
        .as(w.owner)
        .delete(`/api/shops/${w.shop.id}/developers/keys/${key.id}`)
        .expect(204);
      const r0 = failures('revoked');
      const e0 = failures('expired');
      await t.pub.withKey(key.key).get('/v1/products').expect(401);
      t.clock.advance(31 * 60_000);
      await t.pub.withKey(expiring.key).get('/v1/products').expect(401);
      expect(failures('revoked') - r0).toBe(1);
      expect(failures('expired') - e0).toBe(1);
    });
  });

  describe('AS-15 scopes', () => {
    const ID = '0190a000-0000-7000-8000-000000000001';
    const JOB = `bsu_${'a'.repeat(32)}`;
    const routes: Array<[string, string, string, object]> = [
      ['GET', '/v1/products', 'products:read', {}],
      ['POST', '/v1/products', 'products:write', {}],
      ['PATCH', `/v1/products/${ID}`, 'products:write', {}],
      ['GET', `/v1/stock/${ID}`, 'products:read', {}],
      ['GET', `/v1/products/${ID}/stock`, 'products:read', {}],
      ['POST', '/v1/stock/bulk', 'stock:write', { items: [] }],
      ['GET', `/v1/stock/bulk/${JOB}`, 'stock:write', {}],
      ['GET', '/v1/orders', 'orders:read', {}],
      ['GET', `/v1/orders/${ID}`, 'orders:read', {}],
    ];
    it.each(routes)(
      'S42 AS-15: %s %s needs %s',
      async (method, path, scope, body) => {
        const others = [
          'products:read',
          'products:write',
          'orders:read',
          'stock:write',
        ].filter((s) => s !== scope);
        const { key: without } = await world([others[0]]);
        const send = (k: CreatedKey) => {
          const req = (t.pub.withKey(k.key) as any)
            [method.toLowerCase()](path)
            .set('If-Match', '"1"')
            .set('Idempotency-Key', newId());
          return method === 'GET' ? req : req.send(body);
        };
        const refused = await send(without);
        expect(refused.status).toBe(403);
        expect(refused.body.code).toBe('insufficient_scope');
        expect(refused.body.required).toEqual([scope]);
        const { key: withScope } = await world([scope]);
        const allowed = await send(withScope);
        expect([401, 403]).not.toContain(allowed.status);
      },
    );

    it('S42 AS-15: POST /v1/batch needs no scope of its own', async () => {
      const { key } = await world(['products:read']);
      const res = await t.pub
        .withKey(key.key)
        .post('/v1/batch')
        .set('Idempotency-Key', newId())
        .send({ operations: [{ method: 'GET', path: '/v1/products' }] });
      expect(res.status).toBe(200);
    });

    it('S42 AS-15: the scope is checked before any work: a refused POST creates nothing and an invalid body is still 403', async () => {
      const { w, key } = await world(['products:read']);
      const res = await t.pub
        .withKey(key.key)
        .post('/v1/products')
        .set('Idempotency-Key', newId())
        .send({ nonsense: true });
      expect(res.status).toBe(403);
      const [{ n }] = await rows<{ n: number }>(
        t.app,
        `SELECT count(*)::int AS n FROM "Product" WHERE "shopId" = :id`,
        { id: w.shop.id },
      );
      expect(n).toBe(0);
    });
  });

  describe('AS-16 tenant isolation', () => {
    const shape = (body: Record<string, unknown>) => ({
      keys: Object.keys(body).sort(),
      code: body.code,
      status: body.status,
      title: body.title,
    });

    it('S42 AS-16: another shop’s product, stock and order answer 404 resource_missing, identical to an unknown id, and nothing changes', async () => {
      const a = await world();
      const b = await world();
      const buyer = await t.newUser();
      const pa = await createProduct(t.app, a.w.shop, {});
      const pb = await createProduct(t.app, b.w.shop, {});
      const ob = await seedOrder(t.app, {
        buyerId: buyer.id,
        lines: [
          {
            productId: pb.id,
            shopId: b.w.shop.id,
            quantity: 1,
            unitPriceMinor: 500,
          },
        ],
      });
      await seedOrder(t.app, {
        buyerId: buyer.id,
        lines: [
          {
            productId: pa.id,
            shopId: a.w.shop.id,
            quantity: 1,
            unitPriceMinor: 500,
          },
        ],
      });
      const [shopOrderOfB] = [...ob.shopOrders.values()];
      const unknown = newId();
      const probes: Array<[string, (id: string) => any]> = [
        [
          'GET product',
          (id) => t.pub.withKey(a.key.key).get(`/v1/products/${id}`),
        ],
        [
          'PATCH product',
          (id) =>
            t.pub
              .withKey(a.key.key)
              .patch(`/v1/products/${id}`)
              .set('If-Match', '"1"')
              .send({ title: 'hijack' }),
        ],
        ['GET stock', (id) => t.pub.withKey(a.key.key).get(`/v1/stock/${id}`)],
        [
          'GET deprecated stock',
          (id) => t.pub.withKey(a.key.key).get(`/v1/products/${id}/stock`),
        ],
        ['GET order', (id) => t.pub.withKey(a.key.key).get(`/v1/orders/${id}`)],
      ];
      for (const [label, probe] of probes) {
        const foreignId = label === 'GET order' ? shopOrderOfB : pb.id;
        const foreign = await probe(foreignId);
        const missing = await probe(unknown);
        expect({ label, status: foreign.status }).toEqual({
          label,
          status: 404,
        });
        expect(foreign.body.code).toBe('resource_missing');
        expect(shape(foreign.body)).toEqual(shape(missing.body));
        expect(foreign.body.detail).toBe(missing.body.detail);
      }
      const [stored] = await rows<{ title: string }>(
        t.app,
        `SELECT title FROM "Product" WHERE id = :id`,
        { id: pb.id },
      );
      expect(stored.title).toBe(pb.title);

      const list = await t.pub
        .withKey(a.key.key)
        .get('/v1/products')
        .expect(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([pa.id]);
      const orders = await t.pub
        .withKey(a.key.key)
        .get('/v1/orders')
        .expect(200);
      expect(JSON.stringify(orders.body)).not.toContain(pb.id);
    });
  });

  describe('AS-17 shop status gate', () => {
    const lifecycle = () => t.app.get(PublicApiShopLifecycleConsumer);
    const setStatus = (shopId: string, status: string) =>
      exec(t.app, `UPDATE "Shop" SET status = :status WHERE id = :shopId`, {
        shopId,
        status,
      });
    const changed = (shopId: string, to: 'ACTIVE' | 'SUSPENDED' | 'DELETING') =>
      ShopStatusChanged.create(shopId, 3, {
        shopId,
        from: 'ACTIVE',
        to,
        shopVersion: 3,
      });

    it('S42 AS-17: after shop_status_changed the next call on every instance is 403 shop_suspended, then 409 shop_offboarding, reads and writes alike', async () => {
      const { w, key } = await world();
      expect((await t.pub.withKey(key.key).get('/v1/products')).status).toBe(
        200,
      );
      expect((await pub2.withKey(key.key).get('/v1/products')).status).toBe(
        200,
      );

      await setStatus(w.shop.id, 'SUSPENDED');
      await lifecycle().project([changed(w.shop.id, 'SUSPENDED')]);
      for (const inst of [t.pub, pub2]) {
        const read = await inst.withKey(key.key).get('/v1/products');
        expect(read.status).toBe(403);
        expect(read.body.code).toBe('shop_suspended');
        const write = await inst
          .withKey(key.key)
          .post('/v1/products')
          .set('Idempotency-Key', newId())
          .send({});
        expect(write.status).toBe(403);
        expect(write.body.code).toBe('shop_suspended');
      }

      await setStatus(w.shop.id, 'DELETING');
      await lifecycle().project([changed(w.shop.id, 'DELETING')]);
      const gone = await t.pub.withKey(key.key).get('/v1/products');
      expect(gone.status).toBe(409);
      expect(gone.body.code).toBe('shop_offboarding');

      await setStatus(w.shop.id, 'ACTIVE');
      await lifecycle().project([changed(w.shop.id, 'ACTIVE')]);
      expect((await pub2.withKey(key.key).get('/v1/products')).status).toBe(
        200,
      );
    });

    it('S42 AS-17: without an event the status entry lives at most 60 seconds', async () => {
      const { w, key } = await world();
      await t.pub.withKey(key.key).get('/v1/products').expect(200);
      const ttl = await t.app
        .get(RedisService)
        .client.pttl(`apishop:status:${w.shop.id}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });
  });

  describe('AS-18 degraded stores', () => {
    const store = () => fastStoreOf(t.app);
    afterEach(async () => {
      await store().allow();
    });

    it('S42 AS-18: with the fast store down a valid key is served from the system of record (counted per call), unknown and revoked keys are still 401', async () => {
      const { w, key } = await world();
      const revoked = await createKey(t, w, { name: 'revoked' });
      await t
        .as(w.owner)
        .delete(`/api/shops/${w.shop.id}/developers/keys/${revoked.id}`)
        .expect(204);
      await store().deny('api');
      const before =
        MetricsRegistry.value('public_api_key_cache_degraded_total') ?? 0;
      expect((await t.pub.withKey(key.key).get('/v1/products')).status).toBe(
        200,
      );
      expect((await t.pub.withKey(key.key).get('/v1/products')).status).toBe(
        200,
      );
      expect(
        (MetricsRegistry.value('public_api_key_cache_degraded_total') ?? 0) -
          before,
      ).toBeGreaterThanOrEqual(2);
      expect(
        (await t.pub.withKey(revoked.key).get('/v1/products')).status,
      ).toBe(401);
      expect(
        (
          await t.pub
            .withKey(`sk_live_${randomBase62(12)}_${randomBase62(32)}`)
            .get('/v1/products')
        ).status,
      ).toBe(401);
    });

    describe('with the system of record unreachable too', () => {
      let proxy: TcpFaultProxy;
      let isolated: PublicApiInstance;
      beforeAll(async () => {
        proxy = await TcpFaultProxy.start({
          host: 'localhost',
          port: Number(process.env.DB_PORT ?? 5400),
        });
        isolated = await t.publicInstance({
          env: { DB_HOST: '127.0.0.1', DB_PORT: String(proxy.port) },
        });
      });
      afterAll(() => {
        // the instance is closed with the kit: models are shared statics, closing one app would close their connection
        proxy.mode = 'pass';
      });
      afterEach(() => {
        proxy.mode = 'pass';
      });

      it('S42 AS-18: an uncached key is 503 service_unavailable with Retry-After 5 (never 401); a cached, valid key keeps verifying', async () => {
        const { key } = await world();
        const verifier = isolated.app.get(KeyVerifier);
        // warm: one call fills the 60 s entry
        expect(
          (await isolated.withKey(key.key).get('/v1/products')).status,
        ).toBe(200);

        const { key: cold } = await world();
        await store().deny('api');
        proxy.mode = 'refuse';
        proxy.sever();
        const unavailableBefore =
          MetricsRegistry.value('public_api_auth_unavailable_total') ?? 0;
        const res = await isolated.withKey(cold.key).get('/v1/products');
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('service_unavailable');
        expect(res.headers['retry-after']).toBe('5');
        expect(
          (MetricsRegistry.value('public_api_auth_unavailable_total') ?? 0) -
            unavailableBefore,
        ).toBe(1);

        await store().allow();
        // the warmed key is still in the entry: the verifier answers without the database
        const warm = await verifier.verify(key.key);
        expect(warm?.id).toBe(key.id);
      });
    });
  });

  describe('AS-19 secrets never leak', () => {
    class Capture implements LoggerService {
      lines: string[] = [];
      private add(...args: unknown[]) {
        this.lines.push(
          args
            .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
            .join(' '),
        );
      }
      log = (...a: unknown[]) => this.add(...a);
      error = (...a: unknown[]) => this.add(...a);
      warn = (...a: unknown[]) => this.add(...a);
      debug = (...a: unknown[]) => this.add(...a);
      verbose = (...a: unknown[]) => this.add(...a);
      fatal = (...a: unknown[]) => this.add(...a);
    }

    it('S42 AS-19: the key, its secret and the Authorization value appear in no log, event, error body, header or metric label', async () => {
      const capture = new Capture();
      Logger.overrideLogger(capture);
      try {
        const w = await t.seedWorld();
        const key = await createKey(t, w, { name: 'leak check' });
        const rotated = await t
          .as(w.ownerMfa)
          .post(`/api/shops/${w.shop.id}/developers/keys/${key.id}/rotate`)
          .send({})
          .expect(201);
        const wrong = `sk_live_${key.prefix}_${randomBase62(32)}`;
        const responses = [
          await t.pub.withKey(key.key).get('/v1/products'),
          await t.pub.withKey(rotated.body.key).get('/v1/orders/not-an-id'),
          await t.pub.withKey(wrong).get('/v1/products'),
          await t.pub
            .withKey(rotated.body.key)
            .post('/v1/products')
            .set('Idempotency-Key', newId())
            .send({ bad: true }),
          await t.pub
            .http()
            .get('/v1/products')
            .set('Authorization', `Bearer ${wrong}`),
        ];
        const secrets = [key.key, rotated.body.key, wrong].flatMap((k) => [
          k,
          k.split('_')[3],
          `Bearer ${k}`,
        ]);
        const surfaces: Record<string, string> = {
          logs: capture.lines.join('\n'),
          bodies: JSON.stringify(responses.map((r) => r.body)),
          headers: JSON.stringify(responses.map((r) => r.headers)),
          metrics: JSON.stringify(
            [
              'public_api_auth_failures_total',
              'public_api_key_cache_degraded_total',
            ].flatMap((n) => MetricsRegistry.labelSets(n)),
          ),
          events: JSON.stringify(
            await rows(
              t.app,
              `SELECT payload FROM "Outbox" WHERE "eventName" LIKE 'developerplatform.%' OR "eventName" LIKE 'api.%'`,
            ),
          ),
        };
        for (const [surface, text] of Object.entries(surfaces))
          for (const secret of secrets)
            expect({ surface, leaked: text.includes(secret) }).toEqual({
              surface,
              leaked: false,
            });
      } finally {
        Logger.overrideLogger(['fatal']);
      }
    });
  });

  describe('AS-21 previous pepper', () => {
    it('S42 AS-21: a key hashed with the previous pepper still verifies and is re-hashed under the current one on use', async () => {
      const { w, key } = await world();
      const oldPepper = 'test-api-key-pepper-0123456789abcdefghijkl';
      const inst = await t.publicInstance({
        env: {
          API_KEY_PEPPER: 'rotated-api-key-pepper-0123456789abcdefghijkl',
          API_KEY_PEPPER_PREVIOUS: oldPepper,
        },
      });
      const [before] = await rows<{ hash: string }>(
        t.app,
        `SELECT hash FROM "ApiKey" WHERE id = :id`,
        { id: key.id },
      );
      expect(before.hash).toBe(hashSecret(key.key.split('_')[3], oldPepper));

      expect((await inst.withKey(key.key).get('/v1/products')).status).toBe(
        200,
      );
      const [after] = await rows<{ hash: string; hashVersion: number }>(
        t.app,
        `SELECT hash, "hashVersion" FROM "ApiKey" WHERE id = :id`,
        { id: key.id },
      );
      expect(after.hash).toBe(
        hashSecret(
          key.key.split('_')[3],
          'rotated-api-key-pepper-0123456789abcdefghijkl',
        ),
      );
      expect(after.hashVersion).toBe(1);
      expect((await inst.withKey(key.key).get('/v1/products')).status).toBe(
        200,
      );
      void w;
    });
  });
});
