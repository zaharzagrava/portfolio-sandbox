import { subscriptionSchema } from '@marketplace-sandbox/contracts';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import type { TestUser } from '@app/test/utils/catalog-app';
import { SubscribeService } from './application/subscribe.service';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import {
  F1000_BODY,
  T14_BODY,
  createFs,
  expectStatus,
  key,
  publishPrice,
  subscribeBuyer,
  subscribeShop,
} from './testing/billing-flows';

const NOW = '2026-04-10T12:00:00.000Z';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Billing: subscribing', () => {
  let t: BillingTestApp;
  let shopId: string;
  let ann: TestUser;
  let vic: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    t = await createBillingApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date(NOW));
    ({ shopId, owner: ann } = await t.shopWithOwner());
    vic = await t.member(shopId, 'VIEWER');
    admin = await t.admin();
  });

  const count = async (table: string, where = 'true') =>
    Number(
      (
        await t.sql<{ n: string }>(
          `SELECT count(*) AS n FROM "${table}" WHERE ${where}`,
        )
      )[0].n,
    );
  const chargeJobs = (invoiceId?: string) =>
    count(
      'Job',
      invoiceId
        ? `type = 'billing.charge-invoice' AND payload->>'invoiceId' = '${invoiceId}'`
        : `type = 'billing.charge-invoice'`,
    );
  const nothingCreated = async () => {
    expect(await count('Subscription')).toBe(0);
    expect(await count('Invoice')).toBe(0);
    expect(await chargeJobs()).toBe(0);
  };

  it('S17 AS-09: a shop subscribes: subscription, history, invoice, charge request and events in one go, no provider call', async () => {
    const pro = await t.priceId('pro');
    const res = await subscribeShop(
      t,
      ann,
      shopId,
      { priceId: pro, quantity: 3, paymentMethodRef: 'pm_ok' },
      'key-subscribe-0001',
    );
    expectStatus(res, 201);
    const body = subscriptionSchema.parse(res.body);
    expect(body).toMatchObject({
      status: 'ACTIVE',
      plan: { code: 'pro', name: 'Pro' },
      priceId: pro,
      interval: 'MONTH',
      unitAmountMinor: 9900,
      currency: 'EUR',
      perSeat: true,
      quantity: 3,
      currentPeriodStart: '2026-04-10T12:00:00.000Z',
      currentPeriodEnd: '2026-05-10T12:00:00.000Z',
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      hasPaymentMethod: true,
      creditBalanceMinor: 0,
      version: 0,
      latestInvoice: {
        kind: 'RENEWAL',
        status: 'OPEN',
        totalMinor: 29700,
        lines: [
          { kind: 'PLAN', description: 'Pro', quantity: 3, amountMinor: 29700 },
        ],
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('pm_ok');
    expect(JSON.stringify(res.body)).not.toContain('paymentMethodRef');

    const [sub] = await t.sql<Record<string, any>>(
      `SELECT * FROM "Subscription" WHERE id = :id`,
      { id: body.id },
    );
    expect(sub).toMatchObject({
      billingAnchorDay: 10,
      status: 'ACTIVE',
      subjectType: 'SHOP',
      subjectId: shopId,
    });
    const history = await t.sql<Record<string, any>>(
      `SELECT "fromStatus", "toStatus", reason, actor, version FROM "SubscriptionTransition" WHERE "subscriptionId" = :id`,
      { id: body.id },
    );
    expect(history).toEqual([
      {
        fromStatus: null,
        toStatus: 'ACTIVE',
        reason: 'subscribed',
        actor: `user:${ann.id}`,
        version: 0,
      },
    ]);
    const invoices = await t.sql<Record<string, any>>(
      `SELECT id, "businessKey", total, status FROM "Invoice" WHERE "subscriptionId" = :id`,
      { id: body.id },
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      businessKey: 'renewal:2026-04-10T12:00:00.000Z',
      total: '29700',
      status: 'OPEN',
    });
    expect(
      await count('InvoiceLine', `"invoiceId" = '${invoices[0].id}'`),
    ).toBe(1);
    expect(await chargeJobs(invoices[0].id)).toBe(1);

    const statusEvents = await t.outbox('billing.subscription_status_changed');
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].payload).toMatchObject({
      subscriptionId: body.id,
      subjectType: 'SHOP',
      subjectId: shopId,
      status: 'ACTIVE',
      from: null,
      planCode: 'pro',
      subscriptionVersion: 0,
    });
    const tier = await t.outbox('billing.subscription_plan_changed');
    // J02 G-13: the plan applies after the first charge settles, so subscribing announces the free tier only
    expect(tier.map((e) => e.payload)).toEqual([
      { shopId, plan: 'STARTER', version: 1 },
    ]);
    expect(tier[0].aggregateId).toBe(shopId);
    expect(t.provider.creates).toHaveLength(0);
  });

  it('S17 AS-10: a buyer subscribes; there is no tier event for buyers', async () => {
    const buyer = await t.newUser();
    const res = await subscribeBuyer(t, buyer, {
      priceId: await t.priceId('plus'),
      paymentMethodRef: 'pm_ok',
    });
    expect(res.status).toBe(201);
    const body = subscriptionSchema.parse(res.body);
    expect(body).toMatchObject({
      status: 'ACTIVE',
      plan: { code: 'plus' },
      perSeat: false,
      quantity: 1,
    });
    expect(body.latestInvoice?.totalMinor).toBe(499);
    expect(await t.outbox('billing.subscription_status_changed')).toHaveLength(
      1,
    );
    expect(await t.outbox('billing.subscription_plan_changed')).toHaveLength(0);
    const [sub] = await t.sql<Record<string, any>>(
      `SELECT "subjectType", "subjectId" FROM "Subscription"`,
    );
    expect(sub).toEqual({ subjectType: 'USER', subjectId: buyer.id });
  });

  it('S17 AS-11: a trial comes from the price: no invoice, no charge, anchor on the day the trial ends', async () => {
    const t14 = await publishPrice(t, admin, 'starter', T14_BODY);
    const res = await subscribeShop(t, ann, shopId, {
      priceId: t14.id,
      quantity: 2,
      paymentMethodRef: 'pm_ok',
    });
    expect(res.status).toBe(201);
    const body = subscriptionSchema.parse(res.body);
    expect(body).toMatchObject({
      status: 'TRIALING',
      trialEndsAt: '2026-04-24T12:00:00.000Z',
      currentPeriodEnd: '2026-04-24T12:00:00.000Z',
      latestInvoice: null,
    });
    const [sub] = await t.sql<Record<string, any>>(
      `SELECT "billingAnchorDay" FROM "Subscription"`,
    );
    expect(sub.billingAnchorDay).toBe(24);
    expect(await count('Invoice')).toBe(0);
    expect(await chargeJobs()).toBe(0);
    expect(
      (await t.outbox('billing.subscription_plan_changed')).map(
        (e) => e.payload,
      ),
    ).toEqual([{ shopId, plan: 'STARTER', version: 1 }]);

    const other = await t.shopWithOwner();
    const noRef = await subscribeShop(t, other.owner, other.shopId, {
      priceId: t14.id,
      quantity: 2,
    });
    expect(noRef.status).toBe(422);
    expect(noRef.body.code).toBe('payment_method_required');
    expect(await count('Subscription')).toBe(1);
  });

  it('S17 AS-12: a trial is taken once per subject; a plain subscription is still allowed', async () => {
    const t14 = await publishPrice(t, admin, 'starter', T14_BODY);
    await createFs(t, { owner: ann, shopId });
    await t.reauth(ann);
    const cancel = await t
      .as(ann)
      .post(`/api/shops/${shopId}/subscription/cancel`)
      .send({ immediately: true });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELED');

    const trial = await subscribeShop(t, ann, shopId, {
      priceId: t14.id,
      paymentMethodRef: 'pm_ok',
    });
    expect(trial.status).toBe(422);
    expect(trial.body.code).toBe('trial_not_available');
    expect(await count('Subscription', `status <> 'CANCELED'`)).toBe(0);

    const plain = await subscribeShop(t, ann, shopId, {
      priceId: await t.priceId('starter'),
      paymentMethodRef: 'pm_ok',
    });
    expect(plain.status).toBe(201);
  });

  it('S17 AS-13: the client cannot choose a trial length', async () => {
    const res = await subscribeShop(t, ann, shopId, {
      priceId: await t.priceId('starter'),
      paymentMethodRef: 'pm_ok',
      trialDays: 30,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
    expect(JSON.stringify(res.body)).toContain('trialDays');
    await nothingCreated();
  });

  it('S17 AS-14: money due needs a payment method; a price of zero needs none and is never charged', async () => {
    const res = await subscribeShop(t, ann, shopId, {
      priceId: await t.priceId('starter'),
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('payment_method_required');
    await nothingCreated();

    const free = await publishPrice(t, admin, 'starter', {
      interval: 'MONTH',
      unitAmountMinor: 0,
      perSeat: false,
    });
    const ok = await subscribeShop(t, ann, shopId, { priceId: free.id });
    expect(ok.status).toBe(201);
    const body = subscriptionSchema.parse(ok.body);
    expect(body.status).toBe('ACTIVE');
    expect(body.hasPaymentMethod).toBe(false);
    expect(body.latestInvoice).toMatchObject({ status: 'PAID', totalMinor: 0 });
    expect(await chargeJobs()).toBe(0);
  });

  it('S17 AS-15: eligibility: audience, sandbox shop, retired or unknown price; nothing is created', async () => {
    const wrongPlan = await subscribeShop(t, ann, shopId, {
      priceId: await t.priceId('plus'),
      paymentMethodRef: 'pm_ok',
    });
    expect(wrongPlan.status).toBe(422);
    expect(wrongPlan.body.code).toBe('plan_not_available_for_subject');
    const buyer = await t.newUser();
    const wrongBuyer = await subscribeBuyer(t, buyer, {
      priceId: await t.priceId('pro'),
      paymentMethodRef: 'pm_ok',
    });
    expect(wrongBuyer.status).toBe(422);
    expect(wrongBuyer.body.code).toBe('plan_not_available_for_subject');

    const sandbox = await t.shopWithOwner(undefined, { sandboxOf: shopId });
    const refused = await subscribeShop(t, sandbox.owner, sandbox.shopId, {
      priceId: await t.priceId('starter'),
      paymentMethodRef: 'pm_ok',
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('sandbox_shop_not_billable');

    const unknown = await subscribeShop(t, ann, shopId, {
      priceId: '00000000-0000-4000-8000-000000000000',
      paymentMethodRef: 'pm_ok',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('price_not_found');
    const retired = await publishPrice(t, admin, 'starter', {
      interval: 'MONTH',
      unitAmountMinor: 5,
      perSeat: false,
    });
    await t.as(admin).post(`/api/admin/billing/prices/${retired.id}/retire`);
    const gone = await subscribeShop(t, ann, shopId, {
      priceId: retired.id,
      paymentMethodRef: 'pm_ok',
    });
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('price_not_found');
    await nothingCreated();
  });

  it('S17 AS-16: of two concurrent subscribes exactly one wins (50 rounds); nothing is duplicated', async () => {
    const starter = await t.priceId('starter');
    const pro = await t.priceId('pro');
    for (let round = 0; round < 50; round++) {
      const shop = await t.shopWithOwner();
      const [a, b] = await Promise.all([
        subscribeShop(t, shop.owner, shop.shopId, {
          priceId: starter,
          paymentMethodRef: 'pm_ok',
        }),
        subscribeShop(t, shop.owner, shop.shopId, {
          priceId: pro,
          paymentMethodRef: 'pm_ok',
        }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.code).toBe('already_subscribed');
      expect(
        await count('Subscription', `"subjectId" = '${shop.shopId}'`),
      ).toBe(1);
      expect(
        await count(
          'Invoice',
          `"subscriptionId" IN (SELECT id FROM "Subscription" WHERE "subjectId" = '${shop.shopId}')`,
        ),
      ).toBe(1);
    }
    expect(await chargeJobs()).toBe(50);
  }, 240_000);

  it('S17 AS-16: an UNPAID subscription still blocks a new one (the customer pays or cancels first)', async () => {
    const fs = await createFs(t, {
      owner: ann,
      shopId,
      paymentMethodRef: 'pm_declined',
    });
    // four declines on the real schedule: day 0, 1, 3 and 7 after the first failure
    for (const iso of [
      '2026-04-02T00:00:00.000Z',
      '2026-04-04T00:00:00.000Z',
      '2026-04-08T00:00:00.000Z',
    ]) {
      await t.at(iso);
      await t.drainJobs();
    }
    const [row] = await t.sql<{ status: string }>(
      `SELECT status FROM "Subscription" WHERE id = :id`,
      { id: fs.subscriptionId },
    );
    expect(row.status).toBe('UNPAID');
    await t.reauth(ann);
    const res = await subscribeShop(t, ann, shopId, {
      priceId: await t.priceId('pro'),
      paymentMethodRef: 'pm_ok',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_subscribed');
  });

  it('S17 AS-17: a bad body is 400, a quantity other than 1 on a flat price is 422', async () => {
    const starter = await t.priceId('starter');
    const bad: Array<Record<string, unknown>> = [
      { priceId: 'not-a-uuid', paymentMethodRef: 'pm_ok' },
      { priceId: starter, quantity: 0, paymentMethodRef: 'pm_ok' },
      { priceId: starter, quantity: 1001, paymentMethodRef: 'pm_ok' },
      { priceId: starter, quantity: 1.5, paymentMethodRef: 'pm_ok' },
      { priceId: starter, quantity: '3', paymentMethodRef: 'pm_ok' },
      { priceId: starter, paymentMethodRef: '' },
      { priceId: starter, paymentMethodRef: `pm_${'a'.repeat(300)}` },
      { priceId: starter, paymentMethodRef: 'card_123' },
      { priceId: starter, paymentMethodRef: 'pm_ok', unknownField: true },
      {},
    ];
    for (const body of bad) {
      const res = await subscribeShop(t, ann, shopId, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    }
    // the ten attempts above used up this shop's hourly allowance (every attempt counts): another shop asks
    const flat = await publishPrice(t, admin, 'starter', F1000_BODY);
    const other = await t.shopWithOwner();
    const res = await subscribeShop(t, other.owner, other.shopId, {
      priceId: flat.id,
      quantity: 2,
      paymentMethodRef: 'pm_ok',
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('quantity_not_applicable');
    await nothingCreated();
  });

  it('S17 AS-18: credentials and tenancy: 401, foreign shop 404 identical to an unknown one, viewer 403, closed shops', async () => {
    const body = {
      priceId: await t.priceId('starter'),
      paymentMethodRef: 'pm_ok',
    };
    const anonymous = await t
      .http()
      .post(`/api/shops/${shopId}/subscription`)
      .set('Idempotency-Key', key())
      .send(body);
    expect(anonymous.status).toBe(401);
    const anonymousBuyer = await t
      .http()
      .post('/api/me/subscription')
      .set('Idempotency-Key', key())
      .send(body);
    expect(anonymousBuyer.status).toBe(401);

    const bo = await t.shopWithOwner();
    const foreign = await subscribeShop(t, ann, bo.shopId, body);
    const unknown = await subscribeShop(
      t,
      ann,
      '00000000-0000-4000-8000-000000000001',
      body,
    );
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    const strip = (r: { body: any }) => ({
      ...r.body,
      instance: undefined,
      requestId: undefined,
      detail: undefined,
    });
    expect(strip(foreign)).toEqual(strip(unknown));

    const viewer = await subscribeShop(t, vic, shopId, body);
    expect(viewer.status).toBe(403);
    expect(viewer.body.code).toBe('permission_denied');

    // S03 follow-up: write permissions on a closed shop
    const suspended = await t.shopWithOwner(undefined, { status: 'SUSPENDED' });
    const s = await subscribeShop(t, suspended.owner, suspended.shopId, body);
    expect(s.status).toBe(403);
    expect(s.body.code).toBe('shop_suspended');
    const closing = await t.shopWithOwner(undefined, { status: 'DELETING' });
    const c = await subscribeShop(t, closing.owner, closing.shopId, body);
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('shop_offboarding');
    await nothingCreated();
  });

  describe('S17 AS-19: idempotency', () => {
    const body = () => ({
      priceId: undefined as unknown as string,
      paymentMethodRef: 'pm_ok',
    });

    it('S17 AS-19: the same key and body replay the stored answer; a different body is 422; a missing key is 422', async () => {
      const payload = {
        priceId: await t.priceId('pro'),
        quantity: 3,
        paymentMethodRef: 'pm_ok',
      };
      const first = await subscribeShop(
        t,
        ann,
        shopId,
        payload,
        'key-replay-0001',
      );
      expect(first.status).toBe(201);
      const replay = await subscribeShop(
        t,
        ann,
        shopId,
        payload,
        'key-replay-0001',
      );
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(await count('Subscription')).toBe(1);
      expect(await count('Invoice')).toBe(1);

      const different = await subscribeShop(
        t,
        ann,
        shopId,
        { ...payload, quantity: 4 },
        'key-replay-0001',
      );
      expect(different.status).toBe(422);
      expect(different.body.code).toBe('idempotency_key_reuse');

      const missing = await subscribeShop(t, ann, shopId, payload, null);
      expect(missing.status).toBe(422);
      expect(missing.body.code).toBe('idempotency_key_required');
      expect(await count('Subscription')).toBe(1);
      void body;
    });

    it('S17 AS-19: while the first request is still running the same key answers 409 idempotency_in_flight', async () => {
      const payload = {
        priceId: await t.priceId('pro'),
        quantity: 1,
        paymentMethodRef: 'pm_ok',
      };
      const service = t.app.get(SubscribeService);
      const original = service.subscribe.bind(service);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const spy = jest
        .spyOn(service, 'subscribe')
        .mockImplementationOnce(async (...args) => {
          entered();
          await gate;
          return original(...args);
        });
      try {
        const first = subscribeShop(
          t,
          ann,
          shopId,
          payload,
          'key-flight-0001',
        ).then((r) => r);
        await inside;
        const second = await subscribeShop(
          t,
          ann,
          shopId,
          payload,
          'key-flight-0001',
        );
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('idempotency_in_flight');
        release();
        expect((await first).status).toBe(201);
        expect(await count('Subscription')).toBe(1);
      } finally {
        release();
        spy.mockRestore();
      }
    });
  });

  it('S17 AS-20: the eleventh attempt in an hour is 429 with Retry-After and creates nothing', async () => {
    const attempt = () =>
      subscribeShop(t, ann, shopId, {
        priceId: '00000000-0000-4000-8000-000000000000',
        paymentMethodRef: 'pm_ok',
      });
    for (const res of await Promise.all(
      Array.from({ length: 10 }, () => attempt()),
    ))
      expect(res.status).toBe(404); // ten at once (was one by one)
    const refused = await attempt();
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
    // the limit is per shop: another shop is not affected, and a valid subscribe of this one is refused too
    const valid = await subscribeShop(t, ann, shopId, {
      priceId: await t.priceId('starter'),
      paymentMethodRef: 'pm_ok',
    });
    expect(valid.status).toBe(429);
    await nothingCreated();
    const other = await t.shopWithOwner();
    expect(
      (
        await subscribeShop(t, other.owner, other.shopId, {
          priceId: await t.priceId('starter'),
          paymentMethodRef: 'pm_ok',
        })
      ).status,
    ).toBe(201);
  });

  // Last in the file: it boots a second app, with the limiter store behind a proxy.
  it('S17 AS-20: with the limiter store down the subscribe is refused (fail closed, 503) and nothing is created', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    const proxy = await TcpFaultProxy.start({
      host: redis.hostname,
      port: Number(redis.port || 6379),
    });
    const own = await createBillingApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/${new URL(process.env.REDIS_URL ?? "redis://localhost:6400/0").pathname.slice(1) || "0"}`,
    });
    try {
      await own.reset();
      const { shopId: id, owner } = await own.shopWithOwner();
      const priceId = await own.priceId('starter');
      proxy.mode = 'refuse';
      proxy.sever();
      await sleep(300);
      const res = await subscribeShop(own, owner, id, {
        priceId,
        paymentMethodRef: 'pm_ok',
      });
      expect(res.status).toBe(503);
      expect(
        Number(
          (
            await own.sql<{ n: string }>(
              `SELECT count(*) AS n FROM "Subscription"`,
            )
          )[0].n,
        ),
      ).toBe(0);
    } finally {
      proxy.mode = 'pass';
      await own.close();
      await proxy.close();
    }
  }, 120_000);
});
