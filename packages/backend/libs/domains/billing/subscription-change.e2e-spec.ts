import {
  changePreviewSchema,
  changeResultSchema,
} from '@marketplace-sandbox/contracts';
import type { TestUser } from '@app/test/utils/catalog-app';
import { EntitlementsService } from './application/entitlements.service';
import { ChangeService } from './application/change.service';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import {
  F1000_BODY,
  T14_BODY,
  createFs,
  expectStatus,
  key,
  publishPrice,
  subscribeShop,
  type Fixture,
} from './testing/billing-flows';

const MID = '2026-04-16T00:00:00.000Z';

describe('Billing: plan changes and proration', () => {
  let t: BillingTestApp;

  beforeAll(async () => {
    t = await createBillingApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date('2026-04-01T00:00:00.000Z'));
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
      kind: string;
    }>(
      `SELECT id, "businessKey", total, status, kind FROM "Invoice" WHERE "subscriptionId" = :id ORDER BY "createdAt", id`,
      { id },
    );
  const lines = (invoiceId: string) =>
    rows<{ kind: string; amount: string; description: string }>(
      `SELECT kind, amount, description FROM "InvoiceLine" WHERE "invoiceId" = :invoiceId ORDER BY id`,
      { invoiceId },
    );
  const change = (
    who: TestUser,
    shopId: string,
    body: unknown,
    idempotencyKey: string | null = key(),
  ) => {
    let req = t.as(who).post(`/api/shops/${shopId}/subscription/change`);
    if (idempotencyKey !== null)
      req = req.set('Idempotency-Key', idempotencyKey);
    return req.send(body as object);
  };
  const preview = (who: TestUser, shopId: string, body: unknown) =>
    t
      .as(who)
      .post(`/api/shops/${shopId}/subscription/preview`)
      .send(body as object);
  const fsAt = async (
    options: Parameters<typeof createFs>[1] = {},
  ): Promise<Fixture> => {
    const fs = await createFs(t, options);
    await t.at(MID, fs.owner);
    return fs;
  };

  it('S17 AS-59: a preview shows the lines and what is due now, and writes nothing', async () => {
    const fs = await fsAt();
    const invoicesBefore = await count('Invoice');
    const jobsBefore = await count('Job');
    const eventsBefore = await count('Outbox');
    const res = await preview(fs.owner, fs.shopId, {
      priceId: await t.priceId('pro'),
    });
    expectStatus(res, 200);
    expect(changePreviewSchema.parse(res.body)).toEqual({
      lines: [
        {
          kind: 'PRORATION_CREDIT',
          description: 'Unused time on previous plan (15/30 days)',
          amountMinor: -950,
        },
        {
          kind: 'PRORATION_CHARGE',
          description: 'Remaining time on new plan (15/30 days)',
          amountMinor: 4950,
        },
      ],
      dueNowMinor: 4000,
      creditAppliedMinor: 0,
      effectiveAt: MID,
    });
    expect(await count('Invoice')).toBe(invoicesBefore);
    expect(await count('Job')).toBe(jobsBefore);
    expect(await count('Outbox')).toBe(eventsBefore);
    expect((await sub(fs.subscriptionId)).version).toBe(0);
  });

  it('S17 AS-60: the upgrade invoices exactly what the preview showed and forgets entitlements only after commit', async () => {
    const fs = await fsAt();
    const pro = await t.priceId('pro');
    const shown = changePreviewSchema.parse(
      (await preview(fs.owner, fs.shopId, { priceId: pro })).body,
    );

    const entitlements = t.app.get(EntitlementsService);
    const original = entitlements.invalidate.bind(entitlements);
    const seenVersions: number[] = [];
    const spy = jest
      .spyOn(entitlements, 'invalidate')
      .mockImplementation(async (...args) => {
        // from another connection: only committed state is visible
        seenVersions.push(
          (
            await rows<{ version: number }>(
              `SELECT version FROM "Subscription" WHERE id = :id`,
              { id: fs.subscriptionId },
            )
          )[0].version,
        );
        return original(...args);
      });
    let res;
    try {
      res = await change(fs.owner, fs.shopId, { priceId: pro });
    } finally {
      spy.mockRestore();
    }
    expectStatus(res, 200);
    const body = changeResultSchema.parse(res.body);
    expect(body.lines.map((l) => [l.kind, l.amountMinor])).toEqual(
      shown.lines.map((l) => [l.kind, l.amountMinor]),
    );
    expect(body.subscription).toMatchObject({
      plan: { code: 'pro' },
      version: 1,
    });
    expect(seenVersions).toEqual([1]);

    const list = await invoices(fs.subscriptionId);
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({
      businessKey: 'proration:v1',
      total: '4000',
      status: 'OPEN',
      kind: 'PRORATION',
    });
    expect((await lines(list[1].id)).map((l) => [l.kind, l.amount])).toEqual([
      ['PRORATION_CREDIT', '-950'],
      ['PRORATION_CHARGE', '4950'],
    ]);
    expect(
      await count(
        'Job',
        `type = 'billing.charge-invoice' AND payload->>'invoiceId' = '${list[1].id}'`,
      ),
    ).toBe(1);
    expect(
      (
        await rows(`SELECT "priceId" FROM "Subscription" WHERE id = :id`, {
          id: fs.subscriptionId,
        })
      )[0].priceId,
    ).toBe(pro);
    expect(
      (await t.outbox('billing.subscription_plan_changed')).map((e) => [
        e.payload.plan,
        e.payload.version,
      ]),
    ).toEqual([
      ['STARTER', 1],
      ['PRO', 2],
    ]);
    const read = await t
      .as(fs.owner)
      .get(`/api/shops/${fs.shopId}/subscription`);
    expect(read.body.entitlements.auctions).toBe(true);
  });

  it('S17 AS-61: a downgrade becomes credit that later renewals use up, never negative and never lost', async () => {
    const fs = await fsAt({ plan: 'pro' });
    const starter = await t.priceId('starter');
    expectStatus(await change(fs.owner, fs.shopId, { priceId: starter }), 200);
    const list = await invoices(fs.subscriptionId);
    expect(list[1]).toMatchObject({
      businessKey: 'proration:v1',
      total: '-4000',
      status: 'PAID',
    });
    expect((await lines(list[1].id)).map((l) => l.amount)).toEqual([
      '-4950',
      '950',
    ]);
    expect(String((await sub(fs.subscriptionId)).creditBalanceMinor)).toBe(
      '4000',
    );
    expect(
      await count(
        'Job',
        `type = 'billing.charge-invoice' AND payload->>'invoiceId' = '${list[1].id}'`,
      ),
    ).toBe(0);

    const balances: string[] = [];
    for (const month of ['2026-05-01', '2026-06-01', '2026-07-01']) {
      await t.at(`${month}T00:00:00.000Z`);
      await t.renewals.run();
      balances.push(String((await sub(fs.subscriptionId)).creditBalanceMinor));
    }
    expect(balances).toEqual(['2100', '200', '0']);
    const all = await invoices(fs.subscriptionId);
    const renewals = all.filter((i) => i.kind === 'RENEWAL').slice(1);
    expect(renewals.map((i) => [i.total, i.status])).toEqual([
      ['0', 'PAID'],
      ['0', 'PAID'],
      ['1700', 'OPEN'],
    ]);
    expect(
      (await lines(renewals[0].id)).map((l) => [l.kind, l.amount]),
    ).toEqual([
      ['PLAN', '1900'],
      ['CREDIT', '-1900'],
    ]);
    expect(
      (await lines(renewals[2].id)).map((l) => [l.kind, l.amount]),
    ).toEqual([
      ['PLAN', '1900'],
      ['CREDIT', '-200'],
    ]);
    // every invoice can be recomputed from its lines (the total is the sum of what was issued)
    for (const invoice of all) {
      const sum = (await lines(invoice.id)).reduce(
        (a, l) => a + Number(l.amount),
        0,
      );
      expect(String(sum)).toBe(invoice.total);
    }
    expect(await count('Subscription', `"creditBalanceMinor" < 0`)).toBe(0);
    // only the charged renewal got a charge request
    expect(
      await count(
        'Job',
        `type = 'billing.charge-invoice' AND payload->>'invoiceId' IN ('${renewals[0].id}','${renewals[1].id}')`,
      ),
    ).toBe(0);
    expect(
      await count(
        'Job',
        `type = 'billing.charge-invoice' AND payload->>'invoiceId' = '${renewals[2].id}'`,
      ),
    ).toBe(1);
  });

  it('S17 AS-62: adding seats prorates old and new quantity on the same days', async () => {
    const fs = await fsAt({ plan: 'pro', quantity: 3 });
    const res = await change(fs.owner, fs.shopId, { quantity: 5 });
    expectStatus(res, 200);
    expect(
      changeResultSchema.parse(res.body).lines.map((l) => l.amountMinor),
    ).toEqual([-14850, 24750]);
    const list = await invoices(fs.subscriptionId);
    expect(list[1].total).toBe('9900');
    expect((await sub(fs.subscriptionId)).quantity).toBe(5);
    const [history] = await rows<{ reason: string }>(
      `SELECT reason FROM "SubscriptionTransition" WHERE "subscriptionId" = :id AND version = 1`,
      { id: fs.subscriptionId },
    );
    expect(history.reason).toBe('quantity_changed');
  });

  it('S17 AS-65: a change while trialing swaps the price with no invoice', async () => {
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
    const [row0] = await rows<{
      id: string;
      currentPeriodEnd: Date;
      trialEndsAt: Date;
    }>(`SELECT id, "currentPeriodEnd", "trialEndsAt" FROM "Subscription"`);
    const pro = await t.priceId('pro');
    const res = await change(made.owner, made.shopId, { priceId: pro });
    expectStatus(res, 200);
    const body = changeResultSchema.parse(res.body);
    expect(body.lines).toEqual([]);
    expect(body.subscription).toMatchObject({
      plan: { code: 'pro' },
      status: 'TRIALING',
      version: 1,
    });
    const row = await sub(row0.id);
    expect(row.priceId).toBe(pro);
    expect(new Date(row.currentPeriodEnd).toISOString()).toBe(
      new Date(row0.currentPeriodEnd).toISOString(),
    );
    expect(new Date(row.trialEndsAt).toISOString()).toBe(
      new Date(row0.trialEndsAt).toISOString(),
    );
    expect(await count('Invoice')).toBe(0);
    const history = await rows<{ reason: string; version: number }>(
      `SELECT reason, version FROM "SubscriptionTransition" WHERE "subscriptionId" = :id ORDER BY version`,
      { id: row0.id },
    );
    expect(history.map((h) => [h.version, h.reason])).toEqual([
      [0, 'subscribed'],
      [1, 'plan_changed'],
    ]);
    expect(
      (await t.outbox('billing.subscription_plan_changed')).map((e) => [
        e.payload.plan,
        e.payload.version,
      ]),
    ).toEqual([
      ['STARTER', 1],
      ['PRO', 2],
    ]);
  });

  it('S17 AS-66: changes that are refused say why and change nothing', async () => {
    const fs = await fsAt();
    const admin = await t.admin(); // after the clock moved
    const yearly = await publishPrice(t, admin, 'starter', {
      interval: 'YEAR',
      unitAmountMinor: 19000,
      perSeat: true,
    });
    const flat = await publishPrice(t, admin, 'starter', F1000_BODY);
    const retired = await publishPrice(t, admin, 'starter', {
      interval: 'MONTH',
      unitAmountMinor: 700,
      perSeat: true,
    });
    await t.as(admin).post(`/api/admin/billing/prices/${retired.id}/retire`);
    const cases: Array<[unknown, number, string]> = [
      [{ priceId: yearly.id }, 422, 'billing_interval_change_not_supported'],
      [
        { priceId: await t.priceId('plus') },
        422,
        'plan_not_available_for_subject',
      ],
      [
        { priceId: await t.priceId('starter'), quantity: 1 },
        422,
        'no_change_requested',
      ],
      [{}, 422, 'no_change_requested'],
      [{ priceId: retired.id }, 404, 'price_not_found'],
      [
        { priceId: '00000000-0000-4000-8000-000000000000' },
        404,
        'price_not_found',
      ],
      [{ priceId: flat.id, quantity: 2 }, 422, 'quantity_not_applicable'],
    ];
    for (const [body, status, code] of cases) {
      const res = await change(fs.owner, fs.shopId, body);
      expect([res.status, res.body.code]).toEqual([status, code]);
    }
    expect((await sub(fs.subscriptionId)).version).toBe(0);
    expect(await invoices(fs.subscriptionId)).toHaveLength(1);

    // a subscription in dunning cannot be changed
    t.clock.set(new Date('2026-04-01T00:00:00.000Z'));
    const past = await createFs(t, { paymentMethodRef: 'pm_declined' });
    const res = await change(past.owner, past.shopId, {
      priceId: await t.priceId('pro'),
    });
    expect([res.status, res.body.code]).toEqual([
      409,
      'subscription_not_changeable',
    ]);
  });

  it('S17 AS-67: two changes at once: exactly one wins, the other is 409, one proration invoice (50 rounds)', async () => {
    const pro = await t.priceId('pro');
    for (let round = 0; round < 50; round++) {
      t.clock.set(new Date('2026-04-01T00:00:00.000Z'));
      const fs = await createFs(t);
      await t.at(MID, fs.owner);
      const [a, b] = await Promise.all([
        change(fs.owner, fs.shopId, { priceId: pro }),
        change(fs.owner, fs.shopId, { quantity: 5 }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      const winner = a.status === 200 ? a : b;
      expect(loser.body.code).toBe('subscription_changed_concurrently');
      expect((await sub(fs.subscriptionId)).version).toBe(1);
      const list = await invoices(fs.subscriptionId);
      expect(list.filter((i) => i.kind === 'PRORATION')).toHaveLength(1);
      expect((await lines(list[1].id)).map((l) => Number(l.amount))).toEqual(
        changeResultSchema.parse(winner.body).lines.map((l) => l.amountMinor),
      );
    }
  }, 240_000);

  it('S17 AS-68: a change and the renewal at the boundary leave one renewal invoice that matches the final history (50 rounds)', async () => {
    const pro = await t.priceId('pro');
    const starter = await t.priceId('starter');
    const all: Fixture[] = [];
    for (let i = 0; i < 50; i++) all.push(await createFs(t));
    await t.at('2026-05-01T00:00:00.000Z', ...all.map((f) => f.owner));
    const [, ...changes] = await Promise.all([
      t.renewals.run(),
      ...all.map((fs) => change(fs.owner, fs.shopId, { priceId: pro })),
    ]);
    // whoever lost the race gets 409; a later run finishes anything left over
    await t.renewals.run();
    for (const [index, fs] of all.entries()) {
      const response = changes[index];
      expect([200, 409]).toContain(response.status);
      if (response.status === 409)
        expect(response.body.code).toBe('subscription_changed_concurrently');
      const list = await invoices(fs.subscriptionId);
      const renewals = list.filter(
        (i) => i.businessKey === 'renewal:2026-05-01T00:00:00.000Z',
      );
      expect(renewals).toHaveLength(1);
      // the renewal charges the price the subscription had when it advanced: read it back from the history
      const history = await rows<{ reason: string; version: number }>(
        `SELECT reason, version FROM "SubscriptionTransition" WHERE "subscriptionId" = :id ORDER BY version`,
        { id: fs.subscriptionId },
      );
      const renewedAt = history.findIndex((h) => h.reason === 'renewed');
      const changedBefore = history
        .slice(0, renewedAt)
        .some((h) => h.reason === 'plan_changed');
      expect(renewals[0].total).toBe(changedBefore ? '9900' : '1900');
      expect(history.map((h) => h.version)).toEqual(history.map((_, n) => n));
      const finalPrice = (await sub(fs.subscriptionId)).priceId;
      expect(finalPrice).toBe(response.status === 200 ? pro : starter);
      // no proration against an old period alongside a renewal
      for (const p of list.filter((i) => i.kind === 'PRORATION')) {
        const sum = (await lines(p.id)).reduce(
          (a, l) => a + Number(l.amount),
          0,
        );
        expect(String(sum)).toBe(p.total);
      }
    }
  }, 300_000);

  describe('S17 AS-69: preview and change: validation, credentials, tenancy, idempotency, limits', () => {
    it('S17 AS-69: bad bodies are 400 on both routes', async () => {
      const fs = await fsAt();
      const bad = [
        { priceId: 'nope' },
        { quantity: 0 },
        { quantity: 1001 },
        { quantity: 1.5 },
        { surprise: 1 },
      ];
      for (const body of bad) {
        for (const res of [
          await preview(fs.owner, fs.shopId, body),
          await change(fs.owner, fs.shopId, body),
        ]) {
          expect(res.status).toBe(400);
          expect(res.body.code).toBe('validation_failed');
        }
      }
      expect((await sub(fs.subscriptionId)).version).toBe(0);
    });

    it('S17 AS-69: no credentials is 401, another shop 404, a viewer 403; a closed shop is refused with its own code', async () => {
      const fs = await fsAt();
      const viewer = await t.member(fs.shopId, 'VIEWER');
      const other = await t.shopWithOwner();
      const body = { priceId: await t.priceId('pro') };
      expect(
        (
          await t
            .http()
            .post(`/api/shops/${fs.shopId}/subscription/preview`)
            .send(body)
        ).status,
      ).toBe(401);
      expect(
        (
          await t
            .http()
            .post(`/api/shops/${fs.shopId}/subscription/change`)
            .set('Idempotency-Key', key())
            .send(body)
        ).status,
      ).toBe(401);
      expect((await preview(fs.owner, other.shopId, body)).status).toBe(404);
      expect((await change(fs.owner, other.shopId, body)).status).toBe(404);
      for (const res of [
        await preview(viewer, fs.shopId, body),
        await change(viewer, fs.shopId, body),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('permission_denied');
      }
      expect((await sub(fs.subscriptionId)).version).toBe(0);

      // S03 follow-up: write permissions on a closed shop
      await t.sequelize.query(
        `UPDATE "Shop" SET status = 'SUSPENDED' WHERE id = :id`,
        { replacements: { id: fs.shopId } },
      );
      const suspended = await change(fs.owner, fs.shopId, body);
      expect([suspended.status, suspended.body.code]).toEqual([
        403,
        'shop_suspended',
      ]);
      await t.sequelize.query(
        `UPDATE "Shop" SET status = 'DELETING' WHERE id = :id`,
        { replacements: { id: fs.shopId } },
      );
      const closing = await change(fs.owner, fs.shopId, body);
      expect([closing.status, closing.body.code]).toEqual([
        409,
        'shop_offboarding',
      ]);
      expect((await sub(fs.subscriptionId)).version).toBe(0);
    });

    it('S17 AS-69: a replayed change returns the stored answer and one invoice; a different body, a missing key and a running twin are refused', async () => {
      const fs = await fsAt();
      const body = { priceId: await t.priceId('pro') };
      const first = await change(fs.owner, fs.shopId, body, 'key-change-0001');
      expectStatus(first, 200);
      const replay = await change(fs.owner, fs.shopId, body, 'key-change-0001');
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(await invoices(fs.subscriptionId)).toHaveLength(2);
      const different = await change(
        fs.owner,
        fs.shopId,
        { quantity: 4 },
        'key-change-0001',
      );
      expect([different.status, different.body.code]).toEqual([
        422,
        'idempotency_key_reuse',
      ]);
      const missing = await change(fs.owner, fs.shopId, { quantity: 4 }, null);
      expect([missing.status, missing.body.code]).toEqual([
        422,
        'idempotency_key_required',
      ]);

      // a request that is still running: its twin is 409
      const service = t.app.get(ChangeService);
      const original = service.change.bind(service);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const spy = jest
        .spyOn(service, 'change')
        .mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return original(...args);
        });
      try {
        // supertest sends only when awaited: `.then` starts the request now
        const running = change(
          fs.owner,
          fs.shopId,
          { quantity: 4 },
          'key-change-0002',
        ).then((r) => r);
        await inside;
        const twin = await change(
          fs.owner,
          fs.shopId,
          { quantity: 4 },
          'key-change-0002',
        );
        expect([twin.status, twin.body.code]).toEqual([
          409,
          'idempotency_in_flight',
        ]);
        release();
        expect((await running).status).toBe(200);
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it('S17 AS-69: the 31st change request within an hour is 429', async () => {
      const fs = await fsAt();
      for (let i = 0; i < 30; i++) {
        const res = await change(fs.owner, fs.shopId, {});
        expect(res.status).toBe(422); // nothing to change; still an attempt
      }
      const refused = await change(fs.owner, fs.shopId, {
        priceId: await t.priceId('pro'),
      });
      expect(refused.status).toBe(429);
      expect(refused.headers['retry-after']).toBeDefined();
      expect((await sub(fs.subscriptionId)).version).toBe(0);
    });
  });
});
