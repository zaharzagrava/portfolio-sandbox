import { randomUUID } from 'node:crypto';
import {
  flashSalePublicSchema,
  flashSalesResponseSchema,
} from '@marketplace-sandbox/contracts';
import { recordStatements } from '@app/test/utils/catalog-fixtures';
import {
  createFlashApp,
  seedSeller,
  type FlashTestApp,
  type Seller,
} from './testing/flash-kit';
import {
  DROP_PRICE,
  MIN,
  REGULAR_PRICE,
  T,
  at,
  sum,
} from './testing/flash-scenarios';

const HOUR = 60 * MIN;
const PUBLIC_FIELDS = [
  'currency',
  'endsAt',
  'perUserLimit',
  'priceMinor',
  'productId',
  'remainingApprox',
  'saleId',
  'serverTime',
  'startsAt',
  'state',
];

describe('Flash sales: public view and cache behaviour', () => {
  let t: FlashTestApp;

  beforeAll(async () => {
    t = await createFlashApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    t.clock.set(T);
  });

  interface Sale {
    id: string;
    productId: string;
    units: number;
    buckets: number;
  }

  let seller: Seller;
  /** Schedules a sale on a fresh product of the current seller (from `offsetMin` after T, `lengthMin` long). */
  const schedule = async (
    over: {
      offsetMin?: number;
      lengthMin?: number;
      units?: number;
      buckets?: number;
      productId?: string;
    } = {},
  ): Promise<Sale> => {
    const units = over.units ?? 30;
    const buckets = over.buckets ?? 4;
    const productId = over.productId ?? seller.products.shift()!.id;
    const res = await t
      .as(seller.owner)
      .post(`/api/shops/${seller.shop.id}/flash-sales`)
      .send({
        productId,
        priceMinor: DROP_PRICE,
        units,
        buckets,
        perUserLimit: 2,
        startsAt: at((over.offsetMin ?? 10) * MIN).toISOString(),
        endsAt: at(
          ((over.offsetMin ?? 10) + (over.lengthMin ?? 60)) * MIN,
        ).toISOString(),
      });
    expect(res.status).toBe(201);
    return { id: res.body.id, productId, units, buckets };
  };
  const loadAt = async (s: Sale, minute: number) => {
    t.clock.set(at(minute * MIN));
    await t.jobs.load({ saleId: s.id });
  };
  const later = (ms: number) => t.clock.set(new Date(t.clock.nowMs() + ms));
  const read = (id: string) => t.http().get(`/api/flash-sales/${id}`);
  const batch = (ids: string[]) =>
    t.http().get(`/api/flash-sales?productIds=${ids.join(',')}`);

  beforeEach(async () => {
    seller = await seedSeller(
      t,
      Array.from({ length: 12 }, () => ({
        priceMinor: REGULAR_PRICE,
        quantity: 500,
      })),
    );
  });

  describe('the view in each state (AS-38)', () => {
    it('S11 AS-38: UPCOMING, LIVE, SOLD_OUT and ENDED, exactly the public fields, cacheable for a second', async () => {
      const upcoming = await schedule({ offsetMin: 10 });
      const live = await schedule({ offsetMin: 10 });
      const soldOut = await schedule({ offsetMin: 10 });
      await loadAt(live, 9);
      await loadAt(soldOut, 9);

      // before the start: the sale is announced, the total is not
      t.clock.set(at(5 * MIN));
      const before = await read(upcoming.id);
      expect(before.status).toBe(200);
      expect(before.headers['cache-control']).toBe('public, s-maxage=1');
      expect(Object.keys(before.body).sort()).toEqual(PUBLIC_FIELDS);
      expect(flashSalePublicSchema.parse(before.body)).toMatchObject({
        saleId: upcoming.id,
        state: 'UPCOMING',
        remainingApprox: null,
        priceMinor: DROP_PRICE,
        perUserLimit: 2,
      });
      expect(before.body.degraded).toBeUndefined();

      // inside the window
      t.clock.set(at(11 * MIN));
      const running = await read(live.id);
      expect(flashSalePublicSchema.parse(running.body)).toMatchObject({
        state: 'LIVE',
        remainingApprox: 30,
      });
      expect(Object.keys(running.body).sort()).toEqual(PUBLIC_FIELDS);
      expect(new Date(running.body.serverTime).toISOString()).toBe(
        t.clock.now().toISOString(),
      );

      for (let b = 0; b < soldOut.buckets; b++)
        await t.redis.set(`flash:{${soldOut.id}:${b}}:stock`, 0);
      later(5_000);
      const empty = await read(soldOut.id);
      expect(flashSalePublicSchema.parse(empty.body)).toMatchObject({
        state: 'SOLD_OUT',
        remainingApprox: 0,
      });

      // after the end, also once reconciled
      t.clock.set(at(71 * MIN));
      await t.jobs.end({ saleId: live.id });
      later(5_000);
      const ended = await read(live.id);
      expect(flashSalePublicSchema.parse(ended.body)).toMatchObject({
        state: 'ENDED',
        remainingApprox: 0,
      });
      t.clock.set(at(87 * MIN));
      await t.jobs.reconcile({ saleId: live.id });
      later(5_000);
      expect((await read(live.id)).body.state).toBe('ENDED');
    });

    it('S11 AS-38: unknown, cancelled, failed and far-future sales answer 404 flash_sale_not_found', async () => {
      const cancelled = await schedule({ offsetMin: 10 });
      const failed = await schedule({ offsetMin: 10 });
      const far = await schedule({ offsetMin: 48 * 60 });
      await exec_cancel(cancelled.id);
      t.clock.set(at(70 * MIN));
      await t.jobs.end({ saleId: failed.id }); // never loaded → START_FAILED(window_missed)

      for (const id of [randomUUID(), cancelled.id, failed.id, far.id]) {
        const res = await read(id);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('flash_sale_not_found');
      }
      expect((await read('not-a-uuid')).status).toBe(400);
    });
  });

  const exec_cancel = async (saleId: string) => {
    const res = await t
      .as(seller.owner)
      .post(`/api/shops/${seller.shop.id}/flash-sales/${saleId}/cancel`);
    expect(res.status).toBe(200);
  };

  describe('batch by product (AS-39)', () => {
    it('S11 AS-39: one view per product that has a sale, none for the others; the open sale wins over the next one', async () => {
      const open = await schedule({ offsetMin: 10, lengthMin: 60 });
      const next = await schedule({
        productId: open.productId,
        offsetMin: 120,
        lengthMin: 30,
      });
      const upcoming = await schedule({ offsetMin: 20 });
      const without = seller.products[0].id;
      await loadAt(open, 9);
      t.clock.set(at(11 * MIN));

      const res = await batch([
        open.productId,
        upcoming.productId,
        without,
        open.productId,
      ]);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, s-maxage=1');
      const views = flashSalesResponseSchema.parse(res.body);
      expect(views.map((v) => [v.productId, v.saleId, v.state]).sort()).toEqual(
        [
          [open.productId, open.id, 'LIVE'],
          [upcoming.productId, upcoming.id, 'UPCOMING'],
        ].sort(),
      );
      expect(views.some((v) => v.saleId === next.id)).toBe(false);
    });

    it.each([
      [
        'more than 100 ids',
        Array.from({ length: 101 }, () => randomUUID()).join(','),
      ],
      ['a malformed id', `${randomUUID()},nope`],
      ['an empty list', ''],
    ])('S11 AS-39: %s → 400', async (_name, ids) => {
      const res = await t.http().get(`/api/flash-sales?productIds=${ids}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });

    it('S11 AS-39: a missing productIds parameter → 400; exactly 100 ids are accepted', async () => {
      expect((await t.http().get('/api/flash-sales')).status).toBe(400);
      const ids = Array.from({ length: 100 }, () => randomUUID());
      const res = await batch(ids);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('stampede and degradation (AS-40)', () => {
    it('S11 AS-40: 1,000 reads cost at most one bucket read and one statement in a second, and none while the entry is fresh', async () => {
      const sale = await schedule({ offsetMin: 10, units: 40, buckets: 8 });
      await loadAt(sale, 9);
      t.clock.set(at(11 * MIN));
      expect((await read(sale.id)).status).toBe(200); // warm

      // fresh entry: 500 concurrent reads touch neither the bucket keys nor the database
      const warm = await recordStatements(t.app, () =>
        t.recordRedisCommands(() =>
          Promise.all(Array.from({ length: 500 }, () => read(sale.id))),
        ),
      );
      expect(warm.result.result.every((r) => r.status === 200)).toBe(true);
      expect(warm.statements).toEqual([]);
      const bucketReads = (cmds: string[][]) =>
        cmds.filter(
          (c) => c[0].toLowerCase() === 'get' && c[1].startsWith('flash:{'),
        ).length;
      expect(bucketReads(warm.result.commands)).toBe(0);

      // the entry has aged out: 500 concurrent reads share one refresh (one reading of the 8 buckets, one statement)
      later(2_500);
      await t.clearRateLimits();
      const cold = await recordStatements(t.app, () =>
        t.recordRedisCommands(() =>
          Promise.all(Array.from({ length: 500 }, () => read(sale.id))),
        ),
      );
      expect(cold.result.result.every((r) => r.status === 200)).toBe(true);
      expect(cold.statements.length).toBeLessThanOrEqual(1);
      expect(bucketReads(cold.result.commands)).toBeLessThanOrEqual(
        sale.buckets,
      );
    });

    it('S11 AS-40: when the store fails the view stays 200 with remainingApprox null and degraded', async () => {
      const sale = await schedule({ offsetMin: 10 });
      await loadAt(sale, 9);
      t.clock.set(at(11 * MIN));
      await t.denyStore();
      const res = await read(sale.id);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        state: 'LIVE',
        remainingApprox: null,
        degraded: true,
      });
      expect(flashSalePublicSchema.parse(res.body).degraded).toBe(true);
      await t.allowStore();
      later(5_000);
      expect((await read(sale.id)).body).toMatchObject({ remainingApprox: 30 });
    });
  });

  describe('remaining is sane (AS-41)', () => {
    it('S11 AS-41: an integer in [0, units], never negative with a negative bucket, at most 2 s old, 0 and SOLD_OUT at the last unit', async () => {
      const sale = await schedule({ offsetMin: 10, units: 12, buckets: 4 });
      await loadAt(sale, 9);
      t.clock.set(at(11 * MIN));
      const first = await read(sale.id);
      expect(first.body.remainingApprox).toBe(12);

      await t.redis.decrby(`flash:{${sale.id}:0}:stock`, 2); // two units sold (3 → 1)
      later(2_100); // past the second of freshness and the second of stale-while-revalidate: the next read reloads
      const sold = await read(sale.id);
      expect(Number.isInteger(sold.body.remainingApprox)).toBe(true);
      expect(sold.body.remainingApprox).toBe(10);

      await t.redis.set(`flash:{${sale.id}:0}:stock`, -4); // a negative bucket never shows
      later(2_100); // past the second of freshness and the second of stale-while-revalidate: the next read reloads
      const negative = await read(sale.id);
      expect(negative.body.remainingApprox).toBe(9);
      expect(negative.body.remainingApprox).toBeGreaterThanOrEqual(0);
      expect(negative.body.remainingApprox).toBeLessThanOrEqual(12);

      for (let b = 0; b < 4; b++)
        await t.redis.set(`flash:{${sale.id}:${b}}:stock`, b === 3 ? 1 : 0);
      later(2_100); // past the second of freshness and the second of stale-while-revalidate: the next read reloads
      expect((await read(sale.id)).body).toMatchObject({
        remainingApprox: 1,
        state: 'LIVE',
      });
      await t.redis.set(`flash:{${sale.id}:3}:stock`, 0);
      later(2_100); // past the second of freshness and the second of stale-while-revalidate: the next read reloads
      const last = await read(sale.id);
      expect(last.body).toMatchObject({
        remainingApprox: 0,
        state: 'SOLD_OUT',
      });
      expect(sum([last.body.remainingApprox])).toBe(0);
    });
  });
});
