import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  DS1,
  lateSaleL4,
  payoutPaid,
} from '@app/test/fixtures/statements';
import { RECONCILE_FAULT } from './application/adjustment.service';
import { CLOSE_FAULT } from './application/period-close.service';
import { SNAPSHOT_REPOSITORY, type SnapshotRepository } from './domain/ports';
import { StatementsJobs } from './infra/statements.jobs';
import { createStatementsApp, type StatementsTestApp } from './testing/statements-app';
import {
  adjustmentsOf,
  closeMonth,
  createShops,
  rc1,
  readStatement,
  seedDs1,
  setClock,
  setRate,
  type Shops,
} from './testing/statements-flows';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;
const ctx = () => ({ signal: new AbortController().signal });

describe('Statements: adjustments and corrections', () => {
  let t: StatementsTestApp;
  let shops: Shops;
  let jobs: StatementsJobs;

  beforeAll(async () => {
    t = await createStatementsApp();
    jobs = t.app.get(StatementsJobs, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
    t.app.get(RECONCILE_FAULT, { strict: false }).before = undefined;
    t.app.get(CLOSE_FAULT, { strict: false }).after = undefined;
    setClock(t, '2026-04-01T00:30:00Z');
    shops = await createShops(t);
    await seedDs1(t, shops);
  });

  const closeDs1 = () => closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
  const events = (type: string) =>
    t.sql<{ payload: { payload: Record<string, unknown> } }>(
      `SELECT payload FROM "Outbox" WHERE type = :type ORDER BY "createdAt", id`,
      { type },
    );
  const snapshots = () =>
    t.sql<Record<string, string>>(
      `SELECT "shopId", month::text, gross::text, commission::text, net::text, lines::text, "payoutsPaidMinor"::text AS paid,
              "knowledgeCutoff"::text AS cutoff, "adjCommissionMinor"::text AS adj, "runId"::text AS run
         FROM "StatementSnapshot" ORDER BY month, "shopId"`,
    );
  const num = (v: string) => Number(v);

  it('S16 AS-40: a retroactive rate change books one adjustment per affected shop and month and leaves the snapshot alone', async () => {
    await closeDs1();
    const frozen = await snapshots();
    const change = await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    expect(change.affectedClosedMonths).toEqual(['2026-03']);
    await t.drainJobs();

    const booked = await adjustmentsOf(t);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      shopId: shops.a,
      refersToMonth: '2026-03',
      bookedMonth: '2026-04',
      causeKind: 'rate_change',
      causeRef: change.changeId,
      lines: 0,
      reason: 'promo-2026-03',
    });
    expect([num(booked[0].gross), num(booked[0].commission), num(booked[0].payouts)]).toEqual([0, -900, 0]);
    const sent = await events('statements.adjustment_booked');
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.payload).toMatchObject({
      adjustmentId: booked[0].id,
      shopId: shops.a,
      commissionDeltaMinor: -900,
      causeKind: 'rate_change',
    });
    expect(await snapshots()).toEqual(frozen);
    expect(metric('statements_adjustments_booked_total', { cause: 'rate_change' })).toBeGreaterThan(0);
  });

  it('S16 AS-41: the same adjustment work delivered again, and at the same moment, books once', async () => {
    await closeDs1();
    const change = await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    const payload = { month: '2026-03', cause: `rate_change:${change.changeId}`, shopId: shops.a };
    await jobs.reconcileMonth(payload, ctx());
    await jobs.reconcileMonth(payload, ctx());
    await Promise.all([jobs.reconcileMonth(payload, ctx()), jobs.reconcileMonth(payload, ctx())]);
    await t.drainJobs();
    expect(await adjustmentsOf(t)).toHaveLength(1);
    expect(await events('statements.adjustment_booked')).toHaveLength(1);
  });

  it('S16 AS-42: a second change with the same reason text is a second adjustment, not a collapsed one', async () => {
    await closeDs1();
    await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    await t.drainJobs();
    await setRate(t, rc1(shops.a, { rateBps: 600 }), '2026-04-10T09:00:00Z');
    await t.drainJobs();

    const booked = await adjustmentsOf(t);
    expect(booked.map((b) => num(b.commission))).toEqual([-900, -300]);
    expect(booked.map((b) => b.reason)).toEqual(['promo-2026-03', 'promo-2026-03']);
    const march = await readStatement(t, shops.a, '2026-03');
    expect(march.own.commissionMinor).toBe(3050);
    expect(march.corrected.commissionMinor).toBe(1850);
    expect(march.adjustmentsReferencing).toHaveLength(2);
  });

  it('S16 AS-43: a default-rate change reaches every shop; one shop failing once is isolated and retried; batches stay small', async () => {
    await closeDs1();
    const failures: string[] = [];
    t.app.get(RECONCILE_FAULT, { strict: false }).before = (shopId: string) => {
      if (shopId === shops.b && failures.length === 0) {
        failures.push(shopId);
        throw new Error('transient failure for one shop');
      }
    };
    const pageSizes: number[] = [];
    const repo = t.app.get<SnapshotRepository>(SNAPSHOT_REPOSITORY, { strict: false });
    const page = repo.page.bind(repo);
    jest.spyOn(repo, 'page').mockImplementation(async (month, after, limit) => {
      pageSizes.push(limit);
      return page(month, after, limit);
    });

    await setRate(t, { category: '*', rateBps: 900, validFrom: '2026-03-01T00:00:00Z', reason: 'default-900' }, '2026-04-05T09:00:00Z');
    await t.drainJobs();
    expect(failures).toEqual([shops.b]);
    let booked = await adjustmentsOf(t);
    expect(booked.map((b) => [b.shopId, num(b.commission)])).toEqual([[shops.a, -305]]);

    setClock(t, '2026-04-05T09:02:00Z'); // the retry of the failed shop is due
    await t.drainJobs();
    booked = await adjustmentsOf(t);
    expect(booked.map((b) => [b.shopId, num(b.commission)]).sort()).toEqual(
      [[shops.a, -305], [shops.b, -41]].sort(),
    );
    expect(booked.some((b) => b.shopId === shops.c)).toBe(false);
    expect(Math.max(...pageSizes)).toBeLessThanOrEqual(1000);
  });

  it('S16 AS-44: a change that touches no closed month queues nothing; one that changes no figure books nothing', async () => {
    await closeDs1();
    const forward = await setRate(t, rc1(shops.a, { validFrom: '2026-04-01T00:00:00Z' }), '2026-04-05T09:00:00Z');
    expect(forward.affectedClosedMonths).toEqual([]);
    await t.drainJobs();
    expect(await adjustmentsOf(t)).toHaveLength(0);

    const noSales = await setRate(t, rc1(shops.a, { category: 'toys', rateBps: 500 }));
    expect(noSales.affectedClosedMonths).toEqual(['2026-03']);
    await t.drainJobs();
    expect(await adjustmentsOf(t)).toHaveLength(0);
    expect(await events('statements.adjustment_booked')).toHaveLength(0);
  });

  it('S16 AS-45: a sale that arrives after the close is booked as a late-sale adjustment in the next month', async () => {
    await closeDs1();
    setClock(t, '2026-04-03T10:00:00Z');
    await t.sales.deliver(lateSaleL4(shops.a));
    await t.drainJobs();

    const booked = await adjustmentsOf(t);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      shopId: shops.a,
      refersToMonth: '2026-03',
      bookedMonth: '2026-04',
      causeKind: 'late_sale',
      causeRef: DS1.o4,
      lines: 1,
    });
    expect([num(booked[0].gross), num(booked[0].commission)]).toEqual([1000, 100]);
    const march = await readStatement(t, shops.a, '2026-03');
    expect(march.own).toMatchObject({ grossMinor: 30500, commissionMinor: 3050, lineCount: 3 });
    expect(march.corrected).toEqual({
      grossMinor: 31500,
      commissionMinor: 3150,
      netMinor: 28350,
      lineCount: 4,
      payoutsPaidMinor: 0,
    });
  });

  it('S16 AS-46: a payout that arrives after the close is booked as a late-payout adjustment', async () => {
    await closeDs1();
    setClock(t, '2026-04-04T10:00:00Z');
    const payoutId = uuidv4();
    await t.payouts.deliver(payoutPaid({ payoutId, shopId: shops.a, amountMinor: 25000, paidAt: '2026-03-30T10:00:00Z' }));
    await t.drainJobs();

    const booked = await adjustmentsOf(t);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ causeKind: 'late_payout', causeRef: payoutId, bookedMonth: '2026-04' });
    expect(num(booked[0].payouts)).toBe(25000);
    const march = await readStatement(t, shops.a, '2026-03');
    expect(march.own.payoutsPaidMinor).toBe(0);
    expect(march.corrected.payoutsPaidMinor).toBe(25000);
  });

  it('S16 AS-47: after a mix of changes and late facts, closed figures plus adjustments equal a fresh recomputation', async () => {
    await closeDs1();
    await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    await t.drainJobs();
    setClock(t, '2026-04-06T10:00:00Z');
    await t.sales.deliver(lateSaleL4(shops.a));
    await t.payouts.deliver(payoutPaid({ shopId: shops.b, amountMinor: 3000, paidAt: '2026-03-31T12:00:00Z' }));
    await setRate(t, { category: '*', rateBps: 800, validFrom: '2026-03-01T00:00:00Z', reason: 'default-800' });
    await t.drainJobs();

    for (const shop of [shops.a, shops.b]) {
      const closed = await readStatement(t, shop, '2026-03');
      const now = await readStatement(t, shop, '2026-03', `?knownAt=${encodeURIComponent(t.clock.now().toISOString())}`);
      expect(now.source).toBe('as_known_at');
      expect(closed.corrected).toEqual(now.own);
    }
    // nothing is left to book: another pass for every cause finds no difference
    const before = await adjustmentsOf(t);
    await jobs.reconcileMonth({ month: '2026-03', cause: 'close:again' }, ctx());
    expect(await adjustmentsOf(t)).toEqual(before);
  });

  it('S16 AS-48: a change recorded after the cutoff but before the month turns CLOSED is booked by the close itself', async () => {
    setClock(t, '2026-04-02T02:00:00Z');
    const admin = await t.admin();
    const accepted = await t.as(admin).post('/api/admin/accounting-periods/2026-03/close').set('Idempotency-Key', uuidv4());
    expect(accepted.status).toBe(202);
    const runId = accepted.body.runId as string;

    setClock(t, '2026-04-02T02:05:00Z');
    const change = await setRate(t, rc1(shops.a));
    expect(change.affectedClosedMonths).toEqual(['2026-03']); // the month is CLOSING
    await jobs.reconcileMonth({ month: '2026-03', cause: `rate_change:${change.changeId}`, shopId: shops.a }, ctx());
    expect(await adjustmentsOf(t)).toHaveLength(0); // nothing frozen yet: skipped

    await jobs.closeMonth({ month: '2026-03', runId }, ctx());
    await t.drainJobs(); // the close's own follow-up
    const booked = await adjustmentsOf(t);
    expect(booked).toHaveLength(1);
    expect(num(booked[0].commission)).toBe(-900);
    const march = await readStatement(t, shops.a, '2026-03');
    expect(march.own.commissionMinor).toBe(3050);
    expect(march.corrected.commissionMinor).toBe(2150);
  });

  it('S16 AS-48: a change recorded before the cutoff is already in the snapshot and books nothing', async () => {
    setClock(t, '2026-04-01T01:00:00Z');
    await setRate(t, rc1(shops.a));
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    expect(await adjustmentsOf(t)).toHaveLength(0);
    const march = await readStatement(t, shops.a, '2026-03');
    expect(march.own.commissionMinor).toBe(2150);
  });

  it('S16 AS-50: adjustments booked in a month ride its own close', async () => {
    await closeDs1();
    await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    await t.drainJobs();
    await closeMonth(t, '2026-04', '2026-05-02T02:00:00Z');

    const [row] = await t.sql<{ adj: string; gross: string }>(
      `SELECT "adjCommissionMinor"::text AS adj, gross::text FROM "StatementSnapshot" WHERE month = '2026-04-01' AND "shopId" = :shop`,
      { shop: shops.a },
    );
    expect(row).toEqual({ adj: '-900', gross: '0' });
    const april = await readStatement(t, shops.a, '2026-04');
    expect(april.status).toBe('CLOSED');
    expect(april.own.commissionMinor).toBe(0);
    expect(april.total.commissionMinor).toBe(-900);
    expect(april.total.netMinor).toBe(900);
  });
});
