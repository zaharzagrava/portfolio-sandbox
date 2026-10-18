import { v4 as uuidv4 } from 'uuid';
import {
  eventEnvelopeSchema,
  subscriptionSchema,
} from '@marketplace-sandbox/contracts';
import {
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
} from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import type { TestUser } from '@app/test/utils/catalog-app';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import {
  createFs,
  expectStatus,
  key,
  subscribeShop,
} from './testing/billing-flows';

const NOW = '2026-04-01T00:00:00.000Z';

describe('Billing: subscription state machine, cancel, resume and shop lifecycle', () => {
  let t: BillingTestApp;

  beforeAll(async () => {
    t = await createBillingApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date(NOW));
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
  const history = (id: string) =>
    rows<{
      fromStatus: string | null;
      toStatus: string;
      reason: string;
      actor: string;
      version: number;
    }>(
      `SELECT "fromStatus", "toStatus", reason, actor, version FROM "SubscriptionTransition"
        WHERE "subscriptionId" = :id ORDER BY version`,
      { id },
    );
  const statusEvents = async (id: string) =>
    (await t.outbox('billing.subscription_status_changed')).filter(
      (e) => e.payload.subscriptionId === id,
    );
  const post = (
    who: TestUser,
    shopId: string,
    path: string,
    body: unknown = {},
  ) =>
    t
      .as(who)
      .post(`/api/shops/${shopId}/subscription/${path}`)
      .send(body as object);

  describe('S17 AS-22: illegal moves at the API are 409, a missing subscription is 404', () => {
    it('S17 AS-22: a past-due subscription cannot be changed', async () => {
      const fs = await createFs(t, { paymentMethodRef: 'pm_declined' });
      expect((await sub(fs.subscriptionId)).status).toBe('PAST_DUE');
      const res = await post(fs.owner, fs.shopId, 'change', {
        priceId: await t.priceId('pro'),
      });
      // change needs an idempotency key; send one
      void res;
      const withKey = await t
        .as(fs.owner)
        .post(`/api/shops/${fs.shopId}/subscription/change`)
        .set('Idempotency-Key', key())
        .send({ priceId: await t.priceId('pro') });
      expect(withKey.status).toBe(409);
      expect(withKey.body.code).toBe('subscription_not_changeable');
      expect((await sub(fs.subscriptionId)).priceId).toBe(
        await t.priceId('starter'),
      );
      expect((await history(fs.subscriptionId)).map((h) => h.toStatus)).toEqual(
        ['ACTIVE', 'PAST_DUE'],
      );
    });

    it('S17 AS-22: cancelling twice and resuming without a schedule are 409', async () => {
      const fs = await createFs(t);
      expectStatus(await post(fs.owner, fs.shopId, 'cancel'), 200);
      const again = await post(fs.owner, fs.shopId, 'cancel');
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already_scheduled_for_cancellation');

      const other = await createFs(t);
      const resume = await post(other.owner, other.shopId, 'resume');
      expect(resume.status).toBe(409);
      expect(resume.body.code).toBe('not_scheduled_for_cancellation');
    });

    it('S17 AS-22: a cancelled subscription answers 404 no_active_subscription to every action', async () => {
      const fs = await createFs(t);
      expectStatus(
        await post(fs.owner, fs.shopId, 'cancel', { immediately: true }),
        200,
      );
      const attempts = [
        post(fs.owner, fs.shopId, 'cancel'),
        post(fs.owner, fs.shopId, 'resume'),
        t
          .as(fs.owner)
          .post(`/api/shops/${fs.shopId}/subscription/change`)
          .set('Idempotency-Key', key())
          .send({ quantity: 2 }),
        t
          .as(fs.owner)
          .put(`/api/shops/${fs.shopId}/subscription/payment-method`)
          .send({ paymentMethodRef: 'pm_new' }),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('no_active_subscription');
      }
    });
  });

  describe('S17 AS-23: every move leaves one history row, atomically, and history is append-only', () => {
    it('S17 AS-23: each move adds exactly one row with the new version and a legal actor', async () => {
      const fs = await createFs(t, { plan: 'pro' });
      expectStatus(await post(fs.owner, fs.shopId, 'cancel'), 200);
      expectStatus(await post(fs.owner, fs.shopId, 'resume'), 200);
      expectStatus(
        await post(fs.owner, fs.shopId, 'cancel', { immediately: true }),
        200,
      );
      const h = await history(fs.subscriptionId);
      expect(
        h.map((r) => [r.version, r.fromStatus, r.toStatus, r.reason]),
      ).toEqual([
        [0, null, 'ACTIVE', 'subscribed'],
        [1, 'ACTIVE', 'ACTIVE', 'cancel_scheduled'],
        [2, 'ACTIVE', 'ACTIVE', 'cancel_withdrawn'],
        [3, 'ACTIVE', 'CANCELED', 'cancelled_by_customer'],
      ]);
      expect(h.every((r) => r.actor === `user:${fs.owner.id}`)).toBe(true);
      expect((await sub(fs.subscriptionId)).version).toBe(3);
      // status events only for moves that change the status, plus the one that announces the first settled charge
      // (J02 G-13: ACTIVE to ACTIVE, the paid plan starting)
      expect(
        (await statusEvents(fs.subscriptionId)).map((e) => [
          e.payload.from,
          e.payload.status,
        ]),
      ).toEqual([
        [null, 'ACTIVE'],
        ['ACTIVE', 'ACTIVE'],
        ['ACTIVE', 'CANCELED'],
      ]);
    });

    it('S17 AS-23: when the transaction fails midway neither the status, the history row nor the event exists', async () => {
      const fs = await createFs(t);
      const events = await count('Outbox');
      const outbox = t.app.get(OutboxService);
      const spy = jest
        .spyOn(outbox, 'append')
        .mockRejectedValueOnce(new Error('boom'));
      try {
        const res = await post(fs.owner, fs.shopId, 'cancel', {
          immediately: true,
        });
        expect(res.status).toBeGreaterThanOrEqual(500);
      } finally {
        spy.mockRestore();
      }
      const row = await sub(fs.subscriptionId);
      expect(row.status).toBe('ACTIVE');
      expect(row.version).toBe(0);
      expect(await history(fs.subscriptionId)).toHaveLength(1);
      expect(await count('Outbox')).toBe(events);
      expect(
        await count(
          'Invoice',
          `"subscriptionId" = '${fs.subscriptionId}' AND status = 'UNCOLLECTIBLE'`,
        ),
      ).toBe(0);
    });

    it('S17 AS-23: the store rejects an update or a delete of a history row', async () => {
      const fs = await createFs(t);
      await expect(
        t.sequelize.query(
          `UPDATE "SubscriptionTransition" SET reason = 'edited' WHERE "subscriptionId" = :id`,
          { replacements: { id: fs.subscriptionId } },
        ),
      ).rejects.toThrow(/billing_history_append_only/);
      await expect(
        t.sequelize.query(
          `DELETE FROM "SubscriptionTransition" WHERE "subscriptionId" = :id`,
          { replacements: { id: fs.subscriptionId } },
        ),
      ).rejects.toThrow(/billing_history_append_only/);
      expect(await history(fs.subscriptionId)).toHaveLength(1);
      const [invoice] = await rows<{ id: string }>(
        `SELECT id FROM "Invoice" WHERE "subscriptionId" = :id`,
        { id: fs.subscriptionId },
      );
      await t.sequelize
        .query(`UPDATE "Invoice" SET status = 'UNCOLLECTIBLE' WHERE id = :id`, {
          replacements: { id: invoice.id },
        })
        .catch(() => undefined);
    });
  });

  it('S17 AS-24: a failing charge and an immediate cancel at once leave a consistent chain (50 rounds)', async () => {
    for (let round = 0; round < 50; round++) {
      const fs = await createFs(t, {
        paymentMethodRef: 'pm_declined',
        charge: false,
      });
      await t.reauth(fs.owner);
      const [invoice] = await rows<{ id: string }>(
        `SELECT id FROM "Invoice" WHERE "subscriptionId" = :id`,
        { id: fs.subscriptionId },
      );
      const [charge, cancel] = await Promise.all([
        t.charges.chargeInvoice(invoice.id).then(
          () => 'ok',
          (e: Error) => e.message,
        ),
        post(fs.owner, fs.shopId, 'cancel', { immediately: true }),
      ]);
      expect(charge).toBe('ok');
      expect(cancel.status).toBe(200);
      const h = await history(fs.subscriptionId);
      expect((await sub(fs.subscriptionId)).status).toBe('CANCELED');
      expect(h[h.length - 1].toStatus).toBe('CANCELED');
      h.forEach((row, index) => {
        expect(row.version).toBe(index);
        if (index > 0) expect(row.fromStatus).toBe(h[index - 1].toStatus);
      });
      const canceledAt = h.findIndex((row) => row.toStatus === 'CANCELED');
      expect(h.slice(canceledAt + 1)).toEqual([]);
      const moved = h.filter((row) => row.fromStatus !== row.toStatus).length;
      expect((await statusEvents(fs.subscriptionId)).length).toBe(moved);
    }
  }, 240_000);

  it('S17 AS-25: a cancelled subscription is terminal: a late charge job, the run and a duplicate event change nothing', async () => {
    const fs = await createFs(t, { charge: false });
    expectStatus(
      await post(fs.owner, fs.shopId, 'cancel', { immediately: true }),
      200,
    );
    const before = {
      history: await history(fs.subscriptionId),
      events: await count('Outbox'),
      invoices: await count('Invoice'),
    };
    await t.at('2026-05-02T00:00:00.000Z');
    await t.drainJobs(); // the charge job queued by the subscribe
    await t.runBilling();
    const deleted: EventEnvelope = ShopDeleted.create(fs.shopId, 2, {
      shopId: fs.shopId,
      shopVersion: 2,
    });
    await t.tenancy.deliver(deleted, deleted);
    expect(t.provider.creates).toHaveLength(0);
    expect(await history(fs.subscriptionId)).toEqual(before.history);
    expect(await count('Invoice')).toBe(before.invoices);
    expect(await count('Outbox')).toBe(before.events);
    expect((await sub(fs.subscriptionId)).status).toBe('CANCELED');
  });

  describe('S17 AS-71 to AS-74: cancel and resume', () => {
    it('S17 AS-71: cancelling at the period end keeps status and access and records one row', async () => {
      const fs = await createFs(t);
      const res = await post(fs.owner, fs.shopId, 'cancel', {});
      expectStatus(res, 200);
      const body = subscriptionSchema.parse(res.body);
      expect(body).toMatchObject({
        status: 'ACTIVE',
        cancelAtPeriodEnd: true,
        version: 1,
      });
      const h = await history(fs.subscriptionId);
      expect(h[1]).toMatchObject({
        fromStatus: 'ACTIVE',
        toStatus: 'ACTIVE',
        reason: 'cancel_scheduled',
        version: 1,
      });
      expect(
        await count('Invoice', `"subscriptionId" = '${fs.subscriptionId}'`),
      ).toBe(1);
      expect((await t.http().get('/api/plans')).status).toBe(200);
      const read = await t
        .as(fs.owner)
        .get(`/api/shops/${fs.shopId}/subscription`);
      expect(read.body.entitlements.maxProducts).toBe(100);
    });

    it('S17 AS-72: cancelling now ends it, writes off the unpaid invoice, keeps the credit and allows a new subscription', async () => {
      const fs = await createFs(t, { plan: 'pro', charge: false });
      await t.sql(`SELECT 1`);
      const res = await post(fs.owner, fs.shopId, 'cancel', {
        immediately: true,
      });
      expectStatus(res, 200);
      expect(subscriptionSchema.parse(res.body).status).toBe('CANCELED');
      const row = await sub(fs.subscriptionId);
      expect(row.canceledAt).not.toBeNull();
      const invoices = await rows<{ status: string }>(
        `SELECT status FROM "Invoice" WHERE "subscriptionId" = :id`,
        { id: fs.subscriptionId },
      );
      expect(invoices.map((i) => i.status)).toEqual(['UNCOLLECTIBLE']);
      expect(await count('InvoiceTransition')).toBe(1);

      await t.drainJobs(); // the pending charge job does nothing
      expect(t.provider.creates).toHaveLength(0);
      expect(
        (await t.outbox('billing.subscription_status_changed')).map(
          (e) => e.payload.status,
        ),
      ).toEqual(['ACTIVE', 'CANCELED']);
      expect(
        (await t.outbox('billing.subscription_plan_changed')).map((e) => [
          e.payload.plan,
          e.payload.version,
        ]),
      ).toEqual([['STARTER', 1]]); // the invoice was never paid: the plan never applied
      const again = await subscribeShop(t, fs.owner, fs.shopId, {
        priceId: await t.priceId('starter'),
        paymentMethodRef: 'pm_ok',
      });
      expect(again.status).toBe(201);
    });

    it('S17 AS-73: resuming withdraws the schedule and the next run renews', async () => {
      const fs = await createFs(t);
      expectStatus(await post(fs.owner, fs.shopId, 'cancel'), 200);
      const res = await post(fs.owner, fs.shopId, 'resume');
      expectStatus(res, 200);
      expect(subscriptionSchema.parse(res.body).cancelAtPeriodEnd).toBe(false);
      expect((await history(fs.subscriptionId)).map((h) => h.reason)).toEqual([
        'subscribed',
        'cancel_scheduled',
        'cancel_withdrawn',
      ]);
      await t.at('2026-05-01T00:00:00.000Z');
      await t.runBilling();
      expect((await sub(fs.subscriptionId)).status).toBe('ACTIVE');
      expect(
        await count('Invoice', `"subscriptionId" = '${fs.subscriptionId}'`),
      ).toBe(2);
    });

    it('S17 AS-74: validation, credentials and tenancy of cancel and resume, shop and buyer routes', async () => {
      const fs = await createFs(t);
      const viewer = await t.member(fs.shopId, 'VIEWER');
      const other = await t.shopWithOwner();
      for (const body of [{ immediately: 'yes' }, { surprise: true }]) {
        const res = await post(fs.owner, fs.shopId, 'cancel', body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      }
      for (const path of ['cancel', 'resume']) {
        expect(
          (
            await t
              .http()
              .post(`/api/shops/${fs.shopId}/subscription/${path}`)
              .send({})
          ).status,
        ).toBe(401);
        expect((await post(fs.owner, other.shopId, path)).status).toBe(404);
        const forbidden = await post(viewer, fs.shopId, path);
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.code).toBe('permission_denied');
      }
      const row = await sub(fs.subscriptionId);
      expect(row.cancelAtPeriodEnd).toBe(false);
      expect(row.version).toBe(0);

      // the buyer routes follow the same split
      const buyer = await t.newUser();
      await t.reauth(buyer);
      expect(
        (await t.http().post('/api/me/subscription/cancel').send({})).status,
      ).toBe(401);
      const none = await t
        .as(buyer)
        .post('/api/me/subscription/cancel')
        .send({});
      expect(none.status).toBe(404);
      expect(none.body.code).toBe('no_active_subscription');
      const bad = await t
        .as(buyer)
        .post('/api/me/subscription/cancel')
        .send({ immediately: 1 });
      expect(bad.status).toBe(400);
      const sub1 = await t
        .as(buyer)
        .post('/api/me/subscription')
        .set('Idempotency-Key', key())
        .send({ priceId: await t.priceId('plus'), paymentMethodRef: 'pm_ok' });
      expectStatus(sub1, 201);
      expectStatus(
        await t.as(buyer).post('/api/me/subscription/cancel').send({}),
        200,
      );
      expectStatus(
        await t.as(buyer).post('/api/me/subscription/resume').send({}),
        200,
      );
    });
  });

  describe('S17 AS-75 to AS-77: the shop lifecycle consumers', () => {
    const started = (shopId: string, at: string): EventEnvelope =>
      ShopOffboardingStarted.create(
        shopId,
        2,
        { shopId, purgeAt: '2026-05-10T00:00:00.000Z', shopVersion: 2 },
        new Date(at),
      );
    const cancelled = (shopId: string, at: string): EventEnvelope =>
      ShopOffboardingCancelled.create(
        shopId,
        3,
        { shopId, shopVersion: 3 },
        new Date(at),
      );
    const deleted = (shopId: string): EventEnvelope =>
      ShopDeleted.create(shopId, 4, { shopId, shopVersion: 4 });

    it('S17 AS-75: offboarding stops billing at the period end; a newer cancellation withdraws only that', async () => {
      const fs = await createFs(t);
      const event = started(fs.shopId, '2026-04-02T10:00:00.000Z');
      const first = await t.tenancy.deliver(event);
      expect(first.counts.applied).toBe(1);
      const row = await sub(fs.subscriptionId);
      expect(row).toMatchObject({
        cancelAtPeriodEnd: true,
        cancelReason: 'shop_offboarding',
      });
      const h = await history(fs.subscriptionId);
      expect(h[h.length - 1]).toMatchObject({
        reason: 'shop_offboarding',
        actor: `event:${event.eventId}`,
      });

      const again = await t.tenancy.deliver(event);
      expect(again.counts.duplicate).toBe(1);
      expect(await history(fs.subscriptionId)).toHaveLength(h.length);

      // an earlier "cancelled" is ignored; a later one withdraws the schedule
      await t.tenancy.deliver(cancelled(fs.shopId, '2026-04-02T09:00:00.000Z'));
      expect((await sub(fs.subscriptionId)).cancelAtPeriodEnd).toBe(true);
      await t.tenancy.deliver(cancelled(fs.shopId, '2026-04-03T09:00:00.000Z'));
      expect(await sub(fs.subscriptionId)).toMatchObject({
        cancelAtPeriodEnd: false,
        cancelReason: null,
      });

      // the billing run at the period end after an offboarding ends the subscription without an invoice
      const other = await createFs(t);
      await t.tenancy.deliver(
        started(other.shopId, '2026-04-02T10:00:00.000Z'),
      );
      await t.at('2026-05-01T00:00:00.000Z');
      await t.runBilling();
      expect((await sub(other.subscriptionId)).status).toBe('CANCELED');
      expect(
        await count('Invoice', `"subscriptionId" = '${other.subscriptionId}'`),
      ).toBe(1);
    });

    it('S17 AS-75: a cancellation the customer scheduled is not withdrawn by the offboarding being cancelled', async () => {
      const fs = await createFs(t);
      expectStatus(await post(fs.owner, fs.shopId, 'cancel'), 200);
      await t.tenancy.deliver(started(fs.shopId, '2026-04-02T10:00:00.000Z'));
      await t.tenancy.deliver(cancelled(fs.shopId, '2026-04-03T10:00:00.000Z'));
      expect(await sub(fs.subscriptionId)).toMatchObject({
        cancelAtPeriodEnd: true,
        cancelReason: 'customer',
      });
    });

    it('S17 AS-76: a deleted shop is cancelled now, its payment reference is erased and its records stay', async () => {
      const fs = await createFs(t);
      const [before] = await rows<{ paymentMethodRef: string | null }>(
        `SELECT "paymentMethodRef" FROM "Subscription" WHERE id = :id`,
        { id: fs.subscriptionId },
      );
      expect(before.paymentMethodRef).toBe('pm_ok');
      const invoices = await rows(
        `SELECT * FROM "Invoice" WHERE "subscriptionId" = :id`,
        { id: fs.subscriptionId },
      );
      const lines = await count('InvoiceLine');
      const event = deleted(fs.shopId);
      expect((await t.tenancy.deliver(event)).counts.applied).toBe(1);
      const row = await sub(fs.subscriptionId);
      expect(row).toMatchObject({
        status: 'CANCELED',
        paymentMethodRef: null,
        cancelReason: 'shop_deleted',
      });
      expect((await history(fs.subscriptionId)).pop()).toMatchObject({
        reason: 'shop_deleted',
        actor: `event:${event.eventId}`,
      });
      expect(
        await rows(`SELECT * FROM "Invoice" WHERE "subscriptionId" = :id`, {
          id: fs.subscriptionId,
        }),
      ).toEqual(invoices.map((i) => ({ ...i })));
      expect(await count('InvoiceLine')).toBe(lines);
      const duplicate = await t.tenancy.deliver(event);
      expect(duplicate.counts.duplicate).toBe(1);
      // a shop that never subscribed changes nothing
      const empty = await t.shopWithOwner();
      const noop = await t.tenancy.deliver(deleted(empty.shopId));
      expect(noop.counts.stale).toBe(1);
      expect(await count('Subscription')).toBe(1);
    });

    it('S17 AS-77: the same message delivered twice, in turn or at once, has its effect once', async () => {
      const a = await createFs(t);
      const b = await createFs(t);
      const c = await createFs(t);
      const events = [
        started(a.shopId, '2026-04-02T10:00:00.000Z'),
        deleted(b.shopId),
      ];
      for (const event of events) {
        const turns = await t.tenancy.deliver(event, event);
        expect(turns.counts).toEqual({ applied: 1, duplicate: 1, stale: 0 });
      }
      const concurrent = deleted(c.shopId);
      const result = await t.tenancy.deliverConcurrently(
        concurrent,
        concurrent,
      );
      expect(result.counts.applied).toBe(1);
      expect(result.counts.duplicate).toBe(1);
      expect(await history(c.subscriptionId)).toHaveLength(2);
      expect(await history(a.subscriptionId)).toHaveLength(2);
      expect(await history(b.subscriptionId)).toHaveLength(2);
    });

    it('S17 AS-77: a bad payload is dead-lettered with no effect and the next message is processed', async () => {
      const fs = await createFs(t);
      const base = {
        version: 1,
        aggregateType: 'tenancy',
        aggregateId: fs.shopId,
        aggregateVersion: 2,
        occurredAt: '2026-04-02T10:00:00.000Z',
      };
      const bad: EventEnvelope[] = [
        {
          ...base,
          eventId: uuidv4(),
          type: 'tenancy.shop_deleted',
          payload: { shopVersion: 2 },
        },
        {
          ...base,
          eventId: uuidv4(),
          type: 'tenancy.shop_deleted',
          payload: { shopId: 'not-a-uuid', shopVersion: 2 },
        },
        {
          ...base,
          eventId: '',
          type: 'tenancy.shop_deleted',
          payload: { shopId: fs.shopId, shopVersion: 2 },
        },
      ];
      const unknownType: EventEnvelope = {
        ...base,
        eventId: uuidv4(),
        type: 'tenancy.shop_renamed',
        payload: { shopId: fs.shopId },
      };
      const good = deleted(fs.shopId);
      const result = await t.tenancy.deliver(...bad, unknownType, good);
      expect(result.deadLetters).toHaveLength(3);
      expect(result.ignored).toBe(1);
      expect(result.counts.applied).toBe(1);
      expect((await sub(fs.subscriptionId)).status).toBe('CANCELED');
      // the framework's envelope contract refuses a missing id before any consumer sees it
      expect(
        eventEnvelopeSchema.safeParse({
          ...base,
          type: 'tenancy.shop_deleted',
          payload: {},
        }).success,
      ).toBe(false);
    });
  });
});
