import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import {
  eventEnvelopeSchema,
  flashSaleEventSchemas,
  type FlashSaleEventType,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { ProductStockService } from '@app/domains/catalog';
import { JOB_HANDLER_METADATA } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsTestProbe } from '@app/infrastructure/jobs/jobs-test-probe';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { PaymentResultService } from './application/payment-result.service';
import { FlashSaleJobs } from './infra/flash-sale.jobs';
import { exec, rows, seedPendingOrder, stockOf } from './testing/orders-app';
import {
  addToCart,
  checkoutAs,
  countRows,
  openDrop,
  orderStatus,
  sum,
} from './testing/flash-scenarios';
import {
  createFlashApp,
  seedSeller,
  type FlashTestApp,
  type Seller,
} from './testing/flash-kit';

const MIN = 60_000;
const HOUR = 3_600_000;
const T = new Date('2026-10-14T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms);

describe('Flash sales: load, end, reconcile and never oversell', () => {
  let t: FlashTestApp;
  let probe: JobsTestProbe;

  beforeAll(async () => {
    t = await createFlashApp();
    probe = new JobsTestProbe(t.app.get(Sequelize));
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    t.clock.set(T);
  });

  interface Drop {
    s: Seller;
    productId: string;
    id: string;
    units: number;
    buckets: number;
  }

  /** A SCHEDULED sale (start T+10 min, end T+70 min) on a product with `qty` units, made through the route. */
  const schedule = async (
    over: {
      qty?: number;
      units?: number;
      buckets?: number;
      limit?: number;
    } = {},
  ): Promise<Drop> => {
    const units = over.units ?? 3000;
    const buckets = over.buckets ?? 16;
    t.clock.set(T); // a spec may schedule several sales, each from the same starting point
    const s = await seedSeller(t, [
      { priceMinor: 59_900, quantity: over.qty ?? 5000 },
    ]);
    const res = await t
      .as(s.owner)
      .post(`/api/shops/${s.shop.id}/flash-sales`)
      .send({
        productId: s.products[0].id,
        priceMinor: 49_900,
        units,
        buckets,
        perUserLimit: over.limit ?? 2,
        startsAt: at(10 * MIN).toISOString(),
        endsAt: at(70 * MIN).toISOString(),
      });
    expect(res.status).toBe(201);
    return { s, productId: s.products[0].id, id: res.body.id, units, buckets };
  };
  const loadNow = (d: Drop) => {
    t.clock.set(at(9 * MIN));
    return t.jobs.load({ saleId: d.id });
  };
  const loaded = async (over: Parameters<typeof schedule>[0] = {}) => {
    const d = await schedule(over);
    await loadNow(d);
    return d;
  };
  const statusOf = async (id: string) =>
    (
      await rows<{ status: string; statusReason: string | null }>(
        t.app,
        `SELECT "status", "statusReason" FROM "FlashSale" WHERE "id" = :id`,
        { id },
      )
    )[0];
  const operations = (id: string) =>
    rows<{ operationId: string; delta: number; reason: string }>(
      t.app,
      `SELECT "operationId", "delta", "reason" FROM "ProductStockOperation" WHERE "operationId" LIKE :like ORDER BY "operationId"`,
      { like: `orders:flash:${id}:%` },
    );
  const events = async (id: string, type?: FlashSaleEventType) =>
    (await outboxRowsFor(t.app, id)).filter(
      (r) => r.type?.startsWith('flashsale.') && (!type || r.type === type),
    );
  const stock = async (d: Drop) =>
    (await stockOf(t.app, [d.productId]))[d.productId];

  /** A durable flash reservation (and its order) for a sale, as checkout leaves it. */
  const hold = async (
    d: Drop,
    quantity: number,
    status: 'HELD' | 'CONVERTED' | 'RELEASE_PENDING' | 'RELEASED',
    when = new Date(),
  ) => {
    const user = await t.newUser();
    const order = await seedPendingOrder(t.app, {
      userId: user.id,
      lines: [
        {
          productId: d.productId,
          shopId: d.s.shop.id,
          quantity,
          unitPriceMinor: 49_900,
        },
      ],
    });
    // the order's own repository already wrote its reservation row: make it a drop reservation
    await exec(
      t.app,
      `UPDATE "StockReservation" SET "source" = 'FLASH', "sourceRef" = :ref, "flashSaleId" = :saleId, "status" = :status,
         "expiresAt" = :expiresAt, "createdAt" = :createdAt WHERE "bisOrderId" = :orderId AND "productId" = :productId`,
      {
        orderId: order.id,
        productId: d.productId,
        ref: randomUUID(),
        saleId: d.id,
        status,
        expiresAt: new Date(when.getTime() + 15 * MIN),
        createdAt: when,
      },
    );
    return { user, order };
  };
  const setHolds = (d: Drop, status: string, to: string) =>
    exec(
      t.app,
      `UPDATE "StockReservation" SET "status" = :to WHERE "flashSaleId" = :id AND "status" = :status`,
      { id: d.id, status, to },
    );

  describe('load (AS-20, AS-21, AS-22)', () => {
    it('S11 AS-20: stock leaves through orders:flash:<id>:load, 16 buckets of 188/187, LOADED, one event', async () => {
      const d = await schedule();
      expect(await t.keysOf(d.id)).toEqual([]);
      expect(await loadNow(d)).toBeUndefined();

      expect(await stock(d)).toBe(2000);
      expect(await operations(d.id)).toEqual([
        {
          operationId: `orders:flash:${d.id}:load`,
          delta: -3000,
          reason: 'flash.load',
        },
      ]);
      const buckets = await t.buckets(d.id, 16);
      expect(buckets).toHaveLength(16);
      expect(buckets.reduce((a, b) => a + b, 0)).toBe(3000);
      expect(Math.max(...buckets) - Math.min(...buckets)).toBeLessThanOrEqual(
        1,
      );
      expect([...new Set(buckets)].sort()).toEqual([187, 188]);
      expect(await statusOf(d.id)).toEqual({
        status: 'LOADED',
        statusReason: null,
      });

      const [event] = await events(d.id, 'flashsale.loaded');
      expect(await events(d.id, 'flashsale.loaded')).toHaveLength(1);
      eventEnvelopeSchema.parse(event.payload);
      expect(
        flashSaleEventSchemas['flashsale.loaded'].parse(event.payload.payload),
      ).toMatchObject({
        saleId: d.id,
        units: 3000,
        buckets: 16,
      });
    });

    it('S11 AS-20: nothing is open before the load, and the load happens at startsAt − 60 s', async () => {
      const d = await schedule();
      const [job] = await probe.find('flash-sale.load', { saleId: d.id });
      expect(new Date(job.runAt)).toEqual(at(9 * MIN));
      expect((await statusOf(d.id)).status).toBe('SCHEDULED');
    });

    it('S11 AS-21: redelivery and simultaneous delivery after 5 units sold lower stock once and keep 2995 in the buckets', async () => {
      const d = await loaded();
      await t.redis.decrby(`flash:{${d.id}:0}:stock`, 5); // five units sold
      await Promise.all([
        t.jobs.load({ saleId: d.id }),
        t.jobs.load({ saleId: d.id }),
        t.jobs.load({ saleId: d.id }),
      ]);
      await t.jobs.load({ saleId: d.id });

      expect(await stock(d)).toBe(2000);
      expect((await t.buckets(d.id, 16)).reduce((a, b) => a + b, 0)).toBe(2995);
      expect(await events(d.id, 'flashsale.loaded')).toHaveLength(1);
      expect((await operations(d.id)).map((o) => o.operationId)).toEqual([
        `orders:flash:${d.id}:load`,
      ]);
    });

    it('S11 AS-21: simultaneous first deliveries end in the state of one clean run', async () => {
      const d = await schedule();
      t.clock.set(at(9 * MIN));
      await Promise.all([
        t.jobs.load({ saleId: d.id }),
        t.jobs.load({ saleId: d.id }),
      ]);
      expect(await stock(d)).toBe(2000);
      expect((await t.buckets(d.id, 16)).reduce((a, b) => a + b, 0)).toBe(3000);
      expect((await statusOf(d.id)).status).toBe('LOADED');
      expect(await events(d.id, 'flashsale.loaded')).toHaveLength(1);
    });

    it.each(['load:after-stock', 'load:after-buckets'])(
      'S11 AS-21: a crash at %s and a retry equal one clean run',
      async (point) => {
        const d = await schedule();
        t.clock.set(at(9 * MIN));
        t.crash.arm(point);
        await expect(t.jobs.load({ saleId: d.id })).rejects.toThrow(
          `crash at ${point}`,
        );
        expect((await statusOf(d.id)).status).toBe('SCHEDULED');

        await t.jobs.load({ saleId: d.id });
        expect(await stock(d)).toBe(2000);
        expect((await t.buckets(d.id, 16)).reduce((a, b) => a + b, 0)).toBe(
          3000,
        );
        expect((await statusOf(d.id)).status).toBe('LOADED');
        expect(await events(d.id, 'flashsale.loaded')).toHaveLength(1);
        expect(await operations(d.id)).toHaveLength(1);
      },
    );

    it('S11 AS-22: not enough stock → START_FAILED(insufficient_stock), nothing taken, no retry', async () => {
      const d = await schedule({ qty: 100, units: 80, buckets: 4 });
      await t.app.get(ProductStockService).applyStockDelta([
        {
          operationId: `test:${randomUUID()}`,
          productId: d.productId,
          shopId: d.s.shop.id,
          delta: -90,
          reason: 'test.sale',
        },
      ]);
      await expect(loadNow(d)).resolves.toBeUndefined(); // handled, not thrown: the job must not retry
      expect(await statusOf(d.id)).toEqual({
        status: 'START_FAILED',
        statusReason: 'insufficient_stock',
      });
      expect(await stock(d)).toBe(10);
      expect(await t.keysOf(d.id)).toEqual([]);
      const [event] = await events(d.id, 'flashsale.start_failed');
      expect(
        flashSaleEventSchemas['flashsale.start_failed'].parse(
          event.payload.payload,
        ).reason,
      ).toBe('insufficient_stock');
    });

    it('S11 AS-22: an archived product → START_FAILED(product_unavailable)', async () => {
      const d = await schedule();
      await exec(
        t.app,
        `UPDATE "Product" SET "status" = 'ARCHIVED' WHERE "id" = :id`,
        { id: d.productId },
      );
      await loadNow(d);
      expect(await statusOf(d.id)).toEqual({
        status: 'START_FAILED',
        statusReason: 'product_unavailable',
      });
    });

    it('S11 AS-22: a fast store that refuses commands fails the job for retry (up to 8 attempts) and the retry completes', async () => {
      const d = await schedule();
      const [job] = await rows<{ maxAttempts: number }>(
        t.app,
        `SELECT "maxAttempts" FROM "Job" WHERE "type" = 'flash-sale.load' AND "payload"->>'saleId' = :id`,
        { id: d.id },
      );
      expect(job.maxAttempts).toBe(8);

      await t.denyStore();
      t.clock.set(at(9 * MIN));
      await expect(t.jobs.load({ saleId: d.id })).rejects.toThrow();
      expect((await statusOf(d.id)).status).toBe('SCHEDULED');

      await t.allowStore();
      await t.jobs.load({ saleId: d.id });
      expect((await statusOf(d.id)).status).toBe('LOADED');
      expect(await stock(d)).toBe(2000);
      expect(await operations(d.id)).toHaveLength(1);
    });

    it('S11 AS-22: a load that comes too late (window missed) is reversed through the return operation', async () => {
      const d = await schedule();
      t.clock.set(at(9 * MIN));
      t.crash.arm('load:after-stock');
      await expect(t.jobs.load({ saleId: d.id })).rejects.toThrow('crash at');
      expect(await stock(d)).toBe(2000); // the units were taken before the crash

      t.clock.set(at(11 * MIN)); // the retry comes after the start
      await t.jobs.load({ saleId: d.id });
      expect(await statusOf(d.id)).toEqual({
        status: 'START_FAILED',
        statusReason: 'window_missed',
      });
      expect(await stock(d)).toBe(5000);
      expect(
        (await operations(d.id)).map((o) => [o.operationId, Number(o.delta)]),
      ).toEqual([
        [`orders:flash:${d.id}:load`, -3000],
        [`orders:flash:${d.id}:return`, 3000],
      ]);
      expect(await t.keysOf(d.id)).toEqual([]);
    });
  });

  describe('end (AS-23)', () => {
    it('S11 AS-23: end twice → one ENDED, one ended event, one reconcile job at endsAt + 15 min + 60 s', async () => {
      const d = await loaded();
      t.clock.set(at(70 * MIN));
      await t.jobs.end({ saleId: d.id });
      await t.jobs.end({ saleId: d.id });

      expect((await statusOf(d.id)).status).toBe('ENDED');
      expect(await events(d.id, 'flashsale.ended')).toHaveLength(1);
      const reconcile = await probe.find('flash-sale.reconcile', {
        saleId: d.id,
      });
      expect(reconcile).toHaveLength(1);
      expect(new Date(reconcile[0].runAt)).toEqual(at(70 * MIN + 16 * MIN));
    });

    it('S11 AS-23: end on a SCHEDULED sale → START_FAILED(window_missed)', async () => {
      const d = await schedule();
      t.clock.set(at(70 * MIN));
      await t.jobs.end({ saleId: d.id });
      expect(await statusOf(d.id)).toEqual({
        status: 'START_FAILED',
        statusReason: 'window_missed',
      });
      expect(await stock(d)).toBe(5000);
    });

    it('S11 AS-23: a late load after the end changes nothing', async () => {
      const d = await loaded();
      t.clock.set(at(70 * MIN));
      await t.jobs.end({ saleId: d.id });
      const before = await t.buckets(d.id, 16);
      await t.jobs.load({ saleId: d.id });
      expect((await statusOf(d.id)).status).toBe('ENDED');
      expect(await t.buckets(d.id, 16)).toEqual(before);
      expect(await stock(d)).toBe(2000);
    });

    it.each([
      ['malformed', { saleId: 'not-a-uuid' }],
      ['missing', {}],
      ['unknown sale', { saleId: randomUUID() }],
    ])(
      'S11 AS-23: a %s payload is a dead letter without side effects',
      async (_name, payload) => {
        const jobs = t.app.get(FlashSaleJobs, { strict: false });
        for (const run of [jobs.load, jobs.end, jobs.reconcile])
          await expect(
            run.call(jobs, payload as { saleId: string }),
          ).rejects.toMatchObject({ name: 'NonRetryableJobError' });
        expect(await rows(t.app, `SELECT 1 FROM "FlashSaleHistory"`)).toEqual(
          [],
        );
        expect(await events(randomUUID())).toEqual([]);
      },
    );
  });

  describe('reconcile (AS-24, AS-25, AS-26)', () => {
    const ended = async (over: Parameters<typeof schedule>[0] = {}) => {
      const d = await loaded(over);
      t.clock.set(at(70 * MIN));
      await t.jobs.end({ saleId: d.id });
      t.clock.set(at(86 * MIN));
      return d;
    };
    /** The fast store holds `remaining` units in total, in the first bucket. */
    const setRemaining = async (d: Drop, remaining: number) => {
      for (let b = 0; b < d.buckets; b++)
        await t.redis.set(
          `flash:{${d.id}:${b}}:stock`,
          b === 0 ? remaining : 0,
        );
    };

    it('S11 AS-24: 3 HELD reservations → no return, a retry within 60 s, the waiting gauge; it completes after they resolve', async () => {
      const d = await ended();
      await hold(d, 1, 'HELD');
      await hold(d, 1, 'HELD');
      await hold(d, 1, 'HELD');

      await t.jobs.reconcile({ saleId: d.id });
      expect((await statusOf(d.id)).status).toBe('ENDED');
      expect(await operations(d.id)).toHaveLength(1); // only the load
      const retries = await probe.find('flash-sale.reconcile', {
        saleId: d.id,
      });
      const next = retries
        .map((j) => new Date(j.runAt).getTime())
        .filter((ms) => ms >= t.clock.nowMs());
      expect(Math.min(...next) - t.clock.nowMs()).toBeLessThanOrEqual(60_000);
      expect(MetricsRegistry.value('flash_sale_reconcile_waiting')).toBe(1);

      await setHolds(d, 'HELD', 'RELEASED');
      await setRemaining(d, 3000);
      await t.jobs.reconcile({ saleId: d.id });
      expect((await statusOf(d.id)).status).toBe('RECONCILED');
      expect(MetricsRegistry.value('flash_sale_reconcile_waiting')).toBe(0);
    });

    it('S11 AS-25: twice and on two instances at once → one +600 operation, RECONCILED, keys removed, one event, stock original − 2400', async () => {
      const d = await ended();
      await hold(d, 2400, 'CONVERTED');
      await setRemaining(d, 600);

      await Promise.all([
        t.jobs.reconcile({ saleId: d.id }),
        t.jobs.reconcile({ saleId: d.id }),
      ]);
      await t.jobs.reconcile({ saleId: d.id });

      expect((await statusOf(d.id)).status).toBe('RECONCILED');
      expect(
        (await operations(d.id)).map((o) => [
          o.operationId,
          Number(o.delta),
          o.reason,
        ]),
      ).toEqual([
        [`orders:flash:${d.id}:load`, -3000, 'flash.load'],
        [`orders:flash:${d.id}:return`, 600, 'flash.return'],
      ]);
      expect(await stock(d)).toBe(5000 - 2400);
      expect(await t.keysOf(d.id)).toEqual([]);
      const reconciled = await events(d.id, 'flashsale.reconciled');
      expect(reconciled).toHaveLength(1);
      expect(
        flashSaleEventSchemas['flashsale.reconciled'].parse(
          reconciled[0].payload.payload,
        ),
      ).toMatchObject({
        unitsSold: 2400,
        unitsReturned: 600,
        driftUnits: 0,
      });
    });

    it('S11 AS-25: a reconcile job is due no later than endsAt + 20 min (SC-005)', async () => {
      const d = await loaded();
      t.clock.set(at(70 * MIN));
      await t.jobs.end({ saleId: d.id });
      const [job] = await probe.find('flash-sale.reconcile', { saleId: d.id });
      expect(new Date(job.runAt).getTime()).toBeLessThanOrEqual(
        at(70 * MIN + 20 * MIN).getTime(),
      );
    });

    it('S11 AS-25: a fully sold sale returns nothing and makes no stock command', async () => {
      const d = await ended({ units: 100, buckets: 4, qty: 500 });
      await hold(d, 100, 'CONVERTED');
      await setRemaining(d, 0);
      await t.jobs.reconcile({ saleId: d.id });
      expect((await statusOf(d.id)).status).toBe('RECONCILED');
      expect((await operations(d.id)).map((o) => o.operationId)).toEqual([
        `orders:flash:${d.id}:load`,
      ]);
      expect(await stock(d)).toBe(400);
    });

    it('S11 AS-26: the fast store shows 590 then 640 instead of 600 → still +600, the drift is counted by direction and warned', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        const low = await ended();
        await hold(low, 2400, 'CONVERTED');
        await setRemaining(low, 590);
        const lowBefore =
          MetricsRegistry.value('flash_sale_stock_drift_units_total', {
            direction: 'low',
          }) ?? 0;
        await t.jobs.reconcile({ saleId: low.id });
        expect((await operations(low.id)).map((o) => Number(o.delta))).toEqual([
          -3000, 600,
        ]);
        expect(
          MetricsRegistry.value('flash_sale_stock_drift_units_total', {
            direction: 'low',
          }),
        ).toBe(lowBefore + 10);
        expect(
          warn.mock.calls.some(
            ([m]) =>
              String(m).includes(low.id) && String(m).includes('redis_low'),
          ),
        ).toBe(true);

        const high = await ended();
        await hold(high, 2400, 'CONVERTED');
        await setRemaining(high, 640);
        const highBefore =
          MetricsRegistry.value('flash_sale_stock_drift_units_total', {
            direction: 'high',
          }) ?? 0;
        await t.jobs.reconcile({ saleId: high.id });
        expect((await operations(high.id)).map((o) => Number(o.delta))).toEqual(
          [-3000, 600],
        );
        expect(
          MetricsRegistry.value('flash_sale_stock_drift_units_total', {
            direction: 'high',
          }),
        ).toBe(highBefore + 40);
        const [reconciled] = await events(high.id, 'flashsale.reconciled');
        expect(
          (reconciled.payload.payload as { driftUnits: number }).driftUnits,
        ).toBe(40);
      } finally {
        warn.mockRestore();
      }
    });

    it('S11 AS-25: a sale cancelled after loading returns all its units, once', async () => {
      const d = await loaded();
      const res = await t
        .as(await t.reauth(d.s.owner))
        .post(`/api/shops/${d.s.shop.id}/flash-sales/${d.id}/cancel`);
      expect(res.status).toBe(200);
      await t.jobs.reconcile({ saleId: d.id });
      expect(await stock(d)).toBe(5000);
      expect((await operations(d.id)).map((o) => Number(o.delta))).toEqual([
        -3000, 3000,
      ]);
    });
  });

  describe('single run across instances (AS-29)', () => {
    it('S11 AS-29: verify and the claim sweeper are single-run jobs in the fleet, scheduled once', async () => {
      for (const method of ['verify', 'sweepClaims'] as const) {
        const meta = Reflect.getMetadata(
          JOB_HANDLER_METADATA,
          FlashSaleJobs.prototype[method],
        ) as {
          fleetConcurrency: number;
          concurrency: number;
        };
        expect(meta).toMatchObject({ fleetConcurrency: 1, concurrency: 1 });
      }
      // a second instance booting registers the same schedules by name, so they stay one row each
      await t.jobs.onApplicationBootstrap();
      await t.jobs.onApplicationBootstrap();
      const schedules = await rows<{ name: string; cron: string }>(
        t.app,
        `SELECT "name", "cron" FROM "JobSchedule" WHERE "name" LIKE 'flash-sale.%' ORDER BY "name"`,
      );
      expect(schedules).toEqual([
        { name: 'flash-sale.sweep-claims', cron: '*/10 * * * * *' },
        { name: 'flash-sale.verify', cron: '*/30 * * * * *' },
      ]);
    });

    it('S11 AS-29: two verifications at once do not clamp twice', async () => {
      const d = await loaded({ units: 100, buckets: 4, qty: 500 });
      await hold(d, 40, 'CONVERTED');
      t.clock.set(at(30 * MIN));
      await t.redis.set(`flash:{${d.id}:0}:stock`, 90);
      for (let b = 1; b < 4; b++)
        await t.redis.set(`flash:{${d.id}:${b}}:stock`, 0);

      await Promise.all([t.jobs.verify(), t.jobs.verify()]);
      expect((await t.buckets(d.id, 4)).reduce((a, b) => a + b, 0)).toBe(60);
      await t.jobs.verify();
      expect((await t.buckets(d.id, 4)).reduce((a, b) => a + b, 0)).toBe(60);
    });
  });

  describe('verification while selling (AS-27, AS-28)', () => {
    /** `n` accepted orders of `each` units, bought one buyer after the other (oldest first). */
    const buyMany = async (d: Drop2, n: number, each = 1) => {
      const orders: Array<{
        user: Awaited<ReturnType<FlashTestApp['newUser']>>;
        orderId: string;
      }> = [];
      for (let i = 0; i < n; i++) {
        const user = await t.newUser();
        await addToCart(t, user, d.productId, each);
        const res = await checkoutAs(t, user);
        expect(res.status).toBe(202);
        orders.push({ user, orderId: res.body.orderId });
      }
      return orders;
    };
    type Drop2 = Awaited<ReturnType<typeof openDrop>>;
    const setBuckets = async (d: Drop2, values: number[]) => {
      for (const [b, v] of values.entries())
        await t.redis.set(`flash:{${d.id}:${b}}:stock`, v);
    };
    const total = (d: Drop2) => t.buckets(d.id, d.buckets).then(sum);

    it('S11 AS-27: a snapshot restored with 90 units where 60 are possible is clamped by the verification, never raised, and sells only 60', async () => {
      const d = await openDrop(t, {
        units: 100,
        buckets: 4,
        limit: 5,
        regular: 0,
      });
      await buyMany(d, 8, 5); // 40 units sold
      expect(await total(d)).toBe(60);

      await setBuckets(d, [23, 23, 22, 22]); // the old snapshot: 90 remaining
      const phantom =
        MetricsRegistry.value('flash_sale_phantom_stock_units_total') ?? 0;
      await t.jobs.verify();
      expect(await total(d)).toBe(60);
      expect(
        MetricsRegistry.value('flash_sale_phantom_stock_units_total'),
      ).toBe(phantom + 30);
      expect(
        MetricsRegistry.value('flash_sale_stock_remaining', { saleId: d.id }),
      ).toBe(90);
      expect(Math.min(...(await t.buckets(d.id, 4)))).toBeGreaterThanOrEqual(0);

      // 70 more buyers: exactly 60 orders, the rest are told it is sold out
      const users = await Promise.all(
        Array.from({ length: 70 }, () => t.newUser()),
      );
      await Promise.all(users.map((u) => addToCart(t, u, d.productId, 1)));
      const results = await Promise.all(users.map((u) => checkoutAs(t, u)));
      expect(results.filter((r) => r.status === 202)).toHaveLength(60);
      expect(results.filter((r) => r.status === 422)).toHaveLength(10);
      expect(await total(d)).toBe(0);
      expect(await countRows(t, 'BisOrder')).toBe(8 + 60);

      // everything is sold: a unit the store still shows is phantom stock, clamped to zero
      await setBuckets(d, [1, 0, 0, 0]);
      await t.jobs.verify();
      expect(await total(d)).toBe(0);
    });

    it('S11 AS-27: a store that shows fewer units than the records allow is left alone during the sale', async () => {
      const d = await openDrop(t, {
        units: 100,
        buckets: 4,
        limit: 5,
        regular: 0,
      });
      await buyMany(d, 8, 5); // 40 sold, 60 possible
      await setBuckets(d, [10, 0, 0, 0]); // a failover lost writes: the store shows 10
      await t.jobs.verify();
      await t.jobs.verify();
      expect(await total(d)).toBe(10); // under-selling is the safe side: never raised during the sale
    });

    it('S11 AS-28: 104 units sold of 100 → selling stops, the 4 newest unpaid orders are cancelled without returning units, counted and announced', async () => {
      const d = await openDrop(t, {
        units: 100,
        buckets: 4,
        limit: 5,
        regular: 0,
      });
      await buyMany(d, 20, 5);
      expect(await total(d)).toBe(0);
      await setBuckets(d, [1, 1, 1, 1]); // a failover gave back 4 units that were already sold
      const late = await buyMany(d, 4, 1);
      expect(await total(d)).toBe(0);
      const sums = await rows<{ n: string }>(
        t.app,
        `SELECT sum("quantity") AS n FROM "StockReservation" WHERE "flashSaleId" = :id AND "status" = 'HELD'`,
        { id: d.id },
      );
      expect(Number(sums[0].n)).toBe(104);

      const before =
        MetricsRegistry.value('flash_sale_oversell_detected_total') ?? 0;
      await t.jobs.verify();

      for (const o of late) {
        expect(await orderStatus(t, o.orderId)).toEqual({
          status: 'CANCELLED',
          cancelReason: 'out_of_stock',
        });
      }
      expect(await total(d)).toBe(0); // the cancelled units were not returned to the buckets
      expect(MetricsRegistry.value('flash_sale_oversell_detected_total')).toBe(
        before + 4,
      );
      const [event] = await events(d.id, 'flashsale.oversold');
      expect(
        flashSaleEventSchemas['flashsale.oversold'].parse(
          event.payload.payload,
        ),
      ).toMatchObject({
        excessUnits: 4,
        unresolvedPaidUnits: 0,
      });
      expect(
        (
          event.payload.payload as { cancelledOrderIds: string[] }
        ).cancelledOrderIds.sort(),
      ).toEqual(late.map((o) => o.orderId).sort());

      // selling has stopped: the next buyer is told it is sold out even if the store shows units
      await setBuckets(d, [5, 0, 0, 0]);
      const user = await t.newUser();
      await addToCart(t, user, d.productId, 1);
      const refused = await checkoutAs(t, user);
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('out_of_stock');

      await t.jobs.verify(); // a second run finds nothing more to do
      expect(await events(d.id, 'flashsale.oversold')).toHaveLength(1);
    });

    it('S11 AS-28: excess units that are already PAID are reported, never cancelled', async () => {
      const d = await openDrop(t, {
        units: 100,
        buckets: 4,
        limit: 5,
        regular: 0,
      });
      const early = await buyMany(d, 20, 5);
      await setBuckets(d, [1, 1, 1, 1]);
      const late = await buyMany(d, 4, 1);
      const payments = t.app.get(PaymentResultService, { strict: false });
      // every order of the sale is paid: nothing unpaid is left to cancel
      for (const o of [...early, ...late])
        expect(
          await payments.applySuccess(
            o.orderId,
            `pi_${o.orderId}`,
            'system:test',
          ),
        ).toBe('paid');

      await t.jobs.verify();
      for (const o of [...early, ...late])
        expect((await orderStatus(t, o.orderId)).status).toBe('PAID');
      const [event] = await events(d.id, 'flashsale.oversold');
      expect(event.payload.payload).toMatchObject({
        excessUnits: 4,
        cancelledOrderIds: [],
        unresolvedPaidUnits: 4,
      });
    });

    it('S11 AS-37: the sold_out event is written once, when the last unit is claimed', async () => {
      const d = await openDrop(t, {
        units: 3,
        buckets: 2,
        limit: 1,
        regular: 2,
      });
      await buyMany(d, 2);
      expect(await events(d.id, 'flashsale.sold_out')).toEqual([]);
      await buyMany(d, 1);
      const [event] = await events(d.id, 'flashsale.sold_out');
      eventEnvelopeSchema.parse(event.payload);
      expect(await events(d.id, 'flashsale.sold_out')).toHaveLength(1);

      // later refusals and releases do not emit it again
      const user = await t.newUser();
      await addToCart(t, user, d.productId, 1);
      expect((await checkoutAs(t, user)).status).toBe(422);
      expect(await events(d.id, 'flashsale.sold_out')).toHaveLength(1);
    });

    it('J03 AS-11: racing buyers that take the last units together still write sold_out exactly once', async () => {
      for (let round = 0; round < 3; round++) {
        const d = await openDrop(t, {
          units: 12,
          buckets: 4,
          limit: 1,
          regular: 2,
        });
        const users = await Promise.all(
          Array.from({ length: 24 }, () => t.newUser()),
        );
        for (const user of users) await addToCart(t, user, d.productId, 1);
        const replies = await Promise.all(users.map((u) => checkoutAs(t, u)));
        expect(replies.filter((r) => r.status === 202)).toHaveLength(12);
        expect(await events(d.id, 'flashsale.sold_out')).toHaveLength(1);
      }
    });

    it('S11 AS-37: a refused outbox append for sold_out deletes the marker, so the next claim emits it', async () => {
      const d = await openDrop(t, {
        units: 2,
        buckets: 1,
        limit: 2,
        regular: 2,
      });
      await buyMany(d, 1);
      const outbox = t.app.get(OutboxService, { strict: false });
      const original = outbox.append.bind(outbox);
      const restore = t.patch(
        outbox,
        'append',
        () =>
          ((
            events: Parameters<typeof original>[0],
            tx?: Parameters<typeof original>[1],
          ) => {
            const list = Array.isArray(events) ? events : [events];
            if (list.some((e) => e.type === 'flashsale.sold_out'))
              return Promise.reject(new Error('outbox refused'));
            return original(events, tx);
          }) as never,
      );
      await buyMany(d, 1); // the last unit: the checkout still succeeds, the event could not be written
      expect(await events(d.id, 'flashsale.sold_out')).toEqual([]);
      restore();

      // the marker is gone: the check runs again (here directly on the next verification pass of a claim)
      const user = await t.newUser();
      await t.redis.set(`flash:{${d.id}:0}:stock`, 1);
      await addToCart(t, user, d.productId, 1);
      expect((await checkoutAs(t, user)).status).toBe(202);
      expect(await events(d.id, 'flashsale.sold_out')).toHaveLength(1);
    });
  });

  describe('events exactly once (AS-37)', () => {
    it('S11 AS-37: each job twice → one outbox row per event, envelope and payload valid', async () => {
      const d = await schedule();
      t.clock.set(at(9 * MIN));
      await t.jobs.load({ saleId: d.id });
      await t.jobs.load({ saleId: d.id });
      t.clock.set(at(70 * MIN));
      await t.jobs.end({ saleId: d.id });
      await t.jobs.end({ saleId: d.id });
      t.clock.set(at(86 * MIN));
      await t.jobs.reconcile({ saleId: d.id });
      await t.jobs.reconcile({ saleId: d.id });

      const all = await events(d.id);
      expect(all.map((r) => r.type)).toEqual([
        'flashsale.loaded',
        'flashsale.ended',
        'flashsale.reconciled',
      ]);
      for (const row of all) {
        const envelope = eventEnvelopeSchema.parse(row.payload);
        expect(envelope).toMatchObject({
          aggregateId: d.id,
          aggregateType: 'orders',
          version: 1,
        });
        expect(row.topic).toBe('orders.events');
        flashSaleEventSchemas[row.type as FlashSaleEventType].parse(
          envelope.payload,
        );
      }
    });

    it('S11 AS-37: a refused outbox append leaves the status unchanged; the retry succeeds', async () => {
      const d = await schedule();
      t.clock.set(at(9 * MIN));
      const outbox = t.app.get(OutboxService, { strict: false });
      const restore = t.patch(
        outbox,
        'append',
        () => (() => Promise.reject(new Error('outbox refused'))) as never,
      );
      await expect(t.jobs.load({ saleId: d.id })).rejects.toThrow(
        'outbox refused',
      );
      expect((await statusOf(d.id)).status).toBe('SCHEDULED');
      expect(await events(d.id)).toEqual([]);
      restore();

      await t.jobs.load({ saleId: d.id });
      expect((await statusOf(d.id)).status).toBe('LOADED');
      expect(await events(d.id, 'flashsale.loaded')).toHaveLength(1);
      expect(await stock(d)).toBe(2000);
    });

    it('S11 AS-37: history rows match the transitions', async () => {
      const d = await loaded();
      t.clock.set(at(70 * MIN));
      await t.jobs.end({ saleId: d.id });
      const history = await rows<{
        fromStatus: string | null;
        toStatus: string;
        actor: string;
      }>(
        t.app,
        `SELECT "fromStatus", "toStatus", "actor" FROM "FlashSaleHistory" WHERE "saleId" = :id ORDER BY "at", "id"`,
        { id: d.id },
      );
      expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
        [null, 'SCHEDULED'],
        ['SCHEDULED', 'LOADED'],
        ['LOADED', 'ENDED'],
      ]);
      expect(HOUR).toBeGreaterThan(0);
    });
  });
});
