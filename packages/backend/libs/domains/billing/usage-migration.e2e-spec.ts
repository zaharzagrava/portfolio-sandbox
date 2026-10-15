import { v4 as uuidv4 } from 'uuid';
import { USAGE_STORE, type UsageStorePort } from './domain/ports';
import { UsageSettlementBackfill } from './infra/usage-settlement.backfill';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import { createFs } from './testing/billing-flows';

const NOW = '2026-05-10T12:00:00.000Z';

describe('Billing: usage ledger migration', () => {
  let t: BillingTestApp;
  let store: UsageStorePort;
  let backfill: UsageSettlementBackfill;

  beforeAll(async () => {
    t = await createBillingApp({ realUsage: true });
    store = t.app.get<UsageStorePort>(USAGE_STORE, { strict: false });
    backfill = t.app.get(UsageSettlementBackfill, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date(NOW));
  });

  const ledger = (subscriptionId: string) =>
    t.sql<{
      metric: string;
      periodStart: Date;
      periodEnd: Date;
      settledQuantity: string;
      settledAmountMinor: string;
      includedQuantity: string;
      overagePer1000Minor: string;
      lastInvoiceId: string;
      closed: boolean;
    }>(
      `SELECT "metric", "periodStart", "periodEnd", "settledQuantity", "settledAmountMinor", "includedQuantity",
              "overagePer1000Minor", "lastInvoiceId", "closed"
         FROM "UsageSettlement" WHERE "subscriptionId" = :subscriptionId ORDER BY "periodStart", "metric"`,
      { subscriptionId },
    );

  /** An invoice as the previous implementation issued it: a renewal that measured usage at `measuredAt`. */
  async function legacyInvoice(
    subscriptionId: string,
    periodStart: string,
    periodEnd: string,
    measuredAt: string,
    usageLine?: { description: string; quantity: number; amountMinor: number },
  ): Promise<string> {
    const id = uuidv4();
    await t.sequelize.query(
      `INSERT INTO "Invoice" ("id", "subscriptionId", "kind", "businessKey", "periodStart", "periodEnd", "status",
                              "total", "currency", "usageMeasuredAt", "paidAt", "createdAt", "updatedAt")
       VALUES (:id, :subscriptionId, 'RENEWAL', :businessKey, :periodStart, :periodEnd, 'PAID', 1900, 'EUR',
               :measuredAt, :measuredAt, :measuredAt, :measuredAt)`,
      {
        replacements: {
          id,
          subscriptionId,
          businessKey: `renewal:${new Date(periodStart).toISOString()}`,
          periodStart,
          periodEnd,
          measuredAt,
        },
      },
    );
    if (usageLine)
      await t.sequelize.query(
        `INSERT INTO "InvoiceLine" ("invoiceId", "kind", "description", "quantity", "amount")
         VALUES (:id, 'USAGE', :description, :quantity, :amountMinor)`,
        { replacements: { id, ...usageLine } },
      );
    return id;
  }

  const events = (
    subjectId: string,
    count: number,
    ts: string,
    prefix: string,
  ) =>
    Array.from({ length: count }, (_, i) => ({
      identity: `${prefix}-${i}`,
      subjectId,
      metric: 'api.calls',
      quantity: 1,
      ts: new Date(ts),
    }));

  it('S18 AS-48: pre-release invoices of the last 90 days become ledger rows with the usage that existed at the measurement, repeatably', async () => {
    const fs = await createFs(t, { at: '2026-04-01T00:00:00.000Z' });
    t.clock.set(new Date(NOW));
    const shopId = fs.shopId;
    // 11,000 April calls ingested before the 05-01 measurement, 1,500 ingested after it (late).
    await store.insert(
      events(shopId, 11_000, '2026-04-15T10:00:00.000Z', 'on-time'),
      new Date('2026-04-20T00:00:00.000Z'),
    );
    await store.insert(
      events(shopId, 1_500, '2026-04-28T10:00:00.000Z', 'late'),
      new Date('2026-05-03T09:00:00.000Z'),
    );
    const invoiceId = await legacyInvoice(
      fs.subscriptionId,
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
      {
        description: 'api.calls over 10000 (1000)',
        quantity: 1000,
        amountMinor: 50,
      },
    );
    // older than 90 days at NOW: never migrated
    const oldShop = await createFs(t, { at: '2026-01-01T00:00:00.000Z' });
    t.clock.set(new Date(NOW));
    await legacyInvoice(
      oldShop.subscriptionId,
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    );
    await store.insert(
      events(oldShop.shopId, 20_000, '2026-01-10T10:00:00.000Z', 'old'),
      new Date('2026-01-11T00:00:00.000Z'),
    );

    const first = await backfill.run(t.clock.now());
    expect(first.inserted).toBe(1);

    const rows = await ledger(fs.subscriptionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      metric: 'api.calls',
      settledQuantity: '11000',
      settledAmountMinor: '50',
      includedQuantity: '10000',
      overagePer1000Minor: '50',
      lastInvoiceId: invoiceId,
      closed: false,
    });
    expect(rows[0].periodStart.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(rows[0].periodEnd.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(await ledger(oldShop.subscriptionId)).toEqual([]);

    // repeatable: a second run changes nothing
    const second = await backfill.run(t.clock.now());
    expect(second.inserted).toBe(0);
    expect(await ledger(fs.subscriptionId)).toEqual(rows);
  });

  it('S18 AS-48: units the previous implementation already billed as late events on the next invoice are not billed again', async () => {
    const fs = await createFs(t, { at: '2026-03-01T00:00:00.000Z' });
    t.clock.set(new Date(NOW));
    // March usage: 10,500 on time; 700 more arrived after the April invoice measured, before the May one did.
    await store.insert(
      events(fs.shopId, 10_500, '2026-03-12T10:00:00.000Z', 'mar'),
      new Date('2026-03-20T00:00:00.000Z'),
    );
    await store.insert(
      events(fs.shopId, 700, '2026-03-30T10:00:00.000Z', 'mar-late'),
      new Date('2026-04-15T00:00:00.000Z'),
    );
    await legacyInvoice(
      fs.subscriptionId,
      '2026-04-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    );
    const next = await legacyInvoice(
      fs.subscriptionId,
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    );
    await backfill.run(t.clock.now());
    const march = (await ledger(fs.subscriptionId)).find(
      (r) => r.periodStart.toISOString() === '2026-03-01T00:00:00.000Z',
    );
    // billed: 10,500 on the April invoice, the 700 late ones on the May invoice
    expect(march).toMatchObject({
      settledQuantity: '11200',
      settledAmountMinor: '100',
      lastInvoiceId: next,
    });
  });

  it('S18 AS-48: the forward-only trigger rejects lowering settled values and changing the snapshot', async () => {
    const fs = await createFs(t, { at: '2026-04-01T00:00:00.000Z' });
    await store.insert(
      events(fs.shopId, 11_000, '2026-04-15T10:00:00.000Z', 'trg'),
      new Date('2026-04-20T00:00:00.000Z'),
    );
    await legacyInvoice(
      fs.subscriptionId,
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    );
    await backfill.run(t.clock.now());
    const update = (set: string) =>
      t.sequelize.query(
        `UPDATE "UsageSettlement" SET ${set} WHERE "subscriptionId" = :id`,
        { replacements: { id: fs.subscriptionId } },
      );
    await expect(update(`"settledQuantity" = 10999`)).rejects.toThrow(
      /usage_settlement_forward_only/,
    );
    await expect(update(`"settledAmountMinor" = 0`)).rejects.toThrow(
      /usage_settlement_forward_only/,
    );
    await expect(update(`"includedQuantity" = 1`)).rejects.toThrow(
      /usage_settlement_forward_only/,
    );
    await expect(update(`"overagePer1000Minor" = 1`)).rejects.toThrow(
      /usage_settlement_forward_only/,
    );
    await expect(
      update(`"periodEnd" = "periodEnd" + interval '1 day'`),
    ).rejects.toThrow(/usage_settlement_forward_only/);
    await update(`"settledQuantity" = 11001, "settledAmountMinor" = 100`);
    await update(`"closed" = true`);
    await expect(update(`"closed" = false`)).rejects.toThrow(
      /usage_settlement_forward_only/,
    );
    expect((await ledger(fs.subscriptionId))[0]).toMatchObject({
      settledQuantity: '11001',
      closed: true,
    });
  });
});
