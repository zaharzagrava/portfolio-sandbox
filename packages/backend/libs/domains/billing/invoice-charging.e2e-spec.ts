import { Logger } from '@nestjs/common';
import {
  invoicePaidSchema,
  invoicePaymentFailedSchema,
  subscriptionSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type { TestUser } from '@app/test/utils/catalog-app';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import { ENTITLEMENT_CACHE, type EntitlementCachePort } from './domain/ports';
import {
  createFs,
  expectStatus,
  key,
  publishPrice,
  subscribeShop,
  type Fixture,
} from './testing/billing-flows';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;
const T0 = '2026-04-10T12:00:10.000Z';
const at = (iso: string, plusMs = 0) =>
  new Date(new Date(iso).getTime() + plusMs).toISOString();

describe('Billing: charging, unknown outcomes and dunning', () => {
  let t: BillingTestApp;

  beforeAll(async () => {
    t = await createBillingApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date(T0));
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
  const invoiceOf = async (fs: Fixture, index = 0) =>
    (
      await rows<Record<string, any>>(
        `SELECT * FROM "Invoice" WHERE "subscriptionId" = :id ORDER BY "createdAt", id`,
        { id: fs.subscriptionId },
      )
    )[index];
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  const declineOnce = (code = 'card_declined') =>
    t.provider.script({ kind: 'card_error', code });
  const events = async (type: string) =>
    (await t.outbox(type)).map((e) => e.payload);
  /** A shop (pro, 3 seats: 29700) whose first charge has not run yet. */
  const open = (
    options: {
      paymentMethodRef?: string;
      plan?: 'starter' | 'pro';
      quantity?: number;
    } = {},
  ) =>
    createFs(t, {
      plan: options.plan ?? 'pro',
      quantity: options.quantity ?? 3,
      paymentMethodRef: options.paymentMethodRef,
      at: T0,
      charge: false,
    });
  const put = (who: TestUser, shopId: string, body: unknown) =>
    t
      .as(who)
      .put(`/api/shops/${shopId}/subscription/payment-method`)
      .send(body as object);

  it('S17 AS-40: a successful charge is made once, with the invoice currency, our reference and no open transaction', async () => {
    const fs = await open();
    const invoice = await invoiceOf(fs);
    await t.drainJobs();

    expect(t.provider.creates).toHaveLength(1);
    const call = t.provider.creates[0];
    expect(call).toMatchObject({
      amount: 29700,
      currency: 'EUR',
      idempotencyKey: `${invoice.id}:1`,
      timeoutMs: 8000,
      insideTransaction: false,
      metadata: {
        kind: 'subscription_invoice',
        invoiceId: invoice.id,
        subscriptionId: fs.subscriptionId,
        attempt: '1',
      },
    });
    expect(call.metadata).not.toHaveProperty('idempotencyKey');
    const after = await invoiceOf(fs);
    expect(after).toMatchObject({
      status: 'PAID',
      attempts: 1,
      attemptStartedAt: null,
      attemptUnknown: false,
    });
    expect(after.paidAt).not.toBeNull();
    expect(
      await count('InvoiceTransition', `"invoiceId" = '${invoice.id}'`),
    ).toBe(1);
    const paid = await events('billing.invoice_paid');
    expect(paid).toHaveLength(1);
    expect(invoicePaidSchema.parse(paid[0])).toMatchObject({
      invoiceId: invoice.id,
      subscriptionId: fs.subscriptionId,
      subjectType: 'SHOP',
      subjectId: fs.shopId,
      kind: 'RENEWAL',
      totalMinor: 29700,
      currency: 'EUR',
    });
    expect((await sub(fs.subscriptionId)).status).toBe('ACTIVE');
    expect(
      metric('billing_charge_attempts_total', { outcome: 'succeeded' }),
    ).toBeGreaterThan(0);
  });

  it('S17 G-13: until the first invoice is paid the shop is on the free tier; the payment announces the paid plan by event, the free entry dropped by the consumer', async () => {
    const fs = await open();
    const read = () =>
      t.as(fs.owner).get(`/api/shops/${fs.shopId}/subscription`);
    expect((await read()).body.entitlements.auctions).toBe(false);
    await t.drainJobs(); // the charge settles
    const statusEvents = await events('billing.subscription_status_changed');
    expect(
      statusEvents.slice(-1).map((p) => [p.from, p.status, p.planCode]),
    ).toEqual([['ACTIVE', 'ACTIVE', 'pro']]);
    expect(
      (await events('billing.subscription_plan_changed')).map((p) => [
        p.plan,
        p.version,
      ]),
    ).toEqual([
      ['STARTER', 1],
      ['PRO', 2],
    ]);
    // the cache: only the event drops the cached free tier, never a direct call, so until the consumer runs it still shows
    expect((await read()).body.entitlements.auctions).toBe(false);
    const status = statusEvents.slice(-1)[0] as {
      subjectType: 'SHOP';
      subjectId: string;
      subscriptionId: string;
      subscriptionVersion: number;
    };
    expect(
      await t.app
        .get<EntitlementCachePort>(ENTITLEMENT_CACHE)
        .invalidateIfOlder(
          status.subjectType,
          status.subjectId,
          status.subscriptionId,
          status.subscriptionVersion,
        ),
    ).toBe('applied'); // what the entitlements-invalidation consumer does with that event
    expect((await read()).body.entitlements.auctions).toBe(true);
  });

  it('S17 AS-41: a decline starts dunning: PAST_DUE, the next attempt a day after the first failure, events carry the reason', async () => {
    const fs = await open({ paymentMethodRef: 'pm_declined' });
    const invoice = await invoiceOf(fs);
    await t.drainJobs();

    const row = await invoiceOf(fs);
    expect(row).toMatchObject({
      status: 'OPEN',
      attempts: 1,
      attemptStartedAt: null,
    });
    expect(iso(row.firstFailedAt)).toBe(T0);
    expect(iso(row.nextAttemptAt)).toBe('2026-04-11T12:00:10.000Z');
    const subscription = await sub(fs.subscriptionId);
    expect(subscription.status).toBe('PAST_DUE');
    const [moved] = await rows<{ actor: string; reason: string }>(
      `SELECT actor, reason FROM "SubscriptionTransition" WHERE "subscriptionId" = :id AND version = 1`,
      { id: fs.subscriptionId },
    );
    expect(moved).toEqual({
      actor: 'system:dunning',
      reason: 'payment_failed',
    });
    const failed = await events('billing.invoice_payment_failed');
    expect(failed.map((p) => invoicePaymentFailedSchema.parse(p))).toEqual([
      {
        invoiceId: invoice.id,
        subscriptionId: fs.subscriptionId,
        subjectType: 'SHOP',
        subjectId: fs.shopId,
        attempt: 1,
        nextAttemptAt: '2026-04-11T12:00:10.000Z',
        reason: 'card_declined',
        totalMinor: 29700,
        currency: 'EUR',
      },
    ]);
    const status = await events('billing.subscription_status_changed');
    expect(status[status.length - 1]).toMatchObject({
      status: 'PAST_DUE',
      from: 'ACTIVE',
    });
    const [next] = await rows<{ runAt: Date }>(
      `SELECT j."runAt" FROM "Job" j JOIN "JobKey" k ON k."jobId" = j.id WHERE k."idempotencyKey" = :key`,
      { key: `invoice-charge:${invoice.id}:2` },
    );
    expect(iso(next.runAt)).toBe('2026-04-11T12:00:10.000Z');
    // J02 G-13: nothing has been paid yet, so there is no paid plan to keep during the grace: the free tier throughout
    // and the announced tier does not move (a renewal that fails after a paid charge does keep the plan: AS-56 and S18)
    const read = await t
      .as(fs.owner)
      .get(`/api/shops/${fs.shopId}/subscription`);
    expect(read.body.entitlements.auctions).toBe(false);
    expect(
      (await events('billing.subscription_plan_changed')).map((p) => p.version),
    ).toEqual([1]);
  });

  it('S17 AS-42: the whole dunning path, on the schedule from the first failure, to UNPAID', async () => {
    const fs = await open({ paymentMethodRef: 'pm_declined' });
    const invoice = await invoiceOf(fs);
    await t.drainJobs(); // attempt 1 at T0
    await t.at('2026-04-11T12:00:40.000Z'); // attempt 2, 30 s late
    await t.drainJobs();
    let row = await invoiceOf(fs);
    expect(row.attempts).toBe(2);
    expect(iso(row.nextAttemptAt)).toBe('2026-04-13T12:00:10.000Z');
    await t.at('2026-04-13T12:00:10.000Z');
    await t.drainJobs();
    row = await invoiceOf(fs);
    expect(row.attempts).toBe(3);
    expect(iso(row.nextAttemptAt)).toBe('2026-04-17T12:00:10.000Z');
    await t.at('2026-04-17T12:00:10.000Z');
    await t.drainJobs();
    row = await invoiceOf(fs);
    expect(row).toMatchObject({
      attempts: 4,
      status: 'UNCOLLECTIBLE',
      nextAttemptAt: null,
    });
    expect((await sub(fs.subscriptionId)).status).toBe('UNPAID');

    const failed = (await events('billing.invoice_payment_failed')).map((p) =>
      invoicePaymentFailedSchema.parse(p),
    );
    expect(failed.map((p) => [p.attempt, p.nextAttemptAt])).toEqual([
      [1, '2026-04-11T12:00:10.000Z'],
      [2, '2026-04-13T12:00:10.000Z'],
      [3, '2026-04-17T12:00:10.000Z'],
      [4, null],
    ]);
    expect(
      (await events('billing.subscription_status_changed')).pop(),
    ).toMatchObject({ status: 'UNPAID', from: 'PAST_DUE' });
    expect(
      (await events('billing.subscription_plan_changed')).map((p) => [
        p.plan,
        p.version,
      ]),
    ).toEqual([['STARTER', 1]]); // never paid: the tier was the free one from the first announcement to UNPAID
    expect(t.provider.creates.map((c) => c.idempotencyKey)).toEqual(
      [1, 2, 3, 4].map((n) => `${invoice.id}:${n}`),
    );
    await t.charges.chargeInvoice(invoice.id); // a fifth delivery
    expect(t.provider.creates).toHaveLength(4);
    // access is withdrawn: the entitlements fall back to the free tier
    await t.reauth(fs.owner);
    const read = await t
      .as(fs.owner)
      .get(`/api/shops/${fs.shopId}/subscription`);
    expect(read.body.subscription.status).toBe('UNPAID');
    expect(read.body.entitlements).toMatchObject({
      maxProducts: 10,
      auctions: false,
    });
    expect(metric('billing_dunning_exhausted_total')).toBeGreaterThan(0);
  });

  it('S17 AS-44: a job that arrives early does nothing and asks to run at the due time', async () => {
    const fs = await open({ paymentMethodRef: 'pm_declined' });
    const invoice = await invoiceOf(fs);
    await t.drainJobs();
    const before = await invoiceOf(fs);
    await t.charges.chargeInvoice(invoice.id);
    expect(t.provider.creates).toHaveLength(1);
    expect((await invoiceOf(fs)).attempts).toBe(before.attempts);
    const [queued] = await rows<{ runAt: Date }>(
      `SELECT j."runAt" FROM "Job" j JOIN "JobKey" k ON k."jobId" = j.id
        WHERE k."idempotencyKey" LIKE :like AND j.status = 'QUEUED'`,
      { like: `invoice-charge:${invoice.id}:2:at:%` },
    );
    expect(iso(queued.runAt)).toBe(iso(before.nextAttemptAt));
  });

  it('S17 AS-45: the same job delivered twice at once charges once (50 invoices)', async () => {
    const fss: Fixture[] = [];
    for (let i = 0; i < 50; i++)
      fss.push(await open({ plan: 'starter', quantity: 1 }));
    const ids = await Promise.all(
      fss.map(async (fs) => (await invoiceOf(fs)).id),
    );
    await Promise.all(
      ids.flatMap((id) => [
        t.charges.chargeInvoice(id),
        t.charges.chargeInvoice(id),
      ]),
    );
    expect(t.provider.creates).toHaveLength(50);
    for (const id of ids)
      expect(t.provider.callsFor(`${id}:1`)).toHaveLength(1);
    expect(await count('Invoice', `status = 'PAID'`)).toBe(50);
    expect((await events('billing.invoice_paid')).length).toBe(50);
  }, 240_000);

  it('S17 AS-46: paying while past due recovers the subscription and the scheduled jobs then do nothing', async () => {
    const fs = await open();
    const invoice = await invoiceOf(fs);
    declineOnce();
    await t.drainJobs();
    expect((await sub(fs.subscriptionId)).status).toBe('PAST_DUE');
    await t.at('2026-04-11T12:00:10.000Z');
    await t.drainJobs();
    expect(await invoiceOf(fs)).toMatchObject({ status: 'PAID', attempts: 2 });
    expect((await sub(fs.subscriptionId)).status).toBe('ACTIVE');
    const [moved] = await rows<{ actor: string }>(
      `SELECT actor FROM "SubscriptionTransition" WHERE "subscriptionId" = :id ORDER BY version DESC LIMIT 1`,
      { id: fs.subscriptionId },
    );
    expect(moved.actor).toBe('system:dunning');
    expect(await events('billing.invoice_paid')).toHaveLength(1);
    expect(
      (await events('billing.subscription_status_changed')).pop(),
    ).toMatchObject({ status: 'ACTIVE', from: 'PAST_DUE' });
    await t.charges.chargeInvoice(invoice.id);
    expect(t.provider.creates).toHaveLength(2);
  });

  it('S17 AS-47: recovery waits for every invoice in dunning', async () => {
    const fs = await createFs(t, {
      plan: 'starter',
      quantity: 1,
      at: '2026-04-01T00:00:00.000Z',
    });
    expectStatus(
      await put(fs.owner, fs.shopId, { paymentMethodRef: 'pm_declined' }),
      200,
    );
    // R: the renewal at the period end; P: an upgrade right after it. Both are open when the charges run.
    await t.at('2026-05-01T00:00:00.000Z', fs.owner);
    await t.renewals.run();
    const change = await t
      .as(fs.owner)
      .post(`/api/shops/${fs.shopId}/subscription/change`)
      .set('Idempotency-Key', key())
      .send({ priceId: await t.priceId('pro') });
    expectStatus(change, 200);
    await t.drainJobs();
    expect((await sub(fs.subscriptionId)).status).toBe('PAST_DUE');
    const owed = await rows<{ kind: string; status: string }>(
      `SELECT kind, status FROM "Invoice" WHERE "subscriptionId" = :id AND status = 'OPEN' ORDER BY "createdAt", id`,
      { id: fs.subscriptionId },
    );
    expect(owed.map((i) => i.kind)).toEqual(['RENEWAL', 'PRORATION']);

    // a good card: the oldest invoice (R) is collected first, the subscription waits for P
    expectStatus(
      await put(fs.owner, fs.shopId, { paymentMethodRef: 'pm_ok' }),
      200,
    );
    await t.drainJobs();
    expect((await sub(fs.subscriptionId)).status).toBe('PAST_DUE');
    expectStatus(
      await put(fs.owner, fs.shopId, { paymentMethodRef: 'pm_ok' }),
      200,
    );
    await t.drainJobs();
    expect((await sub(fs.subscriptionId)).status).toBe('ACTIVE');
    expect(
      await count(
        'Invoice',
        `"subscriptionId" = '${fs.subscriptionId}' AND status = 'PAID' AND total > 0`,
      ),
    ).toBe(3);
  });

  describe('S17 AS-48 to AS-51 and AS-58: an outcome we do not know', () => {
    const unknownFs = async (ref = 'pm_timeout') => {
      const fs = await open({ paymentMethodRef: ref });
      const invoice = await invoiceOf(fs);
      await t.drainJobs();
      return { fs, invoice };
    };

    it('S17 AS-48: a silent provider leaves the attempt claimed and unknown, with a lookup scheduled and no dunning', async () => {
      const { fs, invoice } = await unknownFs();
      const row = await invoiceOf(fs);
      expect(row).toMatchObject({
        status: 'OPEN',
        attempts: 1,
        attemptUnknown: true,
        attemptRef: '1',
        firstFailedAt: null,
      });
      expect(row.attemptStartedAt).not.toBeNull();
      expect((await sub(fs.subscriptionId)).status).toBe('ACTIVE');
      expect(await events('billing.invoice_payment_failed')).toHaveLength(0);
      expect(t.provider.creates).toHaveLength(1);
      expect(t.provider.creates[0].timeoutMs).toBe(8000);
      const [resolution] = await rows<{
        runAt: Date;
        payload: Record<string, any>;
      }>(
        `SELECT "runAt", payload FROM "Job" WHERE type = 'billing.resolve-attempt' AND status = 'QUEUED'`,
      );
      expect(resolution.payload).toMatchObject({
        invoiceId: invoice.id,
        attempt: '1',
      });
      expect(new Date(resolution.runAt).getTime()).toBe(
        t.clock.now().getTime() + 30_000,
      );
      expect(
        metric('billing_charge_attempts_total', { outcome: 'unknown' }),
      ).toBeGreaterThan(0);
    });

    it('S17 AS-49: the lookup finds the charge: it is applied once, and nothing is sent again', async () => {
      const { fs } = await unknownFs('pm_late');
      expect(t.provider.held.size).toBe(1);
      await t.at(at(t.clock.now().toISOString(), 31_000));
      await t.drainJobs();
      expect(await invoiceOf(fs)).toMatchObject({
        status: 'PAID',
        attemptUnknown: false,
        attemptStartedAt: null,
      });
      expect(await events('billing.invoice_paid')).toHaveLength(1);
      expect(t.provider.creates).toHaveLength(1);
      expect(t.provider.searches[0].pairs).toMatchObject({ attempt: '1' });
      expect((await sub(fs.subscriptionId)).status).toBe('ACTIVE');
    });

    it('S17 AS-49: a lookup that finds a failed charge applies the decline; one awaiting the customer, the customer-action path', async () => {
      const { fs, invoice } = await unknownFs();
      t.provider.hold(
        `${invoice.id}:1`,
        { kind: 'subscription_invoice', invoiceId: invoice.id, attempt: '1' },
        'requires_payment_method',
        { code: 'card_declined' },
      );
      await t.resolution.resolve(invoice.id, '1');
      expect(await invoiceOf(fs)).toMatchObject({
        status: 'OPEN',
        attemptUnknown: false,
      });
      expect((await sub(fs.subscriptionId)).status).toBe('PAST_DUE');
      expect((await events('billing.invoice_payment_failed'))[0]).toMatchObject(
        { attempt: 1, reason: 'card_declined' },
      );

      const second = await unknownFs();
      t.provider.hold(
        `${second.invoice.id}:1`,
        {
          kind: 'subscription_invoice',
          invoiceId: second.invoice.id,
          attempt: '1',
        },
        'requires_action',
      );
      await t.resolution.resolve(second.invoice.id, '1');
      expect(
        (await events('billing.invoice_payment_failed')).pop(),
      ).toMatchObject({ reason: 'authentication_required' });
      expect(t.provider.creates).toHaveLength(2);
    });

    it('S17 AS-50: nothing found: unknown until 60 minutes after the attempt began, then no_provider_record', async () => {
      const { fs, invoice } = await unknownFs();
      const began = new Date((await invoiceOf(fs)).attemptStartedAt).getTime();
      t.clock.set(new Date(began + 3_599_000));
      await t.resolution.resolve(invoice.id, '1');
      expect(await invoiceOf(fs)).toMatchObject({
        attemptUnknown: true,
        attempts: 1,
      });
      expect(await events('billing.invoice_payment_failed')).toHaveLength(0);
      const queued = await rows<{ runAt: Date }>(
        `SELECT "runAt" FROM "Job" WHERE type = 'billing.resolve-attempt' AND status = 'QUEUED' ORDER BY "runAt"`,
      );
      expect(queued.length).toBeGreaterThan(0);
      expect(
        new Date(queued[queued.length - 1].runAt).getTime(),
      ).toBeGreaterThan(began + 3_599_000);

      t.clock.set(new Date(began + 3_600_000));
      await t.resolution.resolve(invoice.id, '1');
      expect(await invoiceOf(fs)).toMatchObject({
        attemptUnknown: false,
        attemptStartedAt: null,
        attempts: 1,
      });
      expect((await events('billing.invoice_payment_failed'))[0]).toMatchObject(
        { reason: 'no_provider_record', attempt: 1 },
      );
      expect((await sub(fs.subscriptionId)).status).toBe('PAST_DUE');
      expect(t.provider.creates).toHaveLength(1);
    });

    it('S17 AS-51: a lookup that cannot reach the provider changes nothing and tries again later', async () => {
      const { fs, invoice } = await unknownFs();
      for (const fault of ['timeout', 'server_error'] as const) {
        t.provider.searchFault = fault;
        await t.at(at(t.clock.now().toISOString(), 40_000));
        await t.resolution.resolve(invoice.id, '1');
        expect(await invoiceOf(fs)).toMatchObject({
          status: 'OPEN',
          attemptUnknown: true,
          attempts: 1,
        });
      }
      expect(await events('billing.invoice_payment_failed')).toHaveLength(0);
      expect(t.provider.creates).toHaveLength(1);
      const queued = await count(
        'Job',
        `type = 'billing.resolve-attempt' AND status = 'QUEUED'`,
      );
      expect(queued).toBeGreaterThan(0);
    });

    it('S17 AS-58: an answer nobody can classify is unknown, never a success or a decline, and logs no payment data', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      try {
        for (const ref of ['pm_mystery', 'pm_garbage']) {
          const { fs } = await unknownFs(ref);
          expect(await invoiceOf(fs)).toMatchObject({
            status: 'OPEN',
            attemptUnknown: true,
          });
          expect((await sub(fs.subscriptionId)).status).toBe('ACTIVE');
        }
        expect(await events('billing.invoice_paid')).toHaveLength(0);
        expect(await events('billing.invoice_payment_failed')).toHaveLength(0);
        const logs = warn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logs).toContain('unclassifiable');
        expect(logs).not.toMatch(/pm_/);
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('S17 AS-52: a card that needs the customer is a definite failure with its own reason', async () => {
    const fs = await open({ paymentMethodRef: 'pm_auth' });
    await t.drainJobs();
    expect((await events('billing.invoice_payment_failed'))[0]).toMatchObject({
      attempt: 1,
      reason: 'authentication_required',
    });
    expect((await sub(fs.subscriptionId)).status).toBe('PAST_DUE');
    expect(await invoiceOf(fs)).toMatchObject({
      attempts: 1,
      attemptUnknown: false,
    });
  });

  it('S17 AS-53: with no payment method nothing is sent to the provider; the attempt fails as no_payment_method', async () => {
    const admin = await t.admin();
    const free = await publishPrice(t, admin, 'starter', {
      interval: 'MONTH',
      unitAmountMinor: 0,
      perSeat: false,
    });
    const made = await t.shopWithOwner();
    await t.reauth(made.owner);
    expectStatus(
      await subscribeShop(t, made.owner, made.shopId, { priceId: free.id }),
      201,
    );
    const upgrade = await t
      .as(made.owner)
      .post(`/api/shops/${made.shopId}/subscription/change`)
      .set('Idempotency-Key', key())
      .send({ priceId: await t.priceId('pro'), quantity: 1 });
    expectStatus(upgrade, 200);
    await t.drainJobs();
    expect(t.provider.creates).toHaveLength(0);
    const [{ id }] = await rows<{ id: string }>(
      `SELECT id FROM "Subscription"`,
    );
    expect((await sub(id)).status).toBe('PAST_DUE');
    expect((await events('billing.invoice_payment_failed'))[0]).toMatchObject({
      attempt: 1,
      reason: 'no_payment_method',
    });
  });

  it('S17 AS-54: an invoice of zero or less is created paid and never charged', async () => {
    const admin = await t.admin();
    const free = await publishPrice(t, admin, 'starter', {
      interval: 'MONTH',
      unitAmountMinor: 0,
      perSeat: false,
    });
    const made = await t.shopWithOwner();
    await t.reauth(made.owner);
    const res = await subscribeShop(t, made.owner, made.shopId, {
      priceId: free.id,
    });
    expectStatus(res, 201);
    const sub1 = subscriptionSchema.parse(res.body);
    expect(sub1.latestInvoice).toMatchObject({ status: 'PAID', totalMinor: 0 });
    // a downgrade creates a negative, closed invoice
    const fs = await createFs(t, {
      plan: 'pro',
      at: '2026-04-01T00:00:00.000Z',
    });
    await t.at('2026-04-16T00:00:00.000Z', fs.owner);
    expectStatus(
      await t
        .as(fs.owner)
        .post(`/api/shops/${fs.shopId}/subscription/change`)
        .set('Idempotency-Key', key())
        .send({ priceId: await t.priceId('starter') }),
      200,
    );
    await t.drainJobs();
    const closed = await rows<{ id: string; total: string; status: string }>(
      `SELECT id, total, status FROM "Invoice" WHERE total <= 0`,
    );
    expect(closed.length).toBe(2);
    expect(closed.every((i) => i.status === 'PAID')).toBe(true);
    const calls = t.provider.creates.length;
    for (const invoice of closed) await t.charges.chargeInvoice(invoice.id);
    expect(t.provider.creates).toHaveLength(calls);
    expect(t.provider.creates.every((c) => c.amount > 0)).toBe(true);
  });

  describe('S17 AS-55 to AS-57: the payment method', () => {
    it('S17 AS-55: a new card gives one extra attempt now; the numbered schedule is untouched', async () => {
      const fs = await open();
      const invoice = await invoiceOf(fs);
      declineOnce();
      await t.drainJobs();
      const before = await invoiceOf(fs);
      await t.at('2026-04-11T08:00:10.000Z', fs.owner); // attempt 2 is due in 4 hours
      const res = await put(fs.owner, fs.shopId, { paymentMethodRef: 'pm_ok' });
      expectStatus(res, 200);
      expect(subscriptionSchema.parse(res.body).hasPaymentMethod).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('pm_ok');
      await t.drainJobs();
      expect(t.provider.creates.map((c) => c.idempotencyKey)).toEqual([
        `${invoice.id}:1`,
        `${invoice.id}:manual:1`,
      ]);
      expect(await invoiceOf(fs)).toMatchObject({
        status: 'PAID',
        attempts: 1,
        manualAttempts: 1,
      });
      expect((await sub(fs.subscriptionId)).status).toBe('ACTIVE');
      expect(before.attempts).toBe(1);
    });

    it('S17 AS-55: a failed extra attempt changes nothing else', async () => {
      const fs = await open();
      declineOnce();
      await t.drainJobs();
      const before = await invoiceOf(fs);
      await t.at('2026-04-10T13:00:10.000Z', fs.owner);
      expectStatus(
        await put(fs.owner, fs.shopId, { paymentMethodRef: 'pm_declined' }),
        200,
      );
      await t.drainJobs();
      const after = await invoiceOf(fs);
      expect(after).toMatchObject({
        status: 'OPEN',
        attempts: 1,
        manualAttempts: 1,
        attemptStartedAt: null,
      });
      expect(iso(after.nextAttemptAt)).toBe(iso(before.nextAttemptAt));
      expect(iso(after.firstFailedAt)).toBe(iso(before.firstFailedAt));
      expect((await sub(fs.subscriptionId)).status).toBe('PAST_DUE');
      expect(await events('billing.invoice_payment_failed')).toHaveLength(1);
    });

    it('S17 AS-56: paying an unpaid subscription reactivates it and restores the shop tier', async () => {
      const fs = await open({ paymentMethodRef: 'pm_declined' });
      await t.drainJobs();
      for (const iso0 of [
        '2026-04-11T12:00:10.000Z',
        '2026-04-13T12:00:10.000Z',
        '2026-04-17T12:00:10.000Z',
      ]) {
        await t.at(iso0);
        await t.drainJobs();
      }
      expect((await sub(fs.subscriptionId)).status).toBe('UNPAID');
      expect((await invoiceOf(fs)).status).toBe('UNCOLLECTIBLE');
      await t.reauth(fs.owner);
      expectStatus(
        await put(fs.owner, fs.shopId, { paymentMethodRef: 'pm_ok' }),
        200,
      );
      await t.drainJobs();
      expect((await invoiceOf(fs)).status).toBe('PAID');
      expect((await sub(fs.subscriptionId)).status).toBe('ACTIVE');
      expect(
        (await events('billing.subscription_plan_changed')).map((p) => [
          p.plan,
          p.version,
        ]),
      ).toEqual([
        ['STARTER', 1],
        ['PRO', 2],
      ]);
      expect(
        (
          await rows(
            `SELECT "fromStatus", "toStatus" FROM "InvoiceTransition" WHERE "invoiceId" = :id ORDER BY "at", id`,
            { id: (await invoiceOf(fs)).id },
          )
        ).map((r) => `${r.fromStatus}>${r.toStatus}`),
      ).toEqual(['OPEN>UNCOLLECTIBLE', 'UNCOLLECTIBLE>PAID']);
    });

    it('S17 AS-56: with nothing owed only the reference is stored and nothing is charged', async () => {
      const fs = await createFs(t, { at: '2026-04-01T00:00:00.000Z' });
      const calls = t.provider.creates.length;
      expectStatus(
        await put(fs.owner, fs.shopId, { paymentMethodRef: 'pm_other' }),
        200,
      );
      await t.drainJobs();
      expect(t.provider.creates).toHaveLength(calls);
      const [row] = await rows<{ paymentMethodRef: string }>(
        `SELECT "paymentMethodRef" FROM "Subscription" WHERE id = :id`,
        { id: fs.subscriptionId },
      );
      expect(row.paymentMethodRef).toBe('pm_other');
    });

    it('S17 AS-57: validation, credentials, tenancy and the hourly limit of the payment-method route', async () => {
      const fs = await createFs(t, { at: '2026-04-01T00:00:00.000Z' });
      const viewer = await t.member(fs.shopId, 'VIEWER');
      const other = await t.shopWithOwner();
      for (const body of [
        {},
        { paymentMethodRef: '' },
        { paymentMethodRef: 'card_1' },
        { paymentMethodRef: 'pm_ok', extra: 1 },
      ]) {
        const res = await put(fs.owner, fs.shopId, body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      }
      expect(
        (
          await t
            .http()
            .put(`/api/shops/${fs.shopId}/subscription/payment-method`)
            .send({ paymentMethodRef: 'pm_x' })
        ).status,
      ).toBe(401);
      expect(
        (await put(fs.owner, other.shopId, { paymentMethodRef: 'pm_x' }))
          .status,
      ).toBe(404);
      const forbidden = await put(viewer, fs.shopId, {
        paymentMethodRef: 'pm_x',
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('permission_denied');
      const ref = async () =>
        (
          await rows<{ paymentMethodRef: string }>(
            `SELECT "paymentMethodRef" FROM "Subscription" WHERE id = :id`,
            { id: fs.subscriptionId },
          )
        )[0].paymentMethodRef;
      expect(await ref()).toBe('pm_ok');
      // five per hour per shop, every attempt that reaches the limiter counts: the four bad bodies above used four
      let accepted = 0;
      let last = 'pm_ok';
      for (let i = 0; i < 6; i++) {
        const res = await put(fs.owner, fs.shopId, {
          paymentMethodRef: `pm_card_${i}`,
        });
        if (res.status === 200) {
          accepted++;
          last = `pm_card_${i}`;
        } else {
          expect(res.status).toBe(429);
          expect(res.headers['retry-after']).toBeDefined();
        }
      }
      expect(accepted).toBe(1);
      expect(await ref()).toBe(last);
      expect(last).toBe('pm_card_0');
    });
  });
});
