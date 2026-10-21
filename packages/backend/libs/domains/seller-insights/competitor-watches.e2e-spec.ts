import { v4 as uuidv4 } from 'uuid';
import {
  competitorPricesSchema,
  competitorWatchListSchema,
  competitorWatchSchema,
} from '@marketplace-sandbox/contracts';
import { AppError, ErrorArea } from '@app/common/errors';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { EntitlementsService } from '@app/domains/billing';
import {
  createCompetitorApp,
  T0,
  type CompetitorTestApp,
  type SeededShop,
  type TestUser,
} from './testing/competitor-fixtures';

const U1 = 'https://rival.test/p/iphone';
const U2 = 'https://rival.test/p/ipad';
const NOISY = 'HTTPS://Rival.test:443/p/iphone/?utm_source=ads&b=2&a=1#reviews';
const CLEAN = 'https://rival.test/p/iphone?a=1&b=2';

describe('Competitor monitor: watches API (registration, limits, isolation, history)', () => {
  let t: CompetitorTestApp;
  let A: SeededShop;
  let B: SeededShop;
  let C: SeededShop;
  let D: SeededShop;
  let stan: TestUser;
  let vic: TestUser;
  let PA: { id: string };
  let PA2: { id: string };
  let PX: { id: string };
  let PB: { id: string };

  beforeAll(async () => {
    t = await createCompetitorApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    A = await t.seedShop({ plan: 'PRO', limit: 5, announce: true });
    B = await t.seedShop({ plan: 'PRO', limit: 5, announce: true });
    C = await t.seedShop({ plan: 'STARTER', announce: true });
    D = await t.seedShop({ status: 'SUSPENDED', limit: 5, announce: true });
    stan = await t.member(A.shopId, 'STAFF');
    vic = await t.member(A.shopId, 'VIEWER');
    PA = await t.product(A.shopId, { priceMinor: 99_900, title: 'iPhone 17' });
    PA2 = await t.product(A.shopId, { priceMinor: 50_000 });
    PX = await t.product(A.shopId, { status: 'ARCHIVED' });
    PB = await t.product(B.shopId, { priceMinor: 85_000 });
  });

  const strip = (body: Record<string, unknown>) => {
    const { instance: _i, requestId: _r, ...rest } = body;
    return rest;
  };
  const problem = (
    res: { status: number; body: Record<string, unknown> },
    status: number,
    code: string,
  ) => {
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ status, code });
    for (const field of ['type', 'title', 'detail', 'instance', 'requestId'])
      expect(res.body[field]).toEqual(expect.any(String));
  };
  const counts = async () => ({
    targets: (
      await t.pg<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "CrawlTarget"`)
    )[0].n,
    watches: (
      await t.pg<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "CompetitorWatch"`,
      )
    )[0].n,
  });
  const route = (shopId: string, path = '') =>
    `/api/shops/${shopId}/competitors${path}`;

  describe('registration', () => {
    it('S41 AS-01: a watch is created with the cleaned URL, one target and one watch, and no request to the competitor', async () => {
      const res = await t.watch(stan, A.shopId, PA.id, NOISY);

      expect(res.status).toBe(201);
      const body = competitorWatchSchema.parse(res.body);
      expect(body).toMatchObject({
        productId: PA.id,
        url: CLEAN,
        host: 'rival.test',
        status: 'ACTIVE',
        lastPriceMinor: null,
        currency: null,
        lastCheckedAt: null,
        lastStatus: null,
        nextCheckAt: T0.toISOString(),
      });
      expect(Object.keys(res.body)).not.toContain('targetId');
      expect(await counts()).toEqual({ targets: 1, watches: 1 });
      expect(t.sites['rival.test'].log).toHaveLength(0);
      expect(t.sites['rival.test'].connections).toBe(0);
    });

    it('S41 AS-02: the same body and an equivalent spelling replay as 200 with the same id; a second URL is a new watch', async () => {
      const first = await t.watch(stan, A.shopId, PA.id, NOISY).expect(201);
      const same = await t.watch(stan, A.shopId, PA.id, NOISY);
      const spelled = await t.watch(stan, A.shopId, PA.id, `${CLEAN}&fbclid=z`);

      expect(same.status).toBe(200);
      expect(spelled.status).toBe(200);
      expect(same.body.id).toBe(first.body.id);
      expect(spelled.body.id).toBe(first.body.id);
      expect(await counts()).toEqual({ targets: 1, watches: 1 });

      const other = await t.watch(stan, A.shopId, PA.id, U2);
      expect(other.status).toBe(201);
      expect(other.body.id).not.toBe(first.body.id);
      expect(
        (await t.watchRows(A.shopId)).filter((w) => w.productId === PA.id),
      ).toHaveLength(2);
    });

    it('S41 AS-03: another shop watching the same URL shares the target and leaves its schedule alone', async () => {
      await t.watch(stan, A.shopId, PA.id, NOISY).expect(201);
      const before = await t.target(CLEAN);
      const res = await t.watch(B.owner, B.shopId, PB.id, CLEAN);

      expect(res.status).toBe(201);
      const after = await t.target(CLEAN);
      expect(await counts()).toEqual({ targets: 1, watches: 2 });
      expect(after!.id).toBe(before!.id);
      expect(after!.nextCheckAt).toEqual(before!.nextCheckAt);
      const rows = await t.watchRows();
      expect(new Set(rows.map((w) => w.id)).size).toBe(2);
      expect(new Set(rows.map((w) => w.targetId)).size).toBe(1);
    });

    it.each([
      ['no productId', () => ({ url: U1 }), ['productId']],
      ['no url', () => ({ productId: PA.id }), ['url']],
      [
        'a productId that is not a UUID',
        () => ({ productId: 'nope', url: U1 }),
        ['productId'],
      ],
      ['an empty url', () => ({ productId: PA.id, url: '' }), ['url']],
      [
        'a url that is not a URL',
        () => ({ productId: PA.id, url: 'not a url' }),
        ['url'],
      ],
      [
        'a url of 2049 characters',
        () => ({
          productId: PA.id,
          url: `https://rival.test/${'a'.repeat(2049 - 19)}`,
        }),
        ['url'],
      ],
      [
        'http',
        () => ({ productId: PA.id, url: 'http://rival.test/p' }),
        ['url'],
      ],
      ['ftp', () => ({ productId: PA.id, url: 'ftp://rival.test/p' }), ['url']],
      [
        'javascript',
        () => ({ productId: PA.id, url: 'javascript:alert(1)' }),
        ['url'],
      ],
      [
        'file',
        () => ({ productId: PA.id, url: 'file:///etc/passwd' }),
        ['url'],
      ],
      [
        'credentials in the URL',
        () => ({ productId: PA.id, url: 'https://u:p@rival.test/' }),
        ['url'],
      ],
      [
        'an unknown field',
        () => ({ productId: PA.id, url: U1, extra: 1 }),
        ['extra'],
      ],
    ])(
      'S41 AS-04: %s answers 400 validation_failed and stores nothing',
      async (_name, make, fields) => {
        const res = await t.as(stan).post(route(A.shopId)).send(make());

        problem(res, 400, 'validation_failed');
        expect(
          (res.body.errors as Array<{ field: string }>).map((e) => e.field),
        ).toEqual(expect.arrayContaining(fields));
        expect(await counts()).toEqual({ targets: 0, watches: 0 });
      },
    );

    it('S41 AS-04: a repeated field and a body that is not JSON answer 400 validation_failed', async () => {
      const repeated = await t
        .as(stan)
        .post(route(A.shopId))
        .set('Content-Type', 'application/json')
        .send(`{"productId":"${PA.id}","url":"${U1}","url":"${U2}"}`);
      const notJson = await t
        .as(stan)
        .post(route(A.shopId))
        .set('Content-Type', 'text/plain')
        .send(`productId=${PA.id}`);

      problem(repeated, 400, 'validation_failed');
      problem(notJson, 400, 'validation_failed');
      expect(await counts()).toEqual({ targets: 0, watches: 0 });
    });

    it.each([
      'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1/',
      'https://10.0.0.5/',
      'https://192.168.1.1/',
      'https://172.16.0.1/',
      'https://[::1]/',
      'https://[fc00::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://2130706433/',
      'https://localhost/',
      'https://mixed.test/',
      'https://rival.test:8443/p',
      'https://rival.test:22/p',
    ])(
      'S41 AS-05: %s is refused with 422 url_not_allowed and a generic detail',
      async (url) => {
        t.net.set('mixed.test', '93.184.216.34', '10.0.0.5');
        const res = await t.watch(stan, A.shopId, PA.id, url);

        problem(res, 422, 'url_not_allowed');
        expect(JSON.stringify(res.body)).not.toMatch(
          /10\.0\.0|127\.0|169\.254|ENOTFOUND|getaddrinfo/,
        );
        expect(await counts()).toEqual({ targets: 0, watches: 0 });
      },
    );

    it('S41 AS-05: a host that does not resolve answers 422 url_unresolvable; a public host is accepted', async () => {
      const gone = await t.watch(
        stan,
        A.shopId,
        PA.id,
        'https://nowhere.test/p',
      );
      problem(gone, 422, 'url_unresolvable');
      expect(await counts()).toEqual({ targets: 0, watches: 0 });

      await t.watch(stan, A.shopId, PA.id, U1).expect(201);
    });

    it("S41 AS-06: another shop's product and an unknown one are the same 404; an archived product is 409", async () => {
      const foreign = await t.watch(stan, A.shopId, PB.id, U1);
      const unknown = await t.watch(stan, A.shopId, uuidv4(), U1);
      const archived = await t.watch(stan, A.shopId, PX.id, U1);

      problem(foreign, 404, 'product_not_found');
      problem(unknown, 404, 'product_not_found');
      expect(strip(foreign.body)).toEqual(strip(unknown.body));
      problem(archived, 409, 'product_archived');
      expect(await counts()).toEqual({ targets: 0, watches: 0 });
    });
  });

  describe('tenant isolation and permissions', () => {
    it('S41 AS-07: a non-member, a malformed and an unknown shop id answer the same 404 shop_not_found on all four routes', async () => {
      const watch = await t.register(stan, A.shopId, PA.id, U1);
      const bo = B.owner;
      const calls = (shopId: string) => [
        () => t.watch(bo, shopId, PA.id, U1),
        () => t.as(bo).get(route(shopId)),
        () => t.as(bo).delete(route(shopId, `/${watch.id}`)),
        () => t.as(bo).get(route(shopId, `/${watch.id}/prices`)),
      ];
      const answers: Array<Record<string, unknown>> = [];
      for (const shopId of [A.shopId, 'not-a-uuid', uuidv4()])
        for (const call of calls(shopId)) {
          const res = await call();
          problem(res, 404, 'shop_not_found');
          answers.push(strip(res.body));
        }
      expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
      expect(await counts()).toEqual({ targets: 1, watches: 1 });
    });

    it('S41 AS-07: a viewer reads but cannot write; a suspended shop reads but cannot write; a closing shop refuses writes with 409', async () => {
      const watch = await t.register(stan, A.shopId, PA.id, U1);

      problem(
        await t.watch(vic, A.shopId, PA.id, U2),
        403,
        'permission_denied',
      );
      problem(
        await t.as(vic).delete(route(A.shopId, `/${watch.id}`)),
        403,
        'permission_denied',
      );
      await t.as(vic).get(route(A.shopId)).expect(200);
      await t
        .as(vic)
        .get(route(A.shopId, `/${watch.id}/prices`))
        .expect(200);

      const sPlus = await t.seedShop({ status: 'SUSPENDED', limit: 5 });
      const p = await t.product(sPlus.shopId);
      problem(
        await t.watch(sPlus.owner, sPlus.shopId, p.id, U1),
        403,
        'shop_suspended',
      );
      await t.as(sPlus.owner).get(route(sPlus.shopId)).expect(200);

      const closing = await t.seedShop({ status: 'DELETING', limit: 5 });
      const q = await t.product(closing.shopId);
      problem(
        await t.watch(closing.owner, closing.shopId, q.id, U1),
        409,
        'shop_offboarding',
      );
    });

    it("S41 AS-07: another shop's watch id is the same 404 as an unknown one; no credentials is 401", async () => {
      const mine = await t.register(B.owner, B.shopId, PB.id, U1);
      const foreignDelete = await t
        .as(stan)
        .delete(route(A.shopId, `/${mine.id}`));
      const unknownDelete = await t
        .as(stan)
        .delete(route(A.shopId, `/${uuidv4()}`));
      const foreignPrices = await t
        .as(stan)
        .get(route(A.shopId, `/${mine.id}/prices`));

      problem(foreignDelete, 404, 'watch_not_found');
      problem(foreignPrices, 404, 'watch_not_found');
      expect(strip(foreignDelete.body)).toEqual(strip(unknownDelete.body));
      expect((await t.watchRows(B.shopId)).length).toBe(1);

      for (const res of [
        await t
          .http()
          .post(route(A.shopId))
          .send({ productId: PA.id, url: U1 }),
        await t.http().get(route(A.shopId)),
        await t.http().delete(route(A.shopId, `/${mine.id}`)),
        await t.http().get(route(A.shopId, `/${mine.id}/prices`)),
      ]) {
        expect(res.status).toBe(401);
        expect(res.body.code).toEqual(expect.any(String));
      }
    });
  });

  describe('limits and concurrency', () => {
    const urls = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://rival.test/p/item-${i}`);

    it('S41 AS-08: the fifth watch of a shop is accepted, the sixth is refused with the shop limit; a replay at the limit is 200', async () => {
      const u = urls(6);
      const products = [PA.id, PA2.id];
      for (let i = 0; i < 5; i++)
        await t.watch(stan, A.shopId, products[i % 2], u[i]).expect(201);
      const sixth = await t.watch(stan, A.shopId, PA.id, u[5]);

      problem(sixth, 422, 'watch_limit_reached');
      expect(sixth.body).toMatchObject({ scope: 'shop', limit: 5 });
      expect(await t.watchRows(A.shopId)).toHaveLength(5);
      const replay = await t.watch(stan, A.shopId, products[0], u[0]);
      expect(replay.status).toBe(200);
    });

    it('S41 AS-08: a product with five watches refuses a sixth with the product limit', async () => {
      await t.limit(A.shopId, 100);
      const u = urls(6);
      for (let i = 0; i < 5; i++)
        await t.watch(stan, A.shopId, PA.id, u[i]).expect(201);
      const sixth = await t.watch(stan, A.shopId, PA.id, u[5]);

      problem(sixth, 422, 'watch_limit_reached');
      expect(sixth.body).toMatchObject({ scope: 'product', limit: 5 });
      await t.watch(stan, A.shopId, PA2.id, u[5]).expect(201);
    });

    it('S41 AS-08: a shop without the entitlement (limit 0) is refused', async () => {
      const p = await t.product(C.shopId);
      const res = await t.watch(C.owner, C.shopId, p.id, U1);

      problem(res, 422, 'watch_limit_reached');
      expect(res.body).toMatchObject({ scope: 'shop', limit: 0 });
      expect(await counts()).toEqual({ targets: 0, watches: 0 });
    });

    it('S41 AS-08: an entitlement service that cannot answer refuses the write with 503 and stores nothing', async () => {
      const spy = jest
        .spyOn(t.app.get(EntitlementsService), 'checkLimit')
        .mockRejectedValueOnce(
          new AppError({
            status: 503,
            code: 'entitlements_unavailable',
            title: 'Service Unavailable',
            detail: 'Entitlements could not be determined.',
            area: ErrorArea.TRANSIENT,
          }),
        );
      const res = await t.watch(stan, A.shopId, PA.id, U1);
      spy.mockRestore();

      problem(res, 503, 'entitlements_unavailable');
      expect(await counts()).toEqual({ targets: 0, watches: 0 });
    });

    it('S41 AS-09: ten identical registrations at once give one 201, nine 200 and one watch', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => t.watch(stan, A.shopId, PA.id, U1)),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 200)).toHaveLength(9);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await counts()).toEqual({ targets: 1, watches: 1 });
    });

    it('S41 AS-09: three different URLs at once at four of five watches give one 201 and two 422', async () => {
      const u = urls(7);
      for (let i = 0; i < 4; i++)
        await t.watch(stan, A.shopId, i % 2 ? PA.id : PA2.id, u[i]).expect(201);
      const results = await Promise.all(
        [4, 5, 6].map((i) => t.watch(stan, A.shopId, PA.id, u[i])),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const refused = results.filter((r) => r.status === 422);
      expect(refused).toHaveLength(2);
      for (const r of refused) expect(r.body.code).toBe('watch_limit_reached');
      expect(await t.watchRows(A.shopId)).toHaveLength(5);
    });

    it('S41 AS-10: the 31st write in a minute is 429 with Retry-After; another shop is unaffected', async () => {
      await t.limit(A.shopId, 100);
      const statuses: number[] = [];
      for (let i = 0; i < 30; i++)
        statuses.push((await t.watch(stan, A.shopId, PA.id, U1)).status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(29);
      const limited = await t.watch(stan, A.shopId, PA.id, U1);

      problem(limited, 429, 'rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      await t.watch(B.owner, B.shopId, PB.id, U1).expect(201);
      expect(await t.watchRows(A.shopId)).toHaveLength(1);
    });

    it('S41 AS-11: a registration pulls an old target forward, leaves a recent one alone and keeps a never-checked one due', async () => {
      const mark = (lastCheckedAtMs: number | null, nextCheckAtMs: number) =>
        t.pg(
          `UPDATE "CrawlTarget" SET "lastCheckedAt" = :last, "nextCheckAt" = :next WHERE "url" = :url`,
          {
            last: lastCheckedAtMs === null ? null : new Date(lastCheckedAtMs),
            next: new Date(nextCheckAtMs),
            url: U1,
          },
        );
      const hour = 3_600_000;
      await t.watch(stan, A.shopId, PA.id, U1).expect(201);

      await mark(T0.getTime() - 30 * 60_000, T0.getTime() + 5 * hour);
      await t.watch(B.owner, B.shopId, PB.id, U1).expect(201);
      expect((await t.target(U1))!.nextCheckAt).toEqual(
        new Date(T0.getTime() + 5 * hour),
      );

      await mark(T0.getTime() - 2 * hour, T0.getTime() + 4 * hour);
      const ownerB2 = await t.owner(B.shopId);
      const pb2 = await t.product(B.shopId);
      await t.watch(ownerB2, B.shopId, pb2.id, U1).expect(201);
      expect((await t.target(U1))!.nextCheckAt).toEqual(T0);

      await mark(null, T0.getTime());
      const pb3 = await t.product(B.shopId);
      await t.watch(B.owner, B.shopId, pb3.id, U1).expect(201);
      expect((await t.target(U1))!.nextCheckAt).toEqual(T0);
    });

    it('S41 AS-11: a hundred re-registrations never make a just-checked target due again', async () => {
      await t.limit(A.shopId, 100);
      await t.watch(stan, A.shopId, PA.id, U1).expect(201);
      await t.pg(
        `UPDATE "CrawlTarget" SET "lastCheckedAt" = :last, "nextCheckAt" = :next WHERE "url" = :url`,
        { last: T0, next: new Date(T0.getTime() + 6 * 3_600_000), url: U1 },
      );
      for (let i = 0; i < 100; i += 10)
        await Promise.all(
          Array.from({ length: 10 }, () => t.watch(stan, A.shopId, PA.id, U1)),
        );

      expect((await t.target(U1))!.nextCheckAt).toEqual(
        new Date(T0.getTime() + 6 * 3_600_000),
      );
    });
  });

  describe('list, remove and price history', () => {
    const item = (i: number) => `https://rival.test/p/item-${i}`;
    /** `n` watches of shop A, one second apart (oldest first), on PA and PA2. */
    const seedWatches = async (n: number) => {
      await t.limit(A.shopId, 100);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        t.advance(1_000);
        ids.push(
          (await t.register(stan, A.shopId, i % 2 ? PA.id : PA2.id, item(i)))
            .id,
        );
      }
      return ids;
    };
    const page = (query = '') => t.as(vic).get(route(A.shopId) + query);

    it('S41 AS-12: seven watches page by three, newest first, without gaps or repeats while another is added', async () => {
      const ids = await seedWatches(7);
      await t.pg(
        `UPDATE "CrawlTarget" SET "lastPriceMinor" = 89900, "currency" = 'EUR' WHERE "url" = :url`,
        {
          url: item(6),
        },
      );

      const first = await page('?limit=3').expect(200);
      const one = competitorWatchListSchema.parse(first.body);
      expect(one.items.map((w) => w.id)).toEqual([ids[6], ids[5], ids[4]]);
      expect(Object.keys(one.items[0]).sort()).toEqual(
        [
          'createdAt',
          'currency',
          'host',
          'id',
          'lastCheckedAt',
          'lastPriceMinor',
          'lastStatus',
          'nextCheckAt',
          'productId',
          'status',
          'url',
        ].sort(),
      );
      expect(one.items[0]).toMatchObject({
        lastPriceMinor: 89900,
        currency: 'EUR',
        url: item(6),
      });

      t.advance(1_000);
      await t.register(stan, A.shopId, PA2.id, item(99));
      const second = competitorWatchListSchema.parse(
        (
          await page(
            `?limit=3&cursor=${encodeURIComponent(one.nextCursor!)}`,
          ).expect(200)
        ).body,
      );
      const third = competitorWatchListSchema.parse(
        (
          await page(
            `?limit=3&cursor=${encodeURIComponent(second.nextCursor!)}`,
          ).expect(200)
        ).body,
      );
      expect([...second.items, ...third.items].map((w) => w.id)).toEqual([
        ids[3],
        ids[2],
        ids[1],
        ids[0],
      ]);
      expect(third.nextCursor).toBeNull();
    });

    it('S41 AS-12: the product filter, the default limit and the foreign shop', async () => {
      const ids = await seedWatches(4);
      await t.register(B.owner, B.shopId, PB.id, item(0));

      const filtered = competitorWatchListSchema.parse(
        (await page(`?productId=${PA.id}`).expect(200)).body,
      );
      expect(filtered.items.map((w) => w.id).sort()).toEqual(
        [ids[1], ids[3]].sort(),
      );
      const all = competitorWatchListSchema.parse(
        (await page().expect(200)).body,
      );
      expect(all.items).toHaveLength(4);
      expect(all.nextCursor).toBeNull();
      const one = competitorWatchListSchema.parse(
        (await page('?limit=1').expect(200)).body,
      );
      expect(one.items).toHaveLength(1);
      expect(one.nextCursor).toEqual(expect.any(String));
      const max = await page('?limit=100').expect(200);
      expect(max.body.items).toHaveLength(4);
    });

    it.each([
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?cursor=garbage',
      '?foo=1',
      '?productId=nope',
      '?limit=1&limit=2',
    ])('S41 AS-12: %s answers 400 validation_failed', async (query) => {
      await seedWatches(1);
      problem(await page(query), 400, 'validation_failed');
    });

    it("S41 AS-13: removing a watch leaves the other shop's watch and the target; a repeat is 404; the last watch retires the target", async () => {
      const mine = await t.register(stan, A.shopId, PA.id, U1);
      const theirs = await t.register(B.owner, B.shopId, PB.id, U1);

      await t
        .as(stan)
        .delete(route(A.shopId, `/${mine.id}`))
        .expect(204);
      problem(
        await t.as(stan).delete(route(A.shopId, `/${mine.id}`)),
        404,
        'watch_not_found',
      );
      expect((await t.watchRows()).map((w) => w.id)).toEqual([theirs.id]);
      expect((await t.target(U1))!.retiredAt).toBeNull();

      await t
        .as(B.owner)
        .delete(route(B.shopId, `/${theirs.id}`))
        .expect(204);
      expect(await t.watchRows()).toHaveLength(0);
      expect((await t.target(U1))!.retiredAt).not.toBeNull();
    });

    it('S41 AS-13: a retired target is not scheduled and a queued entry is dropped without a request', async () => {
      t.sites['rival.test'].priced('/p/iphone', 899);
      const watch = await t.register(stan, A.shopId, PA.id, U1);
      expect(await t.schedule()).toBe(1);

      await t
        .as(stan)
        .delete(route(A.shopId, `/${watch.id}`))
        .expect(204);
      await t.drain();

      expect(t.sites['rival.test'].log).toHaveLength(0);
      t.advance(7 * 3_600_000);
      expect(await t.schedule()).toBe(0);
    });

    it('S41 AS-13: a removal racing a crawl neither fails nor leaves a watch behind', async () => {
      t.sites['rival.test'].priced('/p/iphone', 899);
      const watch = await t.register(stan, A.shopId, PA.id, U1);
      await t.schedule();

      const [removed] = await Promise.all([
        t.as(stan).delete(route(A.shopId, `/${watch.id}`)),
        t.drain(),
      ]);

      expect(removed.status).toBe(204);
      expect(await t.watchRows()).toHaveLength(0);
    });

    const insertPrices = async (
      targetId: string,
      rows: Array<{ daysAgo: number; priceMinor: number; currency?: string }>,
    ) => {
      const ch = t.app.get(ClickHouseService).getClient();
      await ch.insert({
        table: 'competitor_prices',
        format: 'JSONEachRow',
        values: rows.map((r, i) => ({
          target_id: targetId,
          ts: new Date(T0.getTime() - r.daysAgo * 86_400_000)
            .toISOString()
            .replace('T', ' ')
            .replace('Z', ''),
          price_minor: r.priceMinor,
          currency: r.currency ?? 'EUR',
          observation_no: i + 1,
        })),
      });
    };
    const prices = (watchId: string, query = '') =>
      t.as(vic).get(route(A.shopId, `/${watchId}/prices${query}`));

    it('S41 AS-14: the history is oldest first with the lowest, its earliest instant and the latest price', async () => {
      const watch = await t.register(stan, A.shopId, PA.id, U1);
      const target = (await t.target(U1))!;
      await insertPrices(target.id, [
        { daysAgo: 10, priceMinor: 89_900 },
        { daysAgo: 5, priceMinor: 94_900 },
        { daysAgo: 1, priceMinor: 89_900 },
      ]);

      const month = competitorPricesSchema.parse(
        (await prices(watch.id, '?days=30').expect(200)).body,
      );
      expect(month).toMatchObject({
        watchId: watch.id,
        currency: 'EUR',
        lowestMinor: 89_900,
        lowestAt: new Date(T0.getTime() - 10 * 86_400_000).toISOString(),
        latestMinor: 89_900,
        to: T0.toISOString(),
      });
      expect(month.points.map((p) => p.priceMinor)).toEqual([
        89_900, 94_900, 89_900,
      ]);
      const week = competitorPricesSchema.parse(
        (await prices(watch.id, '?days=7').expect(200)).body,
      );
      expect(week.points.map((p) => p.priceMinor)).toEqual([94_900, 89_900]);
      expect(week.lowestAt).toBe(
        new Date(T0.getTime() - 86_400_000).toISOString(),
      );
      const dflt = competitorPricesSchema.parse(
        (await prices(watch.id).expect(200)).body,
      );
      expect(dflt.points).toHaveLength(3);
    });

    it('S41 AS-14: no observation is an empty history; invalid days are 400; at most 1000 newest points', async () => {
      const watch = await t.register(stan, A.shopId, PA.id, U1);
      const empty = competitorPricesSchema.parse(
        (await prices(watch.id).expect(200)).body,
      );
      expect(empty).toMatchObject({
        points: [],
        lowestMinor: null,
        lowestAt: null,
        latestMinor: null,
      });

      for (const bad of ['?days=0', '?days=366', '?days=abc'])
        problem(await prices(watch.id, bad), 400, 'validation_failed');

      const target = (await t.target(U1))!;
      await insertPrices(
        target.id,
        Array.from({ length: 1_100 }, (_, i) => ({
          daysAgo: 29 - i / 40,
          priceMinor: 100_000 + i,
        })),
      );
      const capped = competitorPricesSchema.parse(
        (await prices(watch.id, '?days=30').expect(200)).body,
      );
      expect(capped.points).toHaveLength(1_000);
      expect(capped.latestMinor).toBe(101_099);
      expect(capped.points[0].priceMinor).toBe(100_100);
    });

    it('S41 AS-15: with the history store down the prices answer 503 history_unavailable at once while the list stays up', async () => {
      const watch = await t.register(stan, A.shopId, PA.id, U1);
      await t.pg(
        `UPDATE "CrawlTarget" SET "lastPriceMinor" = 89900, "currency" = 'EUR' WHERE "url" = :url`,
        { url: U1 },
      );
      t.faults.history = true;

      const started = Date.now();
      const down = await prices(watch.id);
      const list = await page().expect(200);

      problem(down, 503, 'history_unavailable');
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(JSON.stringify(down.body)).not.toMatch(/ECONNREFUSED|clickhouse/i);
      expect(list.body.items[0]).toMatchObject({
        lastPriceMinor: 89_900,
        currency: 'EUR',
      });
    });
  });
});

describe('Competitor monitor: watches API with the limiter store down', () => {
  let proxy: TcpFaultProxy;
  let t: CompetitorTestApp;

  beforeAll(async () => {
    const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    proxy = await TcpFaultProxy.start({
      host: url.hostname,
      port: Number(url.port || 6379),
    });
    t = await createCompetitorApp({
      env: { REDIS_URL: `redis://127.0.0.1:${proxy.port}/${new URL(process.env.REDIS_URL ?? "redis://localhost:6400/0").pathname.slice(1) || "0"}` },
      sites: ['rival.test'],
    });
  });
  afterAll(async () => {
    proxy.mode = 'pass';
    await t.close();
    await proxy.close();
  });

  it('S41 AS-10: when the limiter store is unreachable writes answer 503 and nothing is stored, while reads are served', async () => {
    await t.reset();
    const shop = await t.seedShop({ plan: 'PRO', limit: 5, announce: true });
    const [first, second] = [
      await t.product(shop.shopId),
      await t.product(shop.shopId),
    ];
    await t.watch(shop.owner, shop.shopId, first.id, U1).expect(201);

    proxy.mode = 'refuse';
    proxy.sever();
    const refused = await waitFor(
      async () => {
        const res = await t.watch(shop.owner, shop.shopId, second.id, U2);
        return res.status === 503 ? res : false;
      },
      { timeoutMs: 15_000, intervalMs: 100, description: 'fail closed' },
    );
    // the platform's closed-failure answer (S50); the spec lists it as `service_unavailable`
    expect(refused.body).toMatchObject({
      status: 503,
      code: 'rate_limiter_unavailable',
    });
    const read = await t
      .as(shop.owner)
      .get(`/api/shops/${shop.shopId}/competitors`);
    proxy.mode = 'pass';

    expect(read.status).toBe(200);
    expect(await t.watchRows(shop.shopId)).toHaveLength(1);
  }, 60_000);
});
