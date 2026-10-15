import {
  planCatalogSchema,
  planSchema,
  adminPriceSchema,
  retirePriceResultSchema,
} from '@marketplace-sandbox/contracts';
import type { TestUser } from '@app/test/utils/catalog-app';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import { T14_BODY, createFs, publishPrice } from './testing/billing-flows';

describe('Billing: plans and versioned prices', () => {
  let t: BillingTestApp;
  let admin: TestUser;

  beforeAll(async () => {
    t = await createBillingApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date('2026-04-10T12:00:00Z'));
    admin = await t.admin();
  });

  const planId = async (code: string) =>
    (
      await t.sql<{ id: string }>(`SELECT id FROM "Plan" WHERE code = :code`, {
        code,
      })
    )[0].id;
  const planCount = async () =>
    Number(
      (await t.sql<{ n: string }>(`SELECT count(*) AS n FROM "Plan"`))[0].n,
    );
  const priceCount = async () =>
    Number(
      (await t.sql<{ n: string }>(`SELECT count(*) AS n FROM "Price"`))[0].n,
    );
  const postPlan = (
    body: Record<string, unknown>,
    who: TestUser | null = admin,
  ) =>
    (who
      ? t.as(who).post('/api/admin/billing/plans')
      : t.http().post('/api/admin/billing/plans')
    ).send(body);
  const postPrice = (
    id: string,
    body: Record<string, unknown>,
    who: TestUser | null = admin,
  ) =>
    (who
      ? t.as(who).post(`/api/admin/billing/plans/${id}/prices`)
      : t.http().post(`/api/admin/billing/plans/${id}/prices`)
    ).send(body);

  it('S17 AS-01: the public catalog lists only active prices, in a fixed order, with explicit fields', async () => {
    const t14 = await publishPrice(t, admin, 'starter', T14_BODY);
    const retired = await publishPrice(t, admin, 'pro', {
      interval: 'MONTH',
      unitAmountMinor: 12900,
      perSeat: true,
    });
    expect(
      (await t.as(admin).post(`/api/admin/billing/prices/${retired.id}/retire`))
        .status,
    ).toBe(200);

    const res = await t.http().get('/api/plans');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, s-maxage=300');
    const catalog = planCatalogSchema.parse(res.body);

    expect(catalog.plans.map((p) => p.code)).toEqual([
      'plus',
      'pro',
      'starter',
    ]);
    const plus = catalog.plans[0];
    expect(plus.prices.map((p) => [p.interval, p.unitAmountMinor])).toEqual([
      ['MONTH', 499],
      ['YEAR', 4990],
    ]);
    const starter = catalog.plans[2];
    expect(
      starter.prices.map((p) => [p.version, p.unitAmountMinor, p.trialDays]),
    ).toEqual([
      [1, 1900, 0],
      [2, 1900, 14],
    ]);
    expect(starter.prices[1].id).toBe(t14.id);
    // the retired price and every internal field are absent
    expect(JSON.stringify(res.body)).not.toContain(retired.id);
    expect(catalog.plans.find((p) => p.code === 'pro')?.prices).toHaveLength(1);
    const sample = starter.prices[0] as Record<string, unknown>;
    expect(Object.keys(sample).sort()).toEqual(
      [
        'currency',
        'id',
        'includedUsage',
        'interval',
        'overagePer1000Minor',
        'perSeat',
        'trialDays',
        'unitAmountMinor',
        'version',
      ].sort(),
    );
    expect(sample.includedUsage).toEqual({ 'api.calls': 10000 });
    expect(sample.overagePer1000Minor).toEqual({ 'api.calls': 50 });
  });

  it('S17 AS-02: an admin creates a plan; a repeated code, a bad shop code and a bad body write nothing', async () => {
    const body = {
      code: 'enterprise',
      name: 'Enterprise',
      audience: 'SHOP',
      entitlements: {
        maxProducts: 100000,
        seats: 250,
        auctions: true,
        apiCallsPerMonth: 10_000_000,
        assistantTokensPerMonth: 20_000_000,
      },
    };
    const created = await postPlan(body);
    expect(created.status).toBe(201);
    const plan = planSchema.parse(created.body);
    expect(plan).toMatchObject({
      code: 'enterprise',
      name: 'Enterprise',
      audience: 'SHOP',
      entitlements: body.entitlements,
    });
    const [row] = await t.sql<{ code: string; entitlements: unknown }>(
      `SELECT code, entitlements FROM "Plan" WHERE id = :id`,
      { id: plan.id },
    );
    expect(row).toEqual({
      code: 'enterprise',
      entitlements: body.entitlements,
    });

    const total = await planCount();
    const again = await postPlan(body);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('plan_code_taken');
    expect(await planCount()).toBe(total);

    const invalid: Array<Record<string, unknown>> = [
      { ...body, code: 'gold' }, // a shop plan must be starter, pro or enterprise
      { ...body, audience: 'BUYER', code: 'Bad Code' }, // not matching the code pattern
      { ...body, audience: 'BUYER', code: 'x' }, // too short
      {
        ...body,
        audience: 'BUYER',
        code: 'vip',
        entitlements: { teleport: true },
      }, // unknown key
      {
        ...body,
        audience: 'BUYER',
        code: 'vip',
        entitlements: { maxProducts: -1 },
      }, // negative
      { ...body, audience: 'BUYER', code: 'vip', extra: 1 }, // unknown field
      { ...body, audience: 'BUYER', code: 'vip', name: '' },
    ];
    for (const bad of invalid) {
      const res = await postPlan(bad);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    }
    expect(await planCount()).toBe(total);
  });

  it('S17 AS-03: a new price is a new version; the existing row is untouched and both are listed', async () => {
    const starter = await planId('starter');
    const [before] = await t.sql<Record<string, unknown>>(
      `SELECT * FROM "Price" WHERE "planId" = :starter`,
      { starter },
    );
    const res = await postPrice(starter, {
      interval: 'MONTH',
      unitAmountMinor: 2400,
      perSeat: true,
      trialDays: 0,
      includedUsage: { 'api.calls': 10000 },
      overagePer1000Minor: { 'api.calls': 60 },
    });
    expect(res.status).toBe(201);
    const price = adminPriceSchema.parse(res.body);
    expect(price).toMatchObject({
      version: 2,
      active: true,
      unitAmountMinor: 2400,
      planId: starter,
      overagePer1000Minor: { 'api.calls': 60 },
    });
    const [after] = await t.sql<Record<string, unknown>>(
      `SELECT * FROM "Price" WHERE id = :id`,
      { id: before.id },
    );
    expect(after).toEqual(before);
    expect(after.active).toBe(true);

    const catalog = planCatalogSchema.parse(
      (await t.http().get('/api/plans')).body,
    );
    expect(
      catalog.plans
        .find((p) => p.code === 'starter')
        ?.prices.map((p) => [p.version, p.unitAmountMinor]),
    ).toEqual([
      [1, 1900],
      [2, 2400],
    ]);
    // versions count per plan and interval
    const yearly = await postPrice(starter, {
      interval: 'YEAR',
      unitAmountMinor: 19000,
      perSeat: true,
    });
    expect(adminPriceSchema.parse(yearly.body).version).toBe(1);
  });

  it('S17 AS-04: subscribers keep their price when it is retired and replaced; a new customer cannot buy the retired one', async () => {
    const fs = await createFs(t);
    admin = await t.admin(); // the clock moved: a new admin session
    const v1 = await t.priceId('starter');
    const v2 = await publishPrice(t, admin, 'starter', {
      interval: 'MONTH',
      unitAmountMinor: 2400,
      perSeat: true,
    });
    expect(
      (await t.as(admin).post(`/api/admin/billing/prices/${v1}/retire`)).status,
    ).toBe(200);

    await t.at('2026-05-01T00:00:00.000Z');
    await t.runBilling();
    const invoices = await t.sql<{ total: string; businessKey: string }>(
      `SELECT total, "businessKey" FROM "Invoice" WHERE "subscriptionId" = :id ORDER BY "createdAt", id`,
      { id: fs.subscriptionId },
    );
    expect(invoices.map((i) => i.businessKey)).toEqual([
      'renewal:2026-04-01T00:00:00.000Z',
      'renewal:2026-05-01T00:00:00.000Z',
    ]);
    expect(invoices.map((i) => i.total)).toEqual(['1900', '1900']);

    const other = await t.shopWithOwner();
    await t.reauth(other.owner);
    const before = Number(
      (
        await t.sql<{ n: string }>(`SELECT count(*) AS n FROM "Subscription"`)
      )[0].n,
    );
    const res = await t
      .as(other.owner)
      .post(`/api/shops/${other.shopId}/subscription`)
      .set('Idempotency-Key', 'retired-1')
      .send({ priceId: v1, quantity: 1, paymentMethodRef: 'pm_ok' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('price_not_found');
    expect(
      Number(
        (
          await t.sql<{ n: string }>(`SELECT count(*) AS n FROM "Subscription"`)
        )[0].n,
      ),
    ).toBe(before);
    expect(v2.version).toBe(2);
  });

  describe('S17 AS-05: the store refuses to edit a price', () => {
    const edits: Array<[string, string, Record<string, unknown>?]> = [
      ['unitAmount', `"unitAmount" = 1`],
      ['interval', `"interval" = 'YEAR'`],
      ['currency', `"currency" = 'USD'`],
      ['perSeat', `"perSeat" = NOT "perSeat"`],
      ['trialDays', `"trialDays" = 3`],
      ['includedUsage', `"includedUsage" = '{}'::jsonb`],
      ['overagePer1000', `"overagePer1000" = '{"api.calls": 1}'::jsonb`],
      ['planId', `"planId" = (SELECT id FROM "Plan" WHERE code = 'plus')`],
      ['version', `"version" = 9`],
    ];

    it.each(edits)(
      'S17 AS-05: changing %s is rejected and the row is unchanged',
      async (_name, set) => {
        const id = await t.priceId('starter');
        const [before] = await t.sql(`SELECT * FROM "Price" WHERE id = :id`, {
          id,
        });
        await expect(
          t.sequelize.query(`UPDATE "Price" SET ${set} WHERE id = :id`, {
            replacements: { id },
          }),
        ).rejects.toThrow(/billing_price_immutable|violates/);
        const [after] = await t.sql(`SELECT * FROM "Price" WHERE id = :id`, {
          id,
        });
        expect(after).toEqual(before);
      },
    );

    it('S17 AS-05: a retired price cannot come back, but retiring one is accepted', async () => {
      const id = await t.priceId('starter');
      await t.sequelize.query(
        `UPDATE "Price" SET active = FALSE WHERE id = :id`,
        { replacements: { id } },
      );
      await expect(
        t.sequelize.query(`UPDATE "Price" SET active = TRUE WHERE id = :id`, {
          replacements: { id },
        }),
      ).rejects.toThrow(/billing_price_immutable/);
      const [row] = await t.sql<{ active: boolean }>(
        `SELECT active FROM "Price" WHERE id = :id`,
        { id },
      );
      expect(row.active).toBe(false);
    });

    it('S17 AS-05: a price that subscriptions use is never deleted', async () => {
      await createFs(t);
      const id = await t.priceId('starter');
      await expect(
        t.sequelize.query(`DELETE FROM "Price" WHERE id = :id`, {
          replacements: { id },
        }),
      ).rejects.toThrow(/billing_price_immutable/);
    });
  });

  it('S17 AS-06: a price outside its bounds, or with a bad field, is refused and nothing is written', async () => {
    const starter = await planId('starter');
    const base = { interval: 'MONTH', unitAmountMinor: 1900, perSeat: false };
    const bad: Array<Record<string, unknown>> = [
      { ...base, interval: 'WEEK' },
      { ...base, unitAmountMinor: -1 },
      { ...base, unitAmountMinor: 100_000_001 },
      { ...base, unitAmountMinor: 19.5 },
      { ...base, unitAmountMinor: '1900' },
      { ...base, currency: 'USD' },
      { ...base, trialDays: -1 },
      { ...base, trialDays: 91 },
      { ...base, trialDays: 1.5 },
      { ...base, includedUsage: { 'api.calls': -1 } },
      { ...base, includedUsage: { 'api.calls': 1.5 } },
      { ...base, overagePer1000Minor: { 'api.calls': -5 } },
      { ...base, surprise: true },
    ];
    const before = await priceCount();
    for (const body of bad) {
      const res = await postPrice(starter, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    }
    expect(await priceCount()).toBe(before);

    const missing = await postPrice(
      '00000000-0000-4000-8000-000000000000',
      base,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('plan_not_found');
    expect(
      (await postPrice(starter, { ...base, unitAmountMinor: 0 })).status,
    ).toBe(201);
    expect(
      (
        await postPrice(starter, {
          ...base,
          unitAmountMinor: 100_000_000,
          trialDays: 90,
        })
      ).status,
    ).toBe(201);
  });

  it('S17 AS-07: retiring a price hides it; retiring it again is 409 and changes nothing', async () => {
    const price = await publishPrice(t, admin, 'pro', {
      interval: 'MONTH',
      unitAmountMinor: 14900,
      perSeat: true,
    });
    const res = await t
      .as(admin)
      .post(`/api/admin/billing/prices/${price.id}/retire`);
    expect(res.status).toBe(200);
    expect(retirePriceResultSchema.parse(res.body)).toEqual({
      id: price.id,
      active: false,
    });
    const catalog = planCatalogSchema.parse(
      (await t.http().get('/api/plans')).body,
    );
    expect(JSON.stringify(catalog)).not.toContain(price.id);

    const again = await t
      .as(admin)
      .post(`/api/admin/billing/prices/${price.id}/retire`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('price_already_retired');
    const unknown = await t
      .as(admin)
      .post(
        '/api/admin/billing/prices/00000000-0000-4000-8000-000000000000/retire',
      );
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('price_not_found');
  });

  it('S17 AS-08: only an admin writes the catalog', async () => {
    const owner = (await t.shopWithOwner()).owner;
    const buyer = await t.newUser();
    const starter = await planId('starter');
    const price = await t.priceId('starter');
    const writes: Array<
      (who: TestUser | null) => Promise<{ status: number; body: any }>
    > = [
      (who) => postPlan({ code: 'vip', name: 'VIP', audience: 'BUYER' }, who),
      (who) =>
        postPrice(
          starter,
          { interval: 'MONTH', unitAmountMinor: 1, perSeat: false },
          who,
        ),
      (who) =>
        who
          ? t.as(who).post(`/api/admin/billing/prices/${price}/retire`)
          : t.http().post(`/api/admin/billing/prices/${price}/retire`),
    ];
    const plans = await planCount();
    const prices = await priceCount();
    for (const write of writes) {
      expect((await write(null)).status).toBe(401);
      for (const who of [owner, buyer]) {
        const res = await write(who);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('permission_denied');
      }
    }
    expect(await planCount()).toBe(plans);
    expect(await priceCount()).toBe(prices);
    const [active] = await t.sql<{ active: boolean }>(
      `SELECT active FROM "Price" WHERE id = :id`,
      { id: price },
    );
    expect(active.active).toBe(true);

    expect((await writes[0](admin)).status).toBe(201);
    expect((await writes[1](admin)).status).toBe(201);
    expect((await writes[2](admin)).status).toBe(200);
  });
});
