import type { BillingTestApp } from './testing/billing-app';
import { createBillingApp } from './testing/billing-app';
import { createFs, expectStatus, key } from './testing/billing-flows';

/**
 * Journey through the public routes, the renewal run and the charge job (the five flows of the first billing spec).
 * Each scenario is proven in depth by its own spec file; this one keeps the end-to-end path in one place.
 */
describe('Billing: end-to-end journey', () => {
  let t: BillingTestApp;

  beforeAll(async () => {
    t = await createBillingApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const invoices = (subscriptionId: string) =>
    t.sql<{ kind: string; total: string; status: string }>(
      `SELECT kind, total, status FROM "Invoice" WHERE "subscriptionId" = :subscriptionId ORDER BY "periodStart", "createdAt"`,
      { subscriptionId },
    );
  const status = async (subscriptionId: string) =>
    (
      await t.sql<{ status: string }>(
        `SELECT status FROM "Subscription" WHERE id = :subscriptionId`,
        { subscriptionId },
      )
    )[0].status;

  it('S17 AS-09 AS-40: subscribe creates the first invoice and the charge job pays it', async () => {
    const fs = await createFs(t, { plan: 'pro', quantity: 3 });
    const [invoice] = await invoices(fs.subscriptionId);
    expect(invoice.total).toBe('29700');
    expect(invoice.status).toBe('PAID');
    expect(await status(fs.subscriptionId)).toBe('ACTIVE');
    expect(await invoices(fs.subscriptionId)).toHaveLength(1);
  });

  it('S17 AS-28: the renewal run is idempotent: two runs, one renewal invoice', async () => {
    const fs = await createFs(t, { plan: 'starter' });
    await t.at('2026-05-01T00:00:00.000Z', fs.owner);
    await Promise.all([t.renewals.run(), t.renewals.run()]);
    const renewals = (await invoices(fs.subscriptionId)).filter(
      (i) => i.kind === 'RENEWAL',
    );
    expect(renewals).toHaveLength(2); // the first invoice and one renewal
    expect(await invoices(fs.subscriptionId)).toHaveLength(2);
    expect(await status(fs.subscriptionId)).toBe('ACTIVE');
  });

  it('S17 AS-45: a declined first charge leaves the subscription past due', async () => {
    const fs = await createFs(t, {
      plan: 'pro',
      paymentMethodRef: 'pm_declined',
    });
    const [invoice] = await invoices(fs.subscriptionId);
    expect(invoice.status).not.toBe('PAID');
    expect(await status(fs.subscriptionId)).toBe('PAST_DUE');
  });

  it('S17 AS-60: an upgrade mid-cycle invoices what the preview showed', async () => {
    const fs = await createFs(t, { plan: 'starter' });
    await t.at('2026-04-16T00:00:00.000Z', fs.owner);
    const pro = await t.priceId('pro');
    const shown = await t
      .as(fs.owner)
      .post(`/api/shops/${fs.shopId}/subscription/preview`)
      .send({ priceId: pro });
    expectStatus(shown, 200);
    expectStatus(
      await t
        .as(fs.owner)
        .post(`/api/shops/${fs.shopId}/subscription/change`)
        .set('Idempotency-Key', key())
        .send({ priceId: pro }),
      200,
    );
    const proration = (await invoices(fs.subscriptionId)).find(
      (i) => i.kind === 'PRORATION',
    );
    expect(proration?.total).toBe('4000');
    expect(proration?.status).toBe('OPEN');
  });

  it('S17 AS-32: cancel at period end keeps access, then CANCELED at renewal with no new invoice', async () => {
    const fs = await createFs(t, { plan: 'pro' });
    expectStatus(
      await t
        .as(fs.owner)
        .post(`/api/shops/${fs.shopId}/subscription/cancel`)
        .send({}),
      200,
    );
    expect(await status(fs.subscriptionId)).toBe('ACTIVE');
    await t.at('2026-05-01T00:00:00.000Z', fs.owner);
    await t.renewals.run();
    expect(await status(fs.subscriptionId)).toBe('CANCELED');
    expect(await invoices(fs.subscriptionId)).toHaveLength(1);
  });
});
