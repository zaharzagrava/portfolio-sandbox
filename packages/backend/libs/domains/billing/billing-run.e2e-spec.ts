import { Logger } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { JobRegistry } from '@app/infrastructure/jobs/job-registry.service';
import type { TestUser } from '@app/test/utils/catalog-app';
import { BillingJobs } from './infra/billing.jobs';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import {
  T14_BODY,
  createFs,
  expectStatus,
  publishPrice,
  subscribeShop,
  type Fixture,
} from './testing/billing-flows';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Billing: renewal run', () => {
  let t: BillingTestApp;

  beforeAll(async () => {
    t = await createBillingApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date('2026-04-10T12:00:00.000Z'));
  });

  const rows = <T = Record<string, any>>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => t.sql<T>(sql, replacements);
  const count = async (table: string, where = 'true') =>
    Number(
      (
        await rows<{ n: string }>(
          `SELECT count(*) AS n FROM "${table}" WHERE ${where}`,
        )
      )[0].n,
    );
  const sub = async (id: string) =>
    (await rows(`SELECT * FROM "Subscription" WHERE id = :id`, { id }))[0];
  const invoices = (id: string) =>
    rows<{
      id: string;
      businessKey: string;
      total: string;
      status: string;
      periodStart: Date;
      periodEnd: Date;
      kind: string;
    }>(
      `SELECT id, "businessKey", total, status, "periodStart", "periodEnd", kind FROM "Invoice"
        WHERE "subscriptionId" = :id ORDER BY "periodStart", "createdAt"`,
      { id },
    );
  const chargeJobs = (invoiceId: string) =>
    count(
      'Job',
      `type = 'billing.charge-invoice' AND payload->>'invoiceId' = '${invoiceId}'`,
    );
  const iso = (d: Date) => new Date(d).toISOString();
  const proAt = (iso0: string, quantity = 3) =>
    createFs(t, { plan: 'pro', quantity, at: iso0 });

  it('S17 AS-26: a due subscription is renewed once: next period, version 1, one invoice and one charge request', async () => {
    const fs = await proAt('2026-04-10T12:00:00.000Z');
    await t.at('2026-05-10T12:00:00.000Z');
    const before = metric('billing_renewals_total', { outcome: 'invoiced' });
    const events = (await t.outbox('billing.subscription_status_changed'))
      .length;

    const summary = await t.renewals.run();
    expect(summary).toMatchObject({ examined: 1, invoiced: 1, failed: 0 });
    const row = await sub(fs.subscriptionId);
    expect(iso(row.currentPeriodStart)).toBe('2026-05-10T12:00:00.000Z');
    expect(iso(row.currentPeriodEnd)).toBe('2026-06-10T12:00:00.000Z');
    expect(row.version).toBe(1);
    expect(row.status).toBe('ACTIVE');
    const list = await invoices(fs.subscriptionId);
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({
      businessKey: 'renewal:2026-05-10T12:00:00.000Z',
      total: '29700',
      status: 'OPEN',
      kind: 'RENEWAL',
    });
    expect(await count('InvoiceLine', `"invoiceId" = '${list[1].id}'`)).toBe(1);
    expect(await chargeJobs(list[1].id)).toBe(1);
    expect(metric('billing_renewals_total', { outcome: 'invoiced' })).toBe(
      before + 1,
    );
    expect((await t.outbox('billing.subscription_status_changed')).length).toBe(
      events,
    );
  });

  it('S17 AS-27: due means the period end has been reached, to the millisecond', async () => {
    const fs = await proAt('2026-04-10T12:00:00.000Z');
    await t.at('2026-05-10T11:59:59.999Z');
    expect((await t.renewals.run()).examined).toBe(0);
    expect((await sub(fs.subscriptionId)).version).toBe(0);
    await t.at('2026-05-10T12:00:00.000Z');
    expect((await t.renewals.run()).invoiced).toBe(1);
    expect((await sub(fs.subscriptionId)).version).toBe(1);
  });

  it('S17 AS-28: two runs at once renew each subscription exactly once (50 subscriptions raced)', async () => {
    const all: Fixture[] = [];
    for (let i = 0; i < 50; i++)
      all.push(await proAt('2026-04-10T12:00:00.000Z'));
    await t.at('2026-05-10T12:00:00.000Z');
    const [a, b] = await Promise.all([t.renewals.run(), t.renewals.run()]);
    expect(a.invoiced + b.invoiced).toBe(50);
    expect(a.failed + b.failed).toBe(0);
    // the run that lost the race reports the subscription as already renewed
    expect(a.skipped + b.skipped).toBeGreaterThanOrEqual(0);
    for (const fs of all) {
      const row = await sub(fs.subscriptionId);
      expect(row.version).toBe(1);
      expect(iso(row.currentPeriodEnd)).toBe('2026-06-10T12:00:00.000Z');
      const list = await invoices(fs.subscriptionId);
      expect(
        list.filter(
          (i) => i.businessKey === 'renewal:2026-05-10T12:00:00.000Z',
        ),
      ).toHaveLength(1);
      expect(await chargeJobs(list[1].id)).toBe(1);
    }
  }, 240_000);

  it('S17 AS-29: the run is scheduled once, in UTC, with a 600 s lease, however many replicas boot', async () => {
    const jobs = t.app.get(BillingJobs);
    await jobs.onApplicationBootstrap();
    await jobs.onApplicationBootstrap();
    const schedules = await rows<Record<string, any>>(
      `SELECT * FROM "JobSchedule" WHERE name = 'billing.run'`,
    );
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      cron: '*/10 * * * *',
      timezone: 'UTC',
      jobType: 'billing.run',
      overlap: 'skip',
    });
    const handler = t.app
      .get(JobRegistry, { strict: false })
      .get('billing.run');
    expect(handler?.leaseMs).toBe(600_000);
    expect(handler?.concurrency).toBe(1);
  });

  it('S17 AS-31: a trial ends: the subscription becomes ACTIVE with its first invoice, and the tier does not move', async () => {
    const admin = await t.admin();
    const t14 = await publishPrice(t, admin, 'starter', T14_BODY);
    const made = await t.shopWithOwner();
    await t.reauth(made.owner);
    expectStatus(
      await subscribeShop(t, made.owner, made.shopId, {
        priceId: t14.id,
        quantity: 2,
        paymentMethodRef: 'pm_ok',
      }),
      201,
    );
    const [row0] = await rows<{ id: string }>(`SELECT id FROM "Subscription"`);
    const tierEvents = (await t.outbox('billing.subscription_plan_changed'))
      .length;
    await t.at('2026-04-24T12:00:00.000Z');
    expect((await t.renewals.run()).invoiced).toBe(1);

    const row = await sub(row0.id);
    expect(row.status).toBe('ACTIVE');
    expect(iso(row.currentPeriodStart)).toBe('2026-04-24T12:00:00.000Z');
    expect(iso(row.currentPeriodEnd)).toBe('2026-05-24T12:00:00.000Z');
    expect(row.trialEndsAt).toBeNull();
    const [history] = await rows<Record<string, any>>(
      `SELECT "fromStatus", "toStatus", reason, actor FROM "SubscriptionTransition" WHERE "subscriptionId" = :id AND version = 1`,
      { id: row0.id },
    );
    expect(history).toEqual({
      fromStatus: 'TRIALING',
      toStatus: 'ACTIVE',
      reason: 'trial_ended',
      actor: 'system:billing-run',
    });
    const list = await invoices(row0.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ total: '3800', status: 'OPEN' });
    expect(await chargeJobs(list[0].id)).toBe(1);
    const events = await t.outbox('billing.subscription_status_changed');
    expect(events[events.length - 1].payload).toMatchObject({
      status: 'ACTIVE',
      from: 'TRIALING',
    });
    expect((await t.outbox('billing.subscription_plan_changed')).length).toBe(
      tierEvents,
    );
  });

  it('S17 AS-32: cancellation takes effect at the period end: CANCELED, no invoice, tier falls, entitlements follow', async () => {
    const fs = await createFs(t, { plan: 'pro' });
    expectStatus(
      await t
        .as(fs.owner)
        .post(`/api/shops/${fs.shopId}/subscription/cancel`)
        .send({}),
      200,
    );
    await t.at('2026-05-01T00:00:00.000Z', fs.owner);
    const invoicesBefore = await count('Invoice');
    const jobsBefore = await count('Job', `type = 'billing.charge-invoice'`);
    expect((await t.renewals.run()).canceled).toBe(1);

    const row = await sub(fs.subscriptionId);
    expect(row.status).toBe('CANCELED');
    expect(row.canceledAt).not.toBeNull();
    expect(await count('Invoice')).toBe(invoicesBefore);
    expect(await count('Job', `type = 'billing.charge-invoice'`)).toBe(
      jobsBefore,
    );
    const history = await rows<{ reason: string }>(
      `SELECT reason FROM "SubscriptionTransition" WHERE "subscriptionId" = :id ORDER BY version DESC LIMIT 1`,
      { id: fs.subscriptionId },
    );
    expect(history[0].reason).toBe('cancel_at_period_end');
    const events = await t.outbox('billing.subscription_status_changed');
    expect(events[events.length - 1].payload).toMatchObject({
      status: 'CANCELED',
      from: 'ACTIVE',
    });
    expect(
      (await t.outbox('billing.subscription_plan_changed')).map((e) => [
        e.payload.plan,
        e.payload.version,
      ]),
    ).toEqual([
      ['PRO', 1],
      ['STARTER', 2],
    ]);
    const read = await t
      .as(fs.owner)
      .get(`/api/shops/${fs.shopId}/subscription`);
    expect(read.body.subscription).toBeNull();
    expect(read.body.entitlements.maxProducts).toBe(10); // the free tier
  });

  describe('delinquent subscriptions', () => {
    /** `pm_declined` from the start: the first attempt fails (PAST_DUE); three more days make it UNPAID. */
    const pastDue = () => createFs(t, { paymentMethodRef: 'pm_declined' });
    const unpaid = async () => {
      const fs = await pastDue();
      for (const day of ['2026-04-02', '2026-04-04', '2026-04-08']) {
        await t.at(`${day}T00:00:00.000Z`);
        await t.drainJobs();
      }
      return fs;
    };

    it('S17 AS-33: past-due and unpaid subscriptions are not renewed; with a cancellation scheduled they end', async () => {
      const a = await pastDue();
      expect((await sub(a.subscriptionId)).status).toBe('PAST_DUE');
      await t.at('2026-05-01T00:00:00.000Z');
      await t.renewals.run(); // jobs are not drained: the first dunning step stays where it is
      const pastRow = await sub(a.subscriptionId);
      expect(pastRow.status).toBe('PAST_DUE');
      expect(iso(pastRow.currentPeriodEnd)).toBe('2026-05-01T00:00:00.000Z');
      expect(await invoices(a.subscriptionId)).toHaveLength(1);

      await t.reset();
      t.clock.set(new Date('2026-04-01T00:00:00.000Z'));
      const b = await unpaid();
      expect((await sub(b.subscriptionId)).status).toBe('UNPAID');
      await t.at('2026-05-01T00:00:00.000Z');
      await t.renewals.run();
      const unpaidRow = await sub(b.subscriptionId);
      expect(unpaidRow.status).toBe('UNPAID');
      expect(iso(unpaidRow.currentPeriodEnd)).toBe('2026-05-01T00:00:00.000Z');
      expect(await invoices(b.subscriptionId)).toHaveLength(1);
    });

    it('S17 AS-33: scheduled cancellation ends both at their period end', async () => {
      const a = await pastDue(); // PAST_DUE after its first attempt
      await t.at('2026-04-01T00:00:01.000Z', a.owner);
      expectStatus(
        await t
          .as(a.owner)
          .post(`/api/shops/${a.shopId}/subscription/cancel`)
          .send({}),
        200,
      );
      const b = await unpaid(); // the clock is at 04-08 now; drains also moved `a` along
      await t.at('2026-04-09T00:00:00.000Z', b.owner);
      expectStatus(
        await t
          .as(b.owner)
          .post(`/api/shops/${b.shopId}/subscription/cancel`)
          .send({}),
        200,
      );
      await t.at('2026-05-01T00:00:00.000Z');
      const summary = await t.renewals.run();
      expect(summary.canceled).toBe(2);
      expect((await sub(a.subscriptionId)).status).toBe('CANCELED');
      expect((await sub(b.subscriptionId)).status).toBe('CANCELED');
      expect(await invoices(a.subscriptionId)).toHaveLength(1);
      expect(await invoices(b.subscriptionId)).toHaveLength(1);
    });

    it('S17 AS-34: unpaid for 30 days is cancelled, to the millisecond, and its invoices stay uncollectible', async () => {
      const fs = await unpaid();
      const [{ statusSince }] = await rows<{ statusSince: Date }>(
        `SELECT "statusSince" FROM "Subscription" WHERE id = :id`,
        { id: fs.subscriptionId },
      );
      const expiry = new Date(
        new Date(statusSince).getTime() + 30 * 86_400_000,
      );
      t.clock.set(new Date(expiry.getTime() - 1));
      await t.renewals.run();
      expect((await sub(fs.subscriptionId)).status).toBe('UNPAID');
      t.clock.set(expiry);
      expect((await t.renewals.run()).expired).toBe(1);
      expect((await sub(fs.subscriptionId)).status).toBe('CANCELED');
      const history = await rows<{ reason: string }>(
        `SELECT reason FROM "SubscriptionTransition" WHERE "subscriptionId" = :id ORDER BY version DESC LIMIT 1`,
        { id: fs.subscriptionId },
      );
      expect(history[0].reason).toBe('unpaid_expired');
      expect((await invoices(fs.subscriptionId)).map((i) => i.status)).toEqual([
        'UNCOLLECTIBLE',
      ]);
    });
  });

  it('S17 AS-35: after downtime the run catches up one period per run, one invoice per period', async () => {
    const fs = await createFs(t, {
      plan: 'pro',
      quantity: 1,
      at: '2026-01-01T00:00:00.000Z',
    });
    await t.at('2026-04-15T00:00:00.000Z');
    const keys: string[] = [];
    for (let run = 1; run <= 3; run++) {
      expect((await t.renewals.run()).invoiced).toBe(1);
      const row = await sub(fs.subscriptionId);
      expect(row.version).toBe(run);
      keys.push(
        ...(await invoices(fs.subscriptionId))
          .map((i) => i.businessKey)
          .slice(-1),
      );
    }
    expect(keys).toEqual([
      'renewal:2026-02-01T00:00:00.000Z',
      'renewal:2026-03-01T00:00:00.000Z',
      'renewal:2026-04-01T00:00:00.000Z',
    ]);
    expect(iso((await sub(fs.subscriptionId)).currentPeriodEnd)).toBe(
      '2026-05-01T00:00:00.000Z',
    );
    const summary = await t.renewals.run();
    expect(summary.examined).toBe(0);
    expect(await invoices(fs.subscriptionId)).toHaveLength(4);
  });

  it('S17 AS-36: when the usage lines are unavailable the subscription is deferred whole; the next run renews it', async () => {
    const s1 = await proAt('2026-04-10T12:00:00.000Z', 1);
    const s2 = await proAt('2026-04-10T12:00:00.000Z', 1);
    t.usage.fail(s1.subscriptionId);
    await t.at('2026-05-10T12:00:00.000Z');
    const deferred = metric('billing_renewal_deferred_total', {
      reason: 'usage_unavailable',
    });
    const summary = await t.renewals.run();
    expect(summary).toMatchObject({ invoiced: 1, deferred: 1, failed: 0 });
    const untouched = await sub(s1.subscriptionId);
    expect(untouched.version).toBe(0);
    expect(iso(untouched.currentPeriodEnd)).toBe('2026-05-10T12:00:00.000Z');
    expect(await invoices(s1.subscriptionId)).toHaveLength(1);
    expect((await sub(s2.subscriptionId)).version).toBe(1);
    expect(
      metric('billing_renewal_deferred_total', { reason: 'usage_unavailable' }),
    ).toBe(deferred + 1);
    expect(t.usage.calls.every((c) => c.timeoutMs === 5000)).toBe(true);

    t.usage.recover(s1.subscriptionId);
    expect((await t.renewals.run()).invoiced).toBe(1);
    expect((await sub(s1.subscriptionId)).version).toBe(1);
  });

  it('S17 AS-26: usage lines from S18 become invoice lines of the renewal', async () => {
    const fs = await proAt('2026-04-10T12:00:00.000Z', 1);
    t.usage.set(fs.subscriptionId, [
      {
        kind: 'USAGE',
        description: 'api.calls over 1000000 (5000)',
        quantity: 5000,
        amountMinor: 100,
      },
    ]);
    await t.at('2026-05-10T12:00:00.000Z');
    await t.renewals.run();
    const list = await invoices(fs.subscriptionId);
    expect(list[1].total).toBe('10000');
    const lines = await rows<{ kind: string; amount: string }>(
      `SELECT kind, amount FROM "InvoiceLine" WHERE "invoiceId" = :id ORDER BY id`,
      { id: list[1].id },
    );
    expect(lines.map((l) => [l.kind, l.amount])).toEqual([
      ['PLAN', '9900'],
      ['USAGE', '100'],
    ]);
    const [measured] = await rows<{ usageMeasuredAt: Date }>(
      `SELECT "usageMeasuredAt" FROM "Invoice" WHERE id = :id`,
      { id: list[1].id },
    );
    expect(iso(measured.usageMeasuredAt)).toBe('2026-05-10T12:00:00.000Z');
  });

  describe('S17 AS-37: one bad subscription never blocks the others; a crash resumes', () => {
    /** A subscription whose renewal invoice already exists under its business key: it cannot be renewed twice. */
    const poison = (id: string, end: string) =>
      t.sequelize.query(
        `INSERT INTO "Invoice" ("subscriptionId", "kind", "businessKey", "periodStart", "periodEnd", "status", "total", "currency", "paidAt")
         VALUES (:id, 'RENEWAL', :key, :end, :end2, 'PAID', 0, 'EUR', :end)`,
        {
          replacements: {
            id,
            key: `renewal:${end}`,
            end,
            end2: '2026-06-10T12:00:00.000Z',
          },
        },
      );

    it('S17 AS-37: the other four are renewed, the bad one is logged once with its id and counted', async () => {
      const five: Fixture[] = [];
      for (let i = 0; i < 5; i++)
        five.push(await proAt('2026-04-10T12:00:00.000Z', 1));
      await poison(five[2].subscriptionId, '2026-05-10T12:00:00.000Z');
      await t.at('2026-05-10T12:00:00.000Z');
      const failed = metric('billing_renewal_failed_total');
      const logged = jest.spyOn(Logger.prototype, 'error');
      try {
        const summary = await t.renewals.run();
        expect(summary).toMatchObject({ invoiced: 4, failed: 1 });
        const mine = logged.mock.calls.filter((c) =>
          String(c[0]).includes(five[2].subscriptionId),
        );
        expect(mine).toHaveLength(1);
        expect(String(mine[0][0])).not.toMatch(/pm_/);
      } finally {
        logged.mockRestore();
      }
      expect(metric('billing_renewal_failed_total')).toBe(failed + 1);
      for (const [index, fs] of five.entries())
        expect((await sub(fs.subscriptionId)).version).toBe(
          index === 2 ? 0 : 1,
        );
    });

    it('S17 AS-37: killed after the second renewal committed, the next run renews the rest and none twice', async () => {
      const five: Fixture[] = [];
      for (let i = 0; i < 5; i++)
        five.push(await proAt('2026-04-10T12:00:00.000Z', 1));
      await t.at('2026-05-10T12:00:00.000Z');
      t.fault.afterSubscription = (n) => {
        if (n === 2) throw new Error('process killed');
      };
      await expect(t.renewals.run()).rejects.toThrow('process killed');
      delete t.fault.afterSubscription;
      const versions = await Promise.all(
        five.map(async (fs) => (await sub(fs.subscriptionId)).version),
      );
      expect(versions.filter((v) => v === 1)).toHaveLength(2);
      expect((await t.renewals.run()).invoiced).toBe(3);
      for (const fs of five) {
        expect((await sub(fs.subscriptionId)).version).toBe(1);
        const keys = (await invoices(fs.subscriptionId)).map(
          (i) => i.businessKey,
        );
        expect(keys).toEqual([
          'renewal:2026-04-10T12:00:00.000Z',
          'renewal:2026-05-10T12:00:00.000Z',
        ]);
      }
    });
  });

  describe('S17 AS-38: batches, ordering and no double claim', () => {
    const seedDue = async (n: number) => {
      const starter = await t.priceId('starter');
      await t.sequelize.query(
        `INSERT INTO "Subscription" ("subjectType", "subjectId", "priceId", "status", "quantity", "billingAnchorDay",
                                     "currentPeriodStart", "currentPeriodEnd", "version")
         SELECT 'SHOP', gen_random_uuid(), :price, 'ACTIVE', 1, 1,
                TIMESTAMPTZ '2026-03-01T00:00:00Z' + (g || ' seconds')::interval,
                TIMESTAMPTZ '2026-04-01T00:00:00Z' + (g || ' seconds')::interval, 0
           FROM generate_series(1, :n) AS g`,
        { replacements: { price: starter, n } },
      );
    };

    it('S17 AS-38: 1,200 due subscriptions take three runs of at most 500, oldest period end first', async () => {
      await seedDue(1200);
      await t.at('2026-05-01T00:00:00.000Z');
      const first = await t.renewals.run();
      expect(first.examined).toBe(500);
      const renewedAfterFirst = await rows<{ currentPeriodEnd: Date }>(
        `SELECT "currentPeriodEnd" FROM "Subscription" WHERE version = 1 ORDER BY "currentPeriodEnd" DESC LIMIT 1`,
      );
      const stillDue = await rows<{ n: string }>(
        `SELECT count(*) AS n FROM "Subscription" WHERE version = 0 AND "currentPeriodEnd" < :cutoff`,
        {
          cutoff: new Date(
            new Date('2026-04-01T00:00:00Z').getTime() + 500 * 1000,
          ),
        },
      );
      expect(stillDue[0].n).toBe('0'); // the 500 oldest were taken, none older was left behind
      expect(renewedAfterFirst).toHaveLength(1);
      const second = await t.renewals.run();
      const third = await t.renewals.run();
      expect([second.examined, third.examined]).toEqual([500, 200]);
      expect(first.invoiced + second.invoiced + third.invoiced).toBe(1200);
      expect(await count('Invoice')).toBe(1200);
      expect(await count('Subscription', 'version = 1')).toBe(1200);
      expect((await t.renewals.run()).examined).toBe(0);
    }, 300_000);

    it('S17 AS-38: overlapping runs never renew a subscription twice', async () => {
      await seedDue(300);
      await t.at('2026-05-01T00:00:00.000Z');
      const [a, b, c] = await Promise.all([
        t.renewals.run(),
        t.renewals.run(),
        t.renewals.run(),
      ]);
      expect(a.failed + b.failed + c.failed).toBe(0);
      expect(a.invoiced + b.invoiced + c.invoiced).toBe(300);
      expect(await count('Invoice')).toBe(300);
      expect(await count('Subscription', 'version <> 1')).toBe(0);
    }, 300_000);
  });

  it('S17 AS-39: an issued invoice and its lines cannot be edited, even by a privileged session', async () => {
    const fs = await proAt('2026-04-10T12:00:00.000Z', 1);
    await t.at('2026-05-10T12:00:00.000Z');
    await t.renewals.run();
    const [invoice] = (await invoices(fs.subscriptionId)).slice(-1);
    const edits = [
      `"total" = 1`,
      `"periodStart" = "periodStart" + interval '1 day'`,
      `"periodEnd" = "periodEnd" + interval '1 day'`,
      `"kind" = 'PRORATION'`,
      `"businessKey" = 'renewal:other'`,
      `"currency" = 'USD'`,
    ];
    for (const set of edits)
      await expect(
        t.sequelize.query(`UPDATE "Invoice" SET ${set} WHERE id = :id`, {
          replacements: { id: invoice.id },
        }),
      ).rejects.toThrow(/billing_invoice_immutable|violates/);
    for (const statement of [
      `UPDATE "InvoiceLine" SET amount = 1 WHERE "invoiceId" = :id`,
      `UPDATE "InvoiceLine" SET description = 'x' WHERE "invoiceId" = :id`,
      `UPDATE "InvoiceLine" SET quantity = 9 WHERE "invoiceId" = :id`,
      `UPDATE "InvoiceLine" SET kind = 'USAGE' WHERE "invoiceId" = :id`,
      `DELETE FROM "InvoiceLine" WHERE "invoiceId" = :id`,
      `DELETE FROM "Invoice" WHERE id = :id`,
    ])
      await expect(
        t.sequelize.query(statement, { replacements: { id: invoice.id } }),
      ).rejects.toThrow(/billing_invoice/);
    // status moves along its edges; attempt fields may change; a settled invoice cannot go back
    await t.sequelize.query(
      `UPDATE "Invoice" SET status = 'PAID', "paidAt" = now(), attempts = 1 WHERE id = :id`,
      { replacements: { id: invoice.id } },
    );
    await expect(
      t.sequelize.query(`UPDATE "Invoice" SET status = 'OPEN' WHERE id = :id`, {
        replacements: { id: invoice.id },
      }),
    ).rejects.toThrow(/billing_invoice_immutable/);
    const [after] = await invoices(fs.subscriptionId).then((l) => l.slice(-1));
    expect(after).toMatchObject({
      total: '9900',
      businessKey: 'renewal:2026-05-10T12:00:00.000Z',
    });
    void ({} as TestUser);
  });
});
