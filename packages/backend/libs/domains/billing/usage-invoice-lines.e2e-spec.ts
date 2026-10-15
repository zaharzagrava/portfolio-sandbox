import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobRegistry } from '@app/infrastructure/jobs/job-registry.service';
import { UsageLinesService } from './application/usage-lines.service';
import { UsageReconcileService } from './application/usage-reconcile.service';
import { UsageReconcileJob } from './infra/usage-reconcile.job';
import { UsageSettlementService } from './application/usage-settlement.service';
import {
  USAGE_STORE,
  type SettlementPlan,
  type UsageInvoiceLinesProvider,
  type UsageStorePort,
} from './domain/ports';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import { createFs } from './testing/billing-flows';
import { seedInvoice, seedSubscription } from './testing/billing-seed';

const NOW = '2026-05-01T00:00:00.000Z';
const APRIL = {
  start: new Date('2026-04-01T00:00:00.000Z'),
  end: new Date('2026-05-01T00:00:00.000Z'),
};
const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Billing: usage lines, settlement and late adjustments', () => {
  let t: BillingTestApp;
  let store: UsageStorePort;
  let lines: UsageLinesService;
  let settlement: UsageSettlementService;
  let reconcile: UsageReconcileService;
  let runner: TransactionRunner;
  let clickhouse: ClickHouseService;

  beforeAll(async () => {
    t = await createBillingApp({ realUsage: true });
    store = t.app.get<UsageStorePort>(USAGE_STORE, { strict: false });
    lines = t.app.get(UsageLinesService, { strict: false });
    settlement = t.app.get(UsageSettlementService, { strict: false });
    reconcile = t.app.get(UsageReconcileService, { strict: false });
    runner = t.app.get(TransactionRunner, { strict: false });
    clickhouse = t.app.get(ClickHouseService, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date(NOW));
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The usage events of a subject: `quantity` api.calls with event time `ts`, ingested at `ingestedAt`. */
  const events = (
    subjectId: string,
    quantity: number,
    ts: string,
    ingestedAt: string,
    metricName = 'api.calls',
  ) =>
    store.insert(
      [
        {
          identity: uuidv4(),
          subjectId,
          metric: metricName,
          quantity,
          ts: new Date(ts),
        },
      ],
      new Date(ingestedAt),
    );

  const ledger = (subscriptionId: string) =>
    t.sql<{
      metric: string;
      periodStart: Date;
      settledQuantity: string;
      settledAmountMinor: string;
      includedQuantity: string;
      overagePer1000Minor: string;
      lastInvoiceId: string;
      closed: boolean;
    }>(
      `SELECT "metric", "periodStart", "settledQuantity", "settledAmountMinor", "includedQuantity",
              "overagePer1000Minor", "lastInvoiceId", "closed"
         FROM "UsageSettlement" WHERE "subscriptionId" = :subscriptionId ORDER BY "periodStart", "metric"`,
      { subscriptionId },
    );

  /** Shop `f` of DS-1: a seeded `starter` subscription (10,000 included, 50 per 1,000) for April. */
  async function shopF() {
    const subjectId = uuidv4();
    const sub = await seedSubscription(t, {
      subjectType: 'SHOP',
      subjectId,
      plan: 'starter',
      periodStart: '2026-04-01T00:00:00.000Z',
      periodEnd: '2026-05-01T00:00:00.000Z',
    });
    return { subjectId, subscriptionId: sub.id, priceId: sub.priceId };
  }
  const linesFor = (
    f: { subjectId: string; subscriptionId: string; priceId: string },
    over: Partial<Parameters<UsageInvoiceLinesProvider['linesFor']>[0]> = {},
  ) =>
    lines.linesFor({
      subscriptionId: f.subscriptionId,
      subjectId: f.subjectId,
      priceId: f.priceId,
      periodStart: APRIL.start,
      periodEnd: APRIL.end,
      measuredAt: new Date(NOW),
      timeoutMs: 5_000,
      ...over,
    });
  /** `settle` in its own transaction, the way S17's invoice transaction wraps it. */
  const settle = (
    invoiceId: string,
    subscriptionId: string,
    plan: SettlementPlan,
  ) =>
    runner.run(() =>
      settlement.settle({ invoiceId, subscriptionId, settlement: plan }),
    );

  describe('S18 AS-32 / AS-37: the overage line, and settling it once', () => {
    it('S18 AS-32: 12,500 calls against 10,000 included give one usage line of 150 and a settlement plan; nothing is written', async () => {
      const f = await shopF();
      await events(
        f.subjectId,
        12_500,
        '2026-04-15T10:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
      );

      const result = await linesFor(f);

      expect(result.lines).toEqual([
        {
          kind: 'USAGE',
          description: 'api.calls: 2500 units over 10000 included',
          quantity: 2500,
          amountMinor: 150,
        },
      ]);
      expect(result.settlement).toEqual({
        entries: [
          {
            metric: 'api.calls',
            periodStart: APRIL.start,
            periodEnd: APRIL.end,
            fromQuantity: 0,
            toQuantity: 12_500,
            includedQuantity: 10_000,
            overagePer1000Minor: 50,
            final: false,
          },
        ],
      });
      expect(await ledger(f.subscriptionId)).toEqual([]);
    });

    it('S18 AS-37: settle writes one ledger row bound to the invoice; the same invoice again is a no-op; another invoice with the same plan is a settlement_conflict', async () => {
      const f = await shopF();
      await events(
        f.subjectId,
        12_500,
        '2026-04-15T10:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
      );
      const plan = (await linesFor(f)).settlement;
      const i1 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
      );
      const i2 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-06-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
      );

      await settle(i1, f.subscriptionId, plan);
      const [row] = await ledger(f.subscriptionId);
      expect(row).toMatchObject({
        metric: 'api.calls',
        settledQuantity: '12500',
        settledAmountMinor: '150',
        includedQuantity: '10000',
        overagePer1000Minor: '50',
        lastInvoiceId: i1,
        closed: false,
      });
      expect(row.periodStart.toISOString()).toBe('2026-04-01T00:00:00.000Z');

      // idempotent by invoice id
      await settle(i1, f.subscriptionId, plan);
      expect(await ledger(f.subscriptionId)).toEqual([row]);

      // a different invoice with a stale plan (from 0) is refused and nothing changes
      const conflicts = metric('usage_settlement_conflicts_total');
      await expect(settle(i2, f.subscriptionId, plan)).rejects.toMatchObject({
        code: 'settlement_conflict',
      });
      expect(await ledger(f.subscriptionId)).toEqual([row]);
      expect(metric('usage_settlement_conflicts_total')).toBe(conflicts + 1);
    });

    it('S18 AS-37: settle joins the caller transaction: a rolled-back invoice leaves no ledger row', async () => {
      const f = await shopF();
      await events(
        f.subjectId,
        12_500,
        '2026-04-15T10:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
      );
      const plan = (await linesFor(f)).settlement;
      const i1 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
      );

      await expect(
        runner.run(async () => {
          await settlement.settle({
            invoiceId: i1,
            subscriptionId: f.subscriptionId,
            settlement: plan,
          });
          throw new Error('the invoice insert failed afterwards');
        }),
      ).rejects.toThrow('the invoice insert failed afterwards');

      expect(await ledger(f.subscriptionId)).toEqual([]);
    });
  });

  describe('S18 AS-38 / AS-42: late events become one adjustment, issued invoices stay as they are', () => {
    it('S18 AS-38: 800 late events become an adjustment of 50 on the next invoice, exactly once; S18 AS-42: the earlier invoice and its lines are byte-for-byte unchanged', async () => {
      const f = await shopF();
      await events(
        f.subjectId,
        12_500,
        '2026-04-15T10:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
      );
      const i1 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
        NOW,
      );
      await settle(i1, f.subscriptionId, (await linesFor(f)).settlement);
      const snapshot = async (invoiceId: string) => ({
        invoice: await t.sql(`SELECT * FROM "Invoice" WHERE id = :invoiceId`, {
          invoiceId,
        }),
        lines: await t.sql(
          `SELECT * FROM "InvoiceLine" WHERE "invoiceId" = :invoiceId ORDER BY id`,
          { invoiceId },
        ),
      });
      const before = JSON.stringify(await snapshot(i1));

      // 800 more April events, ingested after the measurement
      await events(
        f.subjectId,
        800,
        '2026-04-28T10:00:00.000Z',
        '2026-05-03T09:00:00.000Z',
      );

      const june = await linesFor(f, {
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        periodEnd: new Date('2026-06-01T00:00:00.000Z'),
        measuredAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      expect(june.lines).toEqual([
        {
          kind: 'ADJUSTMENT',
          description:
            'api.calls: 800 late overage units for 2026-04-01..2026-05-01',
          quantity: 800,
          amountMinor: 50,
        },
      ]);
      const i2 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-06-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
      );
      await settle(i2, f.subscriptionId, june.settlement);

      const rows = await ledger(f.subscriptionId);
      const april = rows.find(
        (r) => r.periodStart.toISOString() === '2026-04-01T00:00:00.000Z',
      );
      expect(april).toMatchObject({
        settledQuantity: '13300',
        settledAmountMinor: '200',
        lastInvoiceId: i2,
      });
      expect(JSON.stringify(await snapshot(i1))).toBe(before);

      // the next measurement produces no April adjustment
      const july = await linesFor(f, {
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        periodEnd: new Date('2026-07-01T00:00:00.000Z'),
        measuredAt: new Date('2026-07-01T00:00:00.000Z'),
      });
      expect(july.lines).toEqual([]);
    });

    it('S18 AS-38: through the real renewal, the June invoice carries the adjustment and the ledger moves with it in the same transaction', async () => {
      const fs = await createFs(t, { at: '2026-04-01T00:00:00.000Z' });
      await events(
        fs.shopId,
        12_500,
        '2026-04-15T10:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
      );

      await t.at('2026-05-01T00:00:00.000Z', fs.owner);
      expect((await t.renewals.run()).invoiced).toBe(1);
      const invoices = () =>
        t.sql<{ id: string; periodStart: Date; total: string }>(
          `SELECT id, "periodStart", total FROM "Invoice" WHERE "subscriptionId" = :id ORDER BY "periodStart"`,
          { id: fs.subscriptionId },
        );
      const lineRows = (invoiceId: string) =>
        t.sql<{
          kind: string;
          description: string;
          quantity: string;
          amount: string;
        }>(
          `SELECT kind, description, quantity, amount FROM "InvoiceLine" WHERE "invoiceId" = :invoiceId ORDER BY kind`,
          { invoiceId },
        );
      const [, may] = await invoices();
      expect(
        (await lineRows(may.id)).map((l) => [l.kind, l.description, l.amount]),
      ).toEqual([
        ['PLAN', 'Starter', '1900'],
        ['USAGE', 'api.calls: 2500 units over 10000 included', '150'],
      ]);
      expect((await ledger(fs.subscriptionId))[0]).toMatchObject({
        settledQuantity: '12500',
        settledAmountMinor: '150',
        lastInvoiceId: may.id,
      });
      const mayBefore = JSON.stringify(await lineRows(may.id));

      await events(
        fs.shopId,
        800,
        '2026-04-28T10:00:00.000Z',
        '2026-05-03T09:00:00.000Z',
      );
      await t.at('2026-06-01T00:00:00.000Z', fs.owner);
      expect((await t.renewals.run()).invoiced).toBe(1);

      const june = (await invoices())[2];
      expect(
        (await lineRows(june.id)).map((l) => [
          l.kind,
          l.description,
          l.quantity,
          l.amount,
        ]),
      ).toEqual([
        [
          'ADJUSTMENT',
          'api.calls: 800 late overage units for 2026-04-01..2026-05-01',
          '800',
          '50',
        ],
        ['PLAN', 'Starter', '1', '1900'],
      ]);
      expect(june.total).toBe('1950');
      const rows = await ledger(fs.subscriptionId);
      expect(
        rows.map((r) => [
          r.periodStart.toISOString().slice(0, 10),
          r.settledQuantity,
          r.settledAmountMinor,
          r.lastInvoiceId,
        ]),
      ).toEqual([
        ['2026-04-01', '13300', '200', june.id],
        ['2026-05-01', '0', '0', june.id],
      ]);
      expect(JSON.stringify(await lineRows(may.id))).toBe(mayBefore);
    });
  });

  describe('S18 AS-42: a closed period is never mutated', () => {
    it('S18 AS-42: after the adjustment every earlier invoice, its lines and its history are byte-for-byte unchanged, and no ledger row is deleted or rewritten except by moving forward', async () => {
      const fs = await createFs(t, { at: '2026-04-01T00:00:00.000Z' });
      await events(
        fs.shopId,
        12_500,
        '2026-04-15T10:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
      );
      await t.at('2026-05-01T00:00:00.000Z', fs.owner);
      await t.renewals.run();
      const frozen = async () => ({
        invoices: await t.sql(
          `SELECT * FROM "Invoice" WHERE "subscriptionId" = :id ORDER BY "periodStart"`,
          { id: fs.subscriptionId },
        ),
        lines: await t.sql(
          `SELECT l.* FROM "InvoiceLine" l JOIN "Invoice" i ON i.id = l."invoiceId"
            WHERE i."subscriptionId" = :id ORDER BY i."periodStart", l.id`,
          { id: fs.subscriptionId },
        ),
      });
      const before = await frozen();
      const rowsBefore = await ledger(fs.subscriptionId);

      await events(
        fs.shopId,
        800,
        '2026-04-28T10:00:00.000Z',
        '2026-05-03T09:00:00.000Z',
      );
      await t.at('2026-06-01T00:00:00.000Z', fs.owner);
      await t.renewals.run();

      const after = await frozen();
      // everything that existed is identical, bit for bit; the adjustment exists only on the new invoice
      expect(
        JSON.stringify(after.invoices.slice(0, before.invoices.length)),
      ).toBe(JSON.stringify(before.invoices));
      expect(JSON.stringify(after.lines.slice(0, before.lines.length))).toBe(
        JSON.stringify(before.lines),
      );
      expect(after.invoices).toHaveLength(before.invoices.length + 1);
      const rowsAfter = await ledger(fs.subscriptionId);
      for (const row of rowsBefore) {
        const moved = rowsAfter.find(
          (r) =>
            r.periodStart.getTime() === row.periodStart.getTime() &&
            r.metric === row.metric,
        );
        expect(moved).toBeDefined();
        expect(Number(moved!.settledQuantity)).toBeGreaterThanOrEqual(
          Number(row.settledQuantity),
        );
        expect(Number(moved!.settledAmountMinor)).toBeGreaterThanOrEqual(
          Number(row.settledAmountMinor),
        );
        expect(moved!.includedQuantity).toBe(row.includedQuantity);
        expect(moved!.overagePer1000Minor).toBe(row.overagePer1000Minor);
      }
    });
  });

  describe('S18 AS-43: two renewals racing', () => {
    it('S18 AS-43: of two settlements bound to the same state exactly one wins and the ledger reflects one settlement', async () => {
      const f = await shopF();
      await events(
        f.subjectId,
        12_500,
        '2026-04-15T10:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
      );
      const i1 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
        NOW,
      );
      await settle(i1, f.subscriptionId, (await linesFor(f)).settlement);
      await events(
        f.subjectId,
        800,
        '2026-04-28T10:00:00.000Z',
        '2026-05-03T09:00:00.000Z',
      );
      const plan = (
        await linesFor(f, {
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-01T00:00:00.000Z'),
          measuredAt: new Date('2026-06-01T00:00:00.000Z'),
        })
      ).settlement;
      const i2 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-06-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
      );
      const i3 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-06-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z',
      );

      const results = await Promise.allSettled([
        settle(i2, f.subscriptionId, plan),
        settle(i3, f.subscriptionId, plan),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'settlement_conflict' });
      const winner = results[0].status === 'fulfilled' ? i2 : i3;
      const april = (await ledger(f.subscriptionId)).find((r) =>
        r.periodStart.toISOString().startsWith('2026-04-01'),
      );
      expect(april).toMatchObject({
        settledQuantity: '13300',
        settledAmountMinor: '200',
        lastInvoiceId: winner,
      });
    });
  });

  describe('S18 AS-44 / AS-45: the store down or slow, and invalid input', () => {
    it('S18 AS-44: a failing usage store rejects usage_unavailable and writes nothing (VII.9)', async () => {
      const f = await shopF();
      jest
        .spyOn(clickhouse, 'query')
        .mockRejectedValue(new Error('Code: 210. connection refused'));
      await expect(linesFor(f)).rejects.toMatchObject({
        code: 'usage_unavailable',
      });
      expect(await ledger(f.subscriptionId)).toEqual([]);
    });

    it('S18 AS-44: a store that never answers is cut at the timeout, not later, with no partial lines', async () => {
      const f = await shopF();
      jest
        .spyOn(clickhouse, 'query')
        .mockImplementation(() => new Promise(() => undefined));
      const started = Date.now();
      await expect(linesFor(f, { timeoutMs: 300 })).rejects.toMatchObject({
        code: 'usage_unavailable',
      });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await ledger(f.subscriptionId)).toEqual([]);
    });

    it.each([
      ['periodEnd not after periodStart', { periodEnd: APRIL.start }],
      ['a price that is not the subscription’s', { priceId: uuidv4() }],
      ['a subject that is not the subscription’s', { subjectId: uuidv4() }],
    ])(
      'S18 AS-45: %s rejects invalid_input, reads no usage and writes nothing',
      async (_name, patch) => {
        const f = await shopF();
        const spy = jest.spyOn(clickhouse, 'query');
        await expect(linesFor(f, patch)).rejects.toMatchObject({
          code: 'invalid_input',
        });
        expect(spy).not.toHaveBeenCalled();
        expect(await ledger(f.subscriptionId)).toEqual([]);
      },
    );

    it('S18 AS-45: another price of the same plan is not the subscription’s price either', async () => {
      const f = await shopF();
      const pro = await t.priceId('pro');
      await expect(linesFor(f, { priceId: pro })).rejects.toMatchObject({
        code: 'invalid_input',
      });
    });

    it('S18 AS-36: a buyer subscription whose price has no included usage gives no lines and queries nothing', async () => {
      const subjectId = uuidv4();
      const sub = await seedSubscription(t, {
        subjectType: 'USER',
        subjectId,
        plan: 'plus',
      });
      const spy = jest.spyOn(clickhouse, 'query');
      const result = await lines.linesFor({
        subscriptionId: sub.id,
        subjectId,
        priceId: sub.priceId,
        periodStart: APRIL.start,
        periodEnd: APRIL.end,
        measuredAt: new Date(NOW),
        timeoutMs: 5_000,
      });
      expect(result).toEqual({ lines: [], settlement: { entries: [] } });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('S18 AS-47: the reconciliation check', () => {
    /** A subscription settled for April at 12,500 (150): a consistent ledger row. */
    async function settledShop() {
      const f = await shopF();
      await events(
        f.subjectId,
        12_500,
        '2026-04-15T10:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
      );
      const invoiceId = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
        NOW,
      );
      await settle(invoiceId, f.subscriptionId, (await linesFor(f)).settlement);
      return f;
    }
    const corrupt = (subscriptionId: string, set: string) =>
      t.sequelize.query(
        `UPDATE "UsageSettlement" SET ${set} WHERE "subscriptionId" = :subscriptionId`,
        {
          replacements: { subscriptionId },
        },
      );
    const clean = (subscriptionId: string) =>
      t.sequelize.query(
        `DELETE FROM "UsageSettlement" WHERE "subscriptionId" = :subscriptionId`,
        {
          replacements: { subscriptionId },
        },
      );
    const gauge = () => MetricsRegistry.value('usage_ledger_drift') ?? -1;

    it('S18 AS-47: a consistent ledger reports no drift', async () => {
      await settledShop();
      await settledShop();
      expect(await reconcile.run()).toEqual({ examined: 2, drift: 0 });
      expect(gauge()).toBe(0);
    });

    it('S18 AS-47: each corrupted row is counted, nothing is modified, a second run says the same (SC-008)', async () => {
      const wrongAmount = await settledShop();
      const aboveTotal = await settledShop();
      const fine = await settledShop();
      await corrupt(wrongAmount.subscriptionId, `"settledAmountMinor" = 999`);
      // 99,999 settled units priced consistently (4500) but far above the 12,500 that exist
      await corrupt(
        aboveTotal.subscriptionId,
        `"settledQuantity" = 99999, "settledAmountMinor" = 4500`,
      );
      const before = await t.sql(
        `SELECT * FROM "UsageSettlement" ORDER BY "subscriptionId"`,
      );
      try {
        expect(await reconcile.run()).toEqual({ examined: 3, drift: 2 });
        expect(gauge()).toBe(2);
        expect(await reconcile.run()).toEqual({ examined: 3, drift: 2 });
        expect(
          await t.sql(
            `SELECT * FROM "UsageSettlement" ORDER BY "subscriptionId"`,
          ),
        ).toEqual(before);
      } finally {
        // the damage was injected on purpose: remove it so the next measurement does not report it (L-013)
        await clean(wrongAmount.subscriptionId);
        await clean(aboveTotal.subscriptionId);
      }
      expect(await reconcile.run()).toEqual({ examined: 1, drift: 0 });
      expect(gauge()).toBe(0);
      void fine;
    });

    it('S18 AS-47: an error is logged naming subscription, period and metric, and no amount', async () => {
      const f = await settledShop();
      await corrupt(f.subscriptionId, `"settledAmountMinor" = 999`);
      const errors: string[] = [];
      jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          errors.push(String(message));
        });
      await reconcile.run();
      await clean(f.subscriptionId);
      expect(errors.filter((e) => e.includes('usage ledger drift'))).toEqual([
        `usage ledger drift: subscription ${f.subscriptionId} period 2026-04-01T00:00:00.000Z metric api.calls`,
      ]);
    });

    it('S18 AS-47: the check is scheduled once at 03:15 UTC however many replicas boot, and two deliveries of one slot run it once', async () => {
      const job = t.app.get(UsageReconcileJob, { strict: false });
      await job.onApplicationBootstrap();
      await job.onApplicationBootstrap();
      const schedules = await t.sql<Record<string, unknown>>(
        `SELECT * FROM "JobSchedule" WHERE name = 'billing.usage-reconcile'`,
      );
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({
        cron: '15 3 * * *',
        timezone: 'UTC',
        jobType: 'billing.usage-reconcile',
        overlap: 'skip',
      });
      const handler = t.app
        .get(JobRegistry, { strict: false })
        .get('billing.usage-reconcile');
      expect(handler?.leaseMs).toBe(600_000);
      expect(handler?.concurrency).toBe(1);

      const run = jest.spyOn(reconcile, 'run');
      const slot = {
        idempotencyKey: 'usage-reconcile:2026-05-02T03:15:00.000Z',
      };
      await t.jobs.enqueue('billing.usage-reconcile', {}, slot);
      await t.jobs.enqueue('billing.usage-reconcile', {}, slot);
      await t.drainJobs();
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  describe('S18 AS-46: a period is final once no late event can exist', () => {
    async function aprilSettled() {
      const f = await shopF();
      await events(
        f.subjectId,
        12_500,
        '2026-04-15T10:00:00.000Z',
        '2026-04-20T00:00:00.000Z',
      );
      const i1 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
        NOW,
      );
      await settle(i1, f.subscriptionId, (await linesFor(f)).settlement);
      return f;
    }
    const later = (iso: string) => ({
      periodStart: new Date('2026-07-01T00:00:00.000Z'),
      periodEnd: new Date('2026-08-01T00:00:00.000Z'),
      measuredAt: new Date(iso),
    });

    it('S18 AS-46: a measurement 91 days after the period end settles the last delta and closes the row; it is never queried again', async () => {
      const f = await aprilSettled();
      await events(
        f.subjectId,
        800,
        '2026-04-28T10:00:00.000Z',
        '2026-05-03T09:00:00.000Z',
      );

      // 2026-08-05: more than 91 days after 2026-05-01
      const final = await linesFor(f, later('2026-08-05T00:00:00.000Z'));
      expect(final.lines.filter((l) => l.kind === 'ADJUSTMENT')).toEqual([
        expect.objectContaining({ quantity: 800, amountMinor: 50 }),
      ]);
      const i2 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-08-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z',
      );
      await settle(i2, f.subscriptionId, final.settlement);
      const april = (await ledger(f.subscriptionId)).find((r) =>
        r.periodStart.toISOString().startsWith('2026-04-01'),
      );
      expect(april).toMatchObject({ settledQuantity: '13300', closed: true });

      // events that still reach the store for April are never billed: the closed row is not queried
      await events(
        f.subjectId,
        5_000,
        '2026-04-29T10:00:00.000Z',
        '2026-08-06T00:00:00.000Z',
      );
      const totals = jest.spyOn(store, 'totals');
      const next = await linesFor(f, {
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-09-01T00:00:00.000Z'),
        measuredAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      expect(next.lines.filter((l) => l.kind === 'ADJUSTMENT')).toEqual([]);
      for (const call of totals.mock.calls)
        for (const window of call[1])
          expect(window.from.toISOString()).not.toBe(
            '2026-04-01T00:00:00.000Z',
          );
    });

    it('S18 AS-46: one day earlier (90 days after the period end) the row stays open', async () => {
      const f = await aprilSettled();
      const plan = (await linesFor(f, later('2026-07-30T23:59:59.999Z')))
        .settlement;
      const i2 = await seedInvoice(
        t,
        f.subscriptionId,
        '2026-07-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z',
      );
      await settle(i2, f.subscriptionId, plan);
      const april = (await ledger(f.subscriptionId)).find((r) =>
        r.periodStart.toISOString().startsWith('2026-04-01'),
      );
      expect(april?.closed).toBe(false);
    });
  });
});
