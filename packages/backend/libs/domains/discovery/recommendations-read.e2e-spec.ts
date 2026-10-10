import { Logger } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import { ShopQueryService } from '@app/domains/tenancy';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  countRedisCommands,
  createRecommendationsApp,
  newId,
  problem,
  seedDatasetD,
  type RecommendationsTestApp,
} from './recommendations.fixtures';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Bought-together recommendations API', () => {
  let t: RecommendationsTestApp;

  beforeAll(async () => {
    t = await createRecommendationsApp({ redisProxy: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.clean();
  });
  afterEach(() => jest.restoreAllMocks());

  const get = (productId: string, query: Record<string, string> = {}) =>
    t.http().get(`/api/products/${productId}/recommendations`).query(query);

  /** A product in a fresh active shop with the given neighbours in its list. */
  const world = async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    return { shop };
  };

  describe('US1 - what other buyers bought with this product', () => {
    it('S34 AS-01: dataset D built by the real job answers the cosine-ordered rail with the cacheable header and no state change', async () => {
      const d = await seedDatasetD(t);
      expect(await t.build()).toMatchObject({ outcome: 'completed' });
      const before = {
        keys: await t.listKeys(),
        list: await t.storedList(d.M),
        ttl: await t.redis.client.ttl(`rec:bought:{${d.M}}`),
      };

      const res = await get(d.M).expect(200);

      expect(res.body).toEqual({
        type: 'bought-together',
        items: [
          {
            productId: d.C,
            title: 'iPhone 17 Case',
            priceMinor: 4_900,
            currency: 'USD',
            score: 0.2067,
            hops: 1,
          },
          {
            productId: d.P,
            title: 'iPhone 17',
            priceMinor: 99_900,
            currency: 'USD',
            score: 0.1794,
            hops: 1,
          },
        ],
      });
      expect(await t.rail(d.M)).toEqual(res.body);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=60, s-maxage=300',
      );
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await t.listKeys()).toEqual(before.keys);
      expect(await t.storedList(d.M)).toEqual(before.list);
      expect(
        await t.redis.client.ttl(`rec:bought:{${d.M}}`),
      ).toBeLessThanOrEqual(before.ttl);
    });

    it('S34 AS-02: ties break by productId and two calls are byte-identical', async () => {
      const { shop } = await world();
      const [x, v, w, y, z] = [1, 2, 3, 4, 5].map(id);
      for (const [pid, title] of [
        [x, 'X'],
        [v, 'V'],
        [w, 'W'],
        [y, 'Y'],
        [z, 'Z'],
      ])
        await createProduct(t.app, shop, { id: pid, title });
      await t.putList(x, [
        [z, 0.5],
        [y, 0.5],
        [w, 0.5],
        [v, 0.7],
      ]);

      const first = await get(x).expect(200);
      const second = await get(x).expect(200);

      expect(first.text).toBe(second.text);
      expect(first.body.items.map((i: { productId: string }) => i.productId)).toEqual([
        v,
        w,
        y,
        z,
      ]);
    });

    it('S34 AS-03: limit defaults to 8, bounds are enforced, and nothing is clamped', async () => {
      const { shop } = await world();
      const x = id(1000);
      await createProduct(t.app, shop, { id: x });
      const neighbours = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          createProduct(t.app, shop, { id: id(i + 1) }),
        ),
      );
      await t.putList(
        x,
        neighbours.map((n, i) => [n.id, 0.9 - i * 0.05] as [string, number]),
      );

      expect((await t.rail(x)).items).toHaveLength(8);
      expect((await t.rail(x, { limit: '3' })).items.map((i) => i.productId)).toEqual(
        neighbours.slice(0, 3).map((n) => n.id),
      );
      expect((await t.rail(x, { limit: '20' })).items).toHaveLength(12);
      for (const limit of ['0', '21', '-1', 'abc', '2.5', ''])
        await get(x, { limit })
          .expect(400)
          .then((res) => {
            const p = problem(res.body);
            expect(p.code).toBe('validation_failed');
            expect(p.errors?.map((e) => e.field)).toEqual(['limit']);
          });
    });

    it('S34 AS-04: type is optional, bought-together is accepted, anything else is a 400 without a store read', async () => {
      const { shop } = await world();
      const x = id(1);
      await createProduct(t.app, shop, { id: x });
      const n = await createProduct(t.app, shop, { id: id(2) });
      await t.putList(x, [[n.id, 0.5]]);
      const counter = countRedisCommands();
      try {
        const plain = await get(x).expect(200);
        const typed = await get(x, { type: 'bought-together' }).expect(200);
        expect(typed.body).toEqual(plain.body);

        counter.reset();
        for (const type of ['also-viewed', 'anything']) {
          const res = await get(x, { type }).expect(400);
          const p = problem(res.body);
          expect(p.code).toBe('validation_failed');
          expect(p.errors).toEqual([
            { field: 'type', message: expect.any(String) },
          ]);
        }
        expect(counter.commands['zrevrange'] ?? 0).toBe(0);
      } finally {
        counter.stop();
      }
    });

    it('S34 AS-05: a bad id, a bad limit or an unknown parameter is a problem+json 400 naming the parameter, with no store read', async () => {
      const { shop } = await world();
      const x = id(1);
      await createProduct(t.app, shop, { id: x });
      const counter = countRedisCommands();
      try {
        const bad = await get('not-a-uuid').expect(400);
        expect(bad.headers['content-type']).toMatch(/application\/problem\+json/);
        expect(bad.body).toMatchObject({
          status: 400,
          code: 'validation_failed',
          errors: [{ field: 'productId', message: expect.any(String) }],
        });
        for (const key of ['type', 'title', 'status', 'detail', 'instance', 'requestId'])
          expect(bad.body).toHaveProperty(key);

        const foo = await get(x, { foo: '1' }).expect(400);
        expect(problem(foo.body).errors?.map((e) => e.field)).toEqual(['foo']);
        const limit = await get(x, { limit: '0' }).expect(400);
        expect(problem(limit.body).errors?.map((e) => e.field)).toEqual(['limit']);
        expect(counter.commands['zrevrange'] ?? 0).toBe(0);
      } finally {
        counter.stop();
      }
    });

    it('S34 AS-06: an unknown, archived, sandbox or non-active-shop product answers the identical 404', async () => {
      const { shop } = await world();
      const owner = await t.newUser();
      const archived = await createProduct(t.app, shop, { status: 'ARCHIVED' });
      const sandbox = await createProduct(t.app, shop, { isSandbox: true });
      const suspended = await createProduct(
        t.app,
        await createShop(t.app, owner, { status: 'SUSPENDED' }),
      );
      const deleting = await createProduct(
        t.app,
        await createShop(t.app, owner, { status: 'DELETING' }),
      );
      const deleted = await createProduct(
        t.app,
        await createShop(t.app, owner, { status: 'DELETED' }),
      );

      const answers = [];
      for (const pid of [newId(), archived.id, sandbox.id, suspended.id, deleting.id, deleted.id]) {
        const res = await get(pid).expect(404);
        expect(res.headers['cache-control']).toBe('no-store');
        const p = problem(res.body);
        expect(p.code).toBe('product_not_found');
        const { instance: _i, requestId: _r, ...stable } = res.body;
        answers.push(stable);
      }
      for (const a of answers) expect(a).toEqual(answers[0]);
    });

    it('S34 AS-07: every caller gets the same body, an invalid token is ignored, no cookie or Vary on identity, nothing about a buyer in logs or labels', async () => {
      const d = await seedDatasetD(t);
      await t.build();
      const buyer = await t.newUser();
      const seller = await t.newUser();
      const logged: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            logged.push(JSON.stringify(args));
          });

      const anon = await get(d.M).expect(200);
      const asBuyer = await t.as(buyer).get(`/api/products/${d.M}/recommendations`).expect(200);
      const asSeller = await t.as(seller).get(`/api/products/${d.M}/recommendations`).expect(200);
      const garbage = await get(d.M)
        .set('Authorization', 'Bearer not.a.token')
        .expect(200);

      for (const res of [asBuyer, asSeller, garbage]) expect(res.body).toEqual(anon.body);
      for (const res of [anon, asBuyer, asSeller, garbage]) {
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(res.headers['vary'] ?? '').not.toMatch(/cookie|authorization/i);
      }
      const logs = logged.join('\n');
      for (const secret of [buyer.id, buyer.email, seller.id, seller.email])
        expect(logs).not.toContain(secret);
      for (const secret of [buyer.id, seller.id])
        for (const result of ['ok', 'empty', 'not_found', 'invalid', 'unavailable'])
          expect(
            MetricsRegistry.value('recommendations_requests_total', {
              result: secret,
            }),
          ).toBeUndefined();
      expect(
        MetricsRegistry.value('recommendations_requests_total', { result: 'ok' }),
      ).toBeGreaterThan(0);
    });

    it('S34 AS-08: the 601st request in a minute is a 429 rate_limited with Retry-After; a downed limiter store still answers', async () => {
      const { shop } = await world();
      const x = (await createProduct(t.app, shop)).id;
      await t.redis.client.flushdb();
      let last;
      for (let i = 0; i < 600; i++) last = await get(x);
      expect(last!.status).toBe(200);

      const limited = await get(x).expect(429);

      expect(problem(limited.body).code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(limited.headers['cache-control']).toBe('no-store');

      await t.redis.client.flushdb();
      t.redisProxy!.mode = 'refuse';
      t.redisProxy!.sever();
      try {
        await get(x).expect(200);
      } finally {
        t.redisProxy!.mode = 'pass';
      }
    });

    it('S34 AS-09: 400 and 404 carry no-store and the problem+json body', async () => {
      for (const res of [await get('nope').expect(400), await get(newId()).expect(404)]) {
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
        problem(res.body);
      }
    });
  });

  describe('US2 - only products that can be bought right now', () => {
    it('S34 AS-10: hidden neighbours are dropped and replaced from the pool, with one product batch and one shop batch', async () => {
      const { shop } = await world();
      const owner = await t.newUser();
      const suspendedShop = await createShop(t.app, owner, { status: 'SUSPENDED' });
      const x = (await createProduct(t.app, shop, { id: id(1000) })).id;
      const hidden = [
        await createProduct(t.app, shop, { id: id(1), quantity: 0 }),
        await createProduct(t.app, shop, { id: id(2), status: 'ARCHIVED' }),
        await createProduct(t.app, shop, { id: id(3), isSandbox: true }),
        await createProduct(t.app, suspendedShop, { id: id(4) }),
      ].map((p) => p.id);
      const unknown = id(5);
      const visible = [];
      for (let n = 6; n <= 10; n++)
        visible.push((await createProduct(t.app, shop, { id: id(n) })).id);
      const ids = [...hidden, unknown, ...visible];
      await t.putList(
        x,
        ids.map((m, i) => [m, 0.9 - i * 0.05] as [string, number]),
      );
      const products = jest.spyOn(ProductQueryService.prototype, 'getProductsByIds');
      const shops = jest.spyOn(ShopQueryService.prototype, 'getShopsByIds');

      const body = await t.rail(x, { limit: '4' });

      expect(body.items.map((i) => i.productId)).toEqual(visible.slice(0, 4));
      expect(products).toHaveBeenCalledTimes(1);
      expect(shops).toHaveBeenCalledTimes(1);
    });

    it('S34 AS-11: fewer than asked is not padded, and a rail with nothing visible is an empty 200 with the cacheable header', async () => {
      const { shop } = await world();
      const x = (await createProduct(t.app, shop)).id;
      const a = (await createProduct(t.app, shop)).id;
      const b = (await createProduct(t.app, shop)).id;
      const gone = (await createProduct(t.app, shop, { quantity: 0 })).id;
      await t.putList(x, [
        [a, 0.9],
        [gone, 0.8],
        [b, 0.7],
      ]);
      const y = (await createProduct(t.app, shop)).id;
      await t.putList(y, [[gone, 0.9]]);

      expect((await t.rail(x)).items.map((i) => i.productId)).toEqual([a, b]);
      const empty = await get(y).expect(200);
      expect(empty.body).toEqual({ type: 'bought-together', items: [] });
      expect(empty.headers['cache-control']).toBe('public, max-age=60, s-maxage=300');
    });

    it('S34 AS-12: a stock change after the build is seen on the next origin request', async () => {
      const d = await seedDatasetD(t);
      await t.build();
      expect((await t.rail(d.M)).items.map((i) => i.productId)).toContain(d.C);

      const rows = await (await import('@app/domains/catalog')).ProductModel.update(
        { quantity: 0 },
        { where: { id: d.C }, silent: true },
      );
      expect(rows[0]).toBe(1);

      expect((await t.rail(d.M)).items.map((i) => i.productId)).toEqual([d.P]);
    });
  });
});
