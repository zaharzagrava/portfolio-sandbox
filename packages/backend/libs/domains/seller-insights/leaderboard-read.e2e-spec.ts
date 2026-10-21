import { v4 as uuidv4 } from 'uuid';
import {
  leaderboardPageSchema,
  shopRankSchema,
} from '@marketplace-sandbox/contracts';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { BoardProjector } from './infra/projectors/board.projector';
import { ShopNameProjector } from './infra/projectors/read-model.projectors';
import {
  createInsightsApp,
  T0,
  type InsightsTestApp,
  type SeededShop,
} from './testing/insights-fixtures';

describe('Leaderboards: public top list and my rank', () => {
  let t: InsightsTestApp;

  beforeAll(async () => {
    t = await createInsightsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const at = (offsetSeconds: number) =>
    new Date(T0.getTime() + offsetSeconds * 1000);
  const boards = () => t.projector(BoardProjector);
  const sell = (
    shopId: string,
    productId: string,
    total: number,
    paidAt: Date | string = T0,
  ) =>
    t.paid({ paidAt, lines: [{ shopId, productId, lineTotalMinor: total }] });
  const strip = (body: Record<string, unknown>) => {
    const { instance: _i, requestId: _r, ...rest } = body;
    return rest;
  };
  const get = (query: string, address?: string) => {
    const req = t.http().get(`/api/leaderboards${query}`);
    return address ? req.set('X-Forwarded-For', address) : req;
  };
  const freezeW40 = async () => {
    t.clock.set(new Date('2026-10-05T01:00:00Z'));
    await t.freeze('2026-W40');
    t.clock.set(T0);
  };

  /** B 10001, A 10000, C 500 in the current week (A < B < C by id), real shops with owners. */
  const standings = async () => {
    const [a, b, c] = await t.trio();
    const product = await t.product(a.shopId, 'electronics');
    await t.deliver(boards(), [
      sell(a.shopId, product, 10_000, at(-30)),
      sell(b.shopId, product, 10_001, at(0)),
      sell(c.shopId, product, 500, at(5)),
    ]);
    return { a, b, c, product };
  };

  describe('AS-17..20: the top list', () => {
    it('S40 AS-17: an anonymous call gets ranks 1..3 with shop, slug and name, no revenue, parsed by the contracts schema, with the live cache header', async () => {
      const { a, b, c } = await standings();

      const res = await get('?period=week').expect(200);

      const page = leaderboardPageSchema.parse(res.body);
      expect(page.period).toEqual({
        kind: 'week',
        id: '2026-W41',
        startsAt: '2026-10-05T00:00:00Z',
        endsAt: '2026-10-12T00:00:00Z',
        closed: false,
      });
      expect(page.category).toBeNull();
      expect(page.source).toBe('live');
      expect(Date.parse(page.generatedAt)).toBe(T0.getTime());
      expect(page.entries).toEqual([
        { rank: 1, shopId: b.shopId, slug: 'beta', name: 'Beta' },
        { rank: 2, shopId: a.shopId, slug: 'alpha', name: 'Alpha' },
        { rank: 3, shopId: c.shopId, slug: 'gamma', name: 'Gamma' },
      ]);
      expect(JSON.stringify(res.body)).not.toMatch(/revenue|userId|10001/i);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=10, s-maxage=30',
      );
    });

    it('S40 AS-18: category (any letter case), month, a named week and limit select the board; a valid empty category is 200 with no entries', async () => {
      const a = await t.readModelShop('Alpha');
      const b = await t.readModelShop('Beta');
      const electronics = await t.product(a.shopId, 'electronics');
      const accessories = await t.product(a.shopId, 'accessories');
      await t.deliver(boards(), [
        t.paid({
          paidAt: T0,
          lines: [
            { shopId: a.shopId, productId: electronics, lineTotalMinor: 5000 },
            { shopId: a.shopId, productId: accessories, lineTotalMinor: 1000 },
          ],
        }),
        sell(b.shopId, electronics, 4000, at(-10)),
        sell(b.shopId, electronics, 900, '2026-09-30T10:00:00Z'),
      ]);

      const accessoriesPage = leaderboardPageSchema.parse(
        (await get('?category=Accessories').expect(200)).body,
      );
      expect(accessoriesPage.category).toBe('accessories');
      expect(accessoriesPage.entries.map((e) => e.shopId)).toEqual([a.shopId]);
      const monthPage = leaderboardPageSchema.parse(
        (await get('?period=month').expect(200)).body,
      );
      expect(monthPage.period.id).toBe('2026-10');
      expect(monthPage.entries.map((e) => e.shopId)).toEqual([
        a.shopId,
        b.shopId,
      ]);
      const w40 = leaderboardPageSchema.parse(
        (await get('?period=week&id=2026-W40').expect(200)).body,
      );
      expect(w40.period).toMatchObject({ id: '2026-W40', closed: true });
      expect(w40.entries.map((e) => e.shopId)).toEqual([b.shopId]);
      expect(
        leaderboardPageSchema.parse((await get('?limit=1').expect(200)).body)
          .entries,
      ).toHaveLength(1);
      const garden = leaderboardPageSchema.parse(
        (await get('?category=garden').expect(200)).body,
      );
      expect(garden.entries).toEqual([]);
      expect(garden.category).toBe('garden');
    });

    it('S40 AS-18: the default limit is 20 and the largest accepted is 100', async () => {
      const product = uuidv4();
      const shops = Array.from({ length: 101 }, () => uuidv4());
      for (let i = 0; i < shops.length; i += 25)
        await t.deliver(
          boards(),
          shops
            .slice(i, i + 25)
            .map((shopId, k) => sell(shopId, product, 100 + i + k)),
        );

      expect(
        leaderboardPageSchema.parse(
          (await get('?period=week').expect(200)).body,
        ).entries,
      ).toHaveLength(20);
      const full = leaderboardPageSchema.parse(
        (await get('?period=week&limit=100').expect(200)).body,
      );
      expect(full.entries).toHaveLength(100);
      expect(full.entries.map((e) => e.rank)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 1),
      );
    });

    it('S40 AS-19: every invalid selector is a 400 validation_failed naming the field; a future period is 422 period_in_future; errors are problem+json', async () => {
      const cases: Array<[string, string]> = [
        ['?period=day', 'period'],
        ['?id=2026-W54', 'id'],
        ['?id=2026-13', 'id'],
        ['?id=abc', 'id'],
        ['?id=2026-W4', 'id'],
        ['?period=week&id=2026-10', 'id'],
        ['?limit=0', 'limit'],
        ['?limit=101', 'limit'],
        ['?limit=abc', 'limit'],
        ['?limit=1.5', 'limit'],
        [`?category=${'x'.repeat(65)}`, 'category'],
        ['?category=a%07b', 'category'],
        ['?limit=1&limit=2', 'limit'],
        ['?surprise=1', 'surprise'],
      ];
      for (const [query, field] of cases) {
        const res = await get(query);
        expect([query, res.status]).toEqual([query, 400]);
        expect(res.headers['content-type']).toMatch(
          /application\/problem\+json/,
        );
        expect(res.body).toMatchObject({
          code: 'validation_failed',
          status: 400,
        });
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain(field);
        for (const member of [
          'type',
          'title',
          'status',
          'detail',
          'instance',
          'requestId',
        ])
          expect(res.body[member]).toBeDefined();
      }
      const future = await get('?period=week&id=2026-W50');
      expect(future.status).toBe(422);
      expect(future.body.code).toBe('period_in_future');
      expect(future.headers['content-type']).toMatch(
        /application\/problem\+json/,
      );
    });

    it('S40 AS-20: a rename shows at once, a stale rename is ignored, and a shop without a read-model row is ranked with null name and slug', async () => {
      const a = await t.readModelShop('Alpha');
      const unknown = uuidv4();
      const product = uuidv4();
      await t.deliver(boards(), [
        sell(a.shopId, product, 5000),
        sell(unknown, product, 100),
      ]);
      const names = t.projector(ShopNameProjector);

      await t.deliver(names, [
        t.shopUpdated({
          shopId: a.shopId,
          name: 'Alpha Plus',
          slug: 'alpha-plus',
          shopVersion: 2,
        }),
      ]);
      let page = leaderboardPageSchema.parse(
        (await get('?period=week').expect(200)).body,
      );
      expect(page.entries[0]).toEqual({
        rank: 1,
        shopId: a.shopId,
        slug: 'alpha-plus',
        name: 'Alpha Plus',
      });

      await t.deliver(names, [
        t.shopUpdated({
          shopId: a.shopId,
          name: 'Stale',
          slug: 'stale',
          shopVersion: 1,
        }),
      ]);
      page = leaderboardPageSchema.parse(
        (await get('?period=week').expect(200)).body,
      );
      expect(page.entries[0].name).toBe('Alpha Plus');
      expect(page.entries[1]).toEqual({
        rank: 2,
        shopId: unknown,
        slug: null,
        name: null,
      });
    });
  });

  describe('AS-21: rate limit', () => {
    it('S40 AS-21: the 61st request from one address is 429 with Retry-After; another address is unaffected', async () => {
      await standings();
      for (let i = 0; i < 60; i++)
        await get('?period=week', '198.51.100.7').expect(200);

      const limited = await get('?period=week', '198.51.100.7');

      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      await get('?period=week', '198.51.100.8').expect(200);
    });
  });

  describe('AS-22..23: frozen periods and the board store', () => {
    it('S40 AS-22: a frozen week is served from its snapshot, closed, with the long cache header; later changes to the live board are invisible', async () => {
      const a = await t.readModelShop('Alpha');
      const b = await t.readModelShop('Beta');
      const product = await t.product(a.shopId, 'electronics');
      await t.deliver(boards(), [
        sell(a.shopId, product, 10_000, '2026-10-02T10:00:00Z'),
        sell(b.shopId, product, 400, '2026-10-02T11:00:00Z'),
      ]);
      await freezeW40();
      await t.flushRedisPrefix('lb:{2026-W40}');

      const res = await get('?period=week&id=2026-W40').expect(200);

      const page = leaderboardPageSchema.parse(res.body);
      expect(page.source).toBe('snapshot');
      expect(page.period.closed).toBe(true);
      expect(page.entries.map((e) => [e.rank, e.shopId, e.name])).toEqual([
        [1, a.shopId, 'Alpha'],
        [2, b.shopId, 'Beta'],
      ]);
      expect(res.headers['cache-control']).toBe(
        'public, max-age=3600, s-maxage=86400',
      );

      await t.redis.zadd(`lb:{2026-W40}:z:all`, '999999999999', b.shopId);
      expect(
        leaderboardPageSchema
          .parse((await get('?period=week&id=2026-W40').expect(200)).body)
          .entries.map((e) => e.shopId),
      ).toEqual([a.shopId, b.shopId]);
    });

    it('S40 AS-23: with the board store down the current week is 503 with Retry-After 5 and a generic detail within a second; the frozen week is still 200', async () => {
      const a = await t.readModelShop('Alpha');
      const product = await t.product(a.shopId, 'electronics');
      await t.deliver(boards(), [
        sell(a.shopId, product, 10_000, '2026-10-02T10:00:00Z'),
      ]);
      await freezeW40();
      t.faults.redisDown = true;

      const started = Date.now();
      const current = await get('?period=week');
      const elapsed = Date.now() - started;
      const frozen = await get('?period=week&id=2026-W40');

      expect(current.status).toBe(503);
      expect(elapsed).toBeLessThan(1000);
      expect(current.headers['retry-after']).toBe('5');
      expect(current.body.code).toBe('service_unavailable');
      expect(JSON.stringify(current.body)).not.toMatch(
        /redis|injected|ECONN|localhost|eval|stack/i,
      );
      expect(frozen.status).toBe(200);
      expect(leaderboardPageSchema.parse(frozen.body).source).toBe('snapshot');
    });
  });

  describe('AS-24..26: my rank', () => {
    it('S40 AS-24: a member, a viewer included, gets rank 2 of 3, top 67 percent and the shop revenue; a category variant ranks on its own board', async () => {
      const { a, b, c } = await standings();
      const viewer = await t.member(a.shopId, 'VIEWER');
      const accessories = await t.product(a.shopId, 'accessories');
      await t.deliver(boards(), [
        sell(a.shopId, accessories, 700),
        sell(b.shopId, accessories, 800),
      ]);

      for (const user of [a.owner, viewer]) {
        const res = await t
          .as(user)
          .get(`/api/shops/${a.shopId}/rank?period=week`)
          .expect(200);
        const rank = shopRankSchema.parse(res.body);
        expect(rank).toMatchObject({
          category: null,
          rank: 2,
          of: 3,
          topPercent: 67,
          revenueMinor: 10_700,
        });
        expect(rank.period.id).toBe('2026-W41');
        expect(res.headers['cache-control']).toBe('private, no-store');
      }
      const category = shopRankSchema.parse(
        (
          await t
            .as(a.owner)
            .get(`/api/shops/${a.shopId}/rank?period=week&category=accessories`)
            .expect(200)
        ).body,
      );
      expect(category).toMatchObject({
        category: 'accessories',
        rank: 2,
        of: 2,
        topPercent: 100,
        revenueMinor: 700,
      });
    });

    it('S40 AS-25: a shop without sales on the board, a category without sales and a period without sales are all 404 not_ranked', async () => {
      const { a } = await standings();
      const idle = await t.seedShop();

      for (const url of [
        `/api/shops/${idle.shopId}/rank?period=week`,
        `/api/shops/${a.shopId}/rank?period=week&category=garden`,
        `/api/shops/${a.shopId}/rank?period=week&id=2026-W40`,
      ]) {
        const user = url.includes(idle.shopId) ? idle.owner : a.owner;
        const res = await t.as(user).get(url);
        expect([url, res.status, res.body.code]).toEqual([
          url,
          404,
          'not_ranked',
        ]);
      }
    });

    it('S40 AS-26: a stranger, an unknown id and a malformed id get the same 404; no credentials is 401; a suspended shop answers; a deleted one is 404', async () => {
      const { a, b } = await standings();
      const stranger = a.owner;

      const foreign = await t
        .as(stranger)
        .get(`/api/shops/${b.shopId}/rank?period=week`);
      const unknown = await t
        .as(stranger)
        .get(`/api/shops/${uuidv4()}/rank?period=week`);
      const malformed = await t
        .as(stranger)
        .get(`/api/shops/not-an-id/rank?period=week`);

      expect([foreign.status, unknown.status, malformed.status]).toEqual([
        404, 404, 404,
      ]);
      expect(foreign.body.code).toBe('shop_not_found');
      expect(strip(unknown.body)).toEqual(strip(foreign.body));
      expect(strip(malformed.body)).toEqual(strip(foreign.body));
      expect(JSON.stringify(foreign.body)).not.toMatch(/10001|revenue/i);
      expect(
        (await t.http().get(`/api/shops/${a.shopId}/rank?period=week`)).status,
      ).toBe(401);

      const suspended = await t.seedShop({ status: 'SUSPENDED' });
      await t.deliver(boards(), [sell(suspended.shopId, uuidv4(), 300)]);
      expect(
        (
          await t
            .as(suspended.owner)
            .get(`/api/shops/${suspended.shopId}/rank?period=week`)
        ).status,
      ).toBe(200);
      const deleted = await t.seedShop({ status: 'DELETED' });
      const gone = await t
        .as(deleted.owner)
        .get(`/api/shops/${deleted.shopId}/rank?period=week`);
      expect([gone.status, gone.body.code]).toEqual([404, 'shop_not_found']);
    });
  });

  describe('AS-27..30: rank agrees with the list', () => {
    it('S40 AS-27: with 25 shops and three tied, every rank equals its position in the top list and of is 25', async () => {
      const shops: SeededShop[] = [];
      for (let i = 0; i < 25; i++) shops.push(await t.seedShop());
      const product = uuidv4();
      // revenues 100..2400 distinct, except three shops that tie on revenue and instant
      const revenue = (i: number) => (i >= 22 ? 5000 : 100 + i * 100);
      await t.deliver(
        boards(),
        shops.map((s, i) =>
          sell(s.shopId, product, revenue(i), i >= 22 ? at(10) : at(i)),
        ),
      );

      const list = leaderboardPageSchema.parse(
        (await get('?period=week&limit=25').expect(200)).body,
      ).entries;

      expect(list).toHaveLength(25);
      for (const entry of list) {
        const shop = shops.find((s) => s.shopId === entry.shopId)!;
        const rank = shopRankSchema.parse(
          (
            await t
              .as(shop.owner)
              .get(`/api/shops/${shop.shopId}/rank?period=week`)
              .expect(200)
          ).body,
        );
        expect([entry.shopId, rank.rank, rank.of]).toEqual([
          entry.shopId,
          entry.rank,
          25,
        ]);
      }
    });

    it('S40 AS-28: in a frozen week position 100 is rank 100 of 101, top 100 percent; position 101 is not ranked', async () => {
      const [x, y] = [await t.seedShop(), await t.seedShop()];
      const product = uuidv4();
      const others = Array.from({ length: 99 }, () => uuidv4());
      await t.deliver(boards(), [
        ...others.map((shopId, i) =>
          sell(shopId, product, 1000 + i, '2026-10-02T10:00:00Z'),
        ),
        sell(x.shopId, product, 20, '2026-10-02T10:00:00Z'),
        sell(y.shopId, product, 10, '2026-10-02T10:00:00Z'),
      ]);
      await freezeW40();

      const atHundred = await t
        .as(x.owner)
        .get(`/api/shops/${x.shopId}/rank?period=week&id=2026-W40`)
        .expect(200);
      expect(shopRankSchema.parse(atHundred.body)).toMatchObject({
        rank: 100,
        of: 101,
        topPercent: 100,
        revenueMinor: 20,
      });
      const beyond = await t
        .as(y.owner)
        .get(`/api/shops/${y.shopId}/rank?period=week&id=2026-W40`);
      expect([beyond.status, beyond.body.code]).toEqual([404, 'not_ranked']);
    });

    it('S40 AS-30: a closed week that is not frozen is answered from the live board; after the freeze the same call is answered from the snapshot', async () => {
      const [a, b] = await t.trio();
      const product = uuidv4();
      await t.deliver(boards(), [
        sell(a.shopId, product, 3000, '2026-10-02T10:00:00Z'),
        sell(b.shopId, product, 5000, '2026-10-02T11:00:00Z'),
      ]);
      const url = `/api/shops/${a.shopId}/rank?period=week&id=2026-W40`;

      const live = shopRankSchema.parse(
        (await t.as(a.owner).get(url).expect(200)).body,
      );
      expect(live).toMatchObject({
        rank: 2,
        of: 2,
        topPercent: 100,
        revenueMinor: 3000,
      });
      // the live board changes after the period is over; the snapshot has not been taken yet
      await t.redis.zrem(`lb:{2026-W40}:z:all`, b.shopId);
      expect(
        shopRankSchema.parse((await t.as(a.owner).get(url).expect(200)).body),
      ).toMatchObject({ rank: 1, of: 1 });
      await t.redis.zadd(
        `lb:{2026-W40}:z:all`,
        String(5000 * 2 ** 20),
        b.shopId,
      );
      await freezeW40();
      await t.flushRedisPrefix('lb:{2026-W40}');

      const frozen = shopRankSchema.parse(
        (await t.as(a.owner).get(url).expect(200)).body,
      );
      expect(frozen).toMatchObject({
        rank: 2,
        of: 2,
        topPercent: 100,
        revenueMinor: 3000,
      });
    });
  });
});

describe('Leaderboards: public top list with the rate limiter store down', () => {
  let t: InsightsTestApp;
  let proxy: TcpFaultProxy;

  beforeAll(async () => {
    proxy = await TcpFaultProxy.start({ host: 'localhost', port: 6400 });
    t = await createInsightsApp({
      env: { REDIS_URL: `redis://127.0.0.1:${proxy.port}/${new URL(process.env.REDIS_URL ?? "redis://localhost:6400/0").pathname.slice(1) || "0"}` },
    });
  });
  afterAll(async () => {
    await t.close();
    await proxy.close();
  });

  it('S40 AS-21: with the limiter store down the request is served (fail open) and rate_limit_degraded counts it', async () => {
    await t.reset();
    const a = await t.readModelShop('Alpha');
    await t.deliver(t.projector(BoardProjector), [
      t.paid({
        paidAt: '2026-10-02T10:00:00Z',
        lines: [{ shopId: a.shopId, productId: uuidv4(), lineTotalMinor: 900 }],
      }),
    ]);
    t.clock.set(new Date('2026-10-05T01:00:00Z'));
    await t.freeze('2026-W40');
    t.clock.set(T0);
    const before = t.metrics.rateLimitDegraded();

    proxy.mode = 'refuse';
    try {
      const res = await t
        .http()
        .get('/api/leaderboards?period=week&id=2026-W40');
      expect(res.status).toBe(200);
      expect(
        leaderboardPageSchema.parse(res.body).entries.map((e) => e.shopId),
      ).toEqual([a.shopId]);
    } finally {
      proxy.mode = 'pass';
    }
    expect(t.metrics.rateLimitDegraded() - before).toBeGreaterThanOrEqual(1);
  });
});
