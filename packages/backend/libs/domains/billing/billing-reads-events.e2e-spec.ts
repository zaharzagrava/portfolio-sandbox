import {
  eventEnvelopeSchema,
  invoicePageSchema,
  invoiceSchema,
  subscriptionReadSchema,
} from '@marketplace-sandbox/contracts';
import type { TestUser } from '@app/test/utils/catalog-app';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  PLAN_STATE_REPOSITORY,
  type PlanStateRepository,
} from './domain/ports';
import { SubscriptionBasisService } from './application/subscription-basis.service';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import {
  createFs,
  expectStatus,
  key,
  subscribeBuyer,
  subscribeShop,
  type Fixture,
} from './testing/billing-flows';

describe('Billing: reads and events', () => {
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
  const strip = (r: { body: any }) => ({
    ...r.body,
    instance: undefined,
    requestId: undefined,
  });

  describe('S17 AS-78: reading the subscription', () => {
    it('S17 AS-78: owner and viewer read the subscription with entitlements; no payment reference, credit balance and latest invoice present', async () => {
      const fs = await createFs(t, { plan: 'pro', quantity: 2 });
      const viewer = await t.member(fs.shopId, 'VIEWER');
      await t.reauth(viewer);
      for (const who of [fs.owner, viewer]) {
        const res = await t.as(who).get(`/api/shops/${fs.shopId}/subscription`);
        expectStatus(res, 200);
        const body = subscriptionReadSchema.parse(res.body);
        expect(body.subscription).toMatchObject({
          id: fs.subscriptionId,
          status: 'ACTIVE',
          hasPaymentMethod: true,
          creditBalanceMinor: 0,
          quantity: 2,
          latestInvoice: { kind: 'RENEWAL', status: 'PAID', totalMinor: 19800 },
        });
        expect(body.entitlements).toMatchObject({
          maxProducts: 10000,
          seats: 25,
          auctions: true,
        });
        expect(JSON.stringify(res.body)).not.toMatch(/pm_|paymentMethodRef/);
      }
    });

    it('S17 AS-78: with no live subscription the answer is null and the free tier', async () => {
      const made = await t.shopWithOwner();
      await t.reauth(made.owner);
      const res = await t
        .as(made.owner)
        .get(`/api/shops/${made.shopId}/subscription`);
      const body = subscriptionReadSchema.parse(res.body);
      expect(body.subscription).toBeNull();
      expect(body.entitlements).toMatchObject({
        maxProducts: 10,
        auctions: false,
      });
    });

    it('S17 AS-78: a buyer reads their own', async () => {
      const buyer = await t.newUser();
      const none = subscriptionReadSchema.parse(
        (await t.as(buyer).get('/api/me/subscription')).body,
      );
      expect(none.subscription).toBeNull();
      expect(none.entitlements).toMatchObject({
        assistantTokensPerMonth: 200000,
      });
      expectStatus(
        await subscribeBuyer(t, buyer, {
          priceId: await t.priceId('plus'),
          paymentMethodRef: 'pm_ok',
        }),
        201,
      );
      const read = subscriptionReadSchema.parse(
        (await t.as(buyer).get('/api/me/subscription')).body,
      );
      expect(read.subscription).toMatchObject({
        status: 'ACTIVE',
        plan: { code: 'plus' },
        hasPaymentMethod: true,
      });
      expect(read.entitlements).toMatchObject({ freeShipping: true });
      expect((await t.http().get('/api/me/subscription')).status).toBe(401);
    });
  });

  describe('S17 AS-79 and AS-80: invoices', () => {
    /** 45 invoices across a cancelled and a live subscription, made by the billing run month after month. */
    const history = async (): Promise<Fixture> => {
      let fs = await createFs(t, {
        at: '2024-01-01T00:00:00.000Z',
        charge: false,
      });
      for (let month = 1; month < 22; month++) {
        t.clock.set(new Date(Date.UTC(2024, month, 1)));
        await t.renewals.run();
      }
      await t.reauth(fs.owner);
      expectStatus(
        await t
          .as(fs.owner)
          .post(`/api/shops/${fs.shopId}/subscription/cancel`)
          .send({ immediately: true }),
        200,
      );
      t.clock.set(new Date('2025-11-01T00:00:00.000Z'));
      await t.reauth(fs.owner);
      const again = await subscribeShop(t, fs.owner, fs.shopId, {
        priceId: await t.priceId('starter'),
        paymentMethodRef: 'pm_ok',
      });
      expectStatus(again, 201);
      for (let month = 1; month < 23; month++) {
        t.clock.set(new Date(Date.UTC(2025, 10 + month, 1)));
        await t.renewals.run();
      }
      await t.reauth(fs.owner);
      fs = { ...fs };
      return fs;
    };

    it('S17 AS-79: keyset pages of 20, 20 and 5 over both subscriptions, newest first, with a tamper-proof cursor', async () => {
      const fs = await history();
      expect(
        Number(
          (await rows<{ n: string }>(`SELECT count(*) AS n FROM "Invoice"`))[0]
            .n,
        ),
      ).toBe(45);
      const seen: string[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];
      do {
        const res: any = await t
          .as(fs.owner)
          .get(
            `/api/shops/${fs.shopId}/invoices?limit=20${cursor ? `&cursor=${cursor}` : ''}`,
          );
        expectStatus(res, 200);
        const page = invoicePageSchema.parse(res.body);
        sizes.push(page.items.length);
        seen.push(...page.items.map((i) => i.id));
        expect(page.items.every((i) => !('lines' in i))).toBe(true);
        cursor = page.nextCursor;
      } while (cursor);
      expect(sizes).toEqual([20, 20, 5]);
      expect(new Set(seen).size).toBe(45);
      const ordered = await rows<{ id: string }>(
        `SELECT id FROM "Invoice" ORDER BY "createdAt" DESC, id DESC`,
      );
      expect(seen).toEqual(ordered.map((r) => r.id));

      const tooBig = await t
        .as(fs.owner)
        .get(`/api/shops/${fs.shopId}/invoices?limit=101`);
      expect([tooBig.status, tooBig.body.code]).toEqual([
        400,
        'validation_failed',
      ]);
      const first = invoicePageSchema.parse(
        (await t.as(fs.owner).get(`/api/shops/${fs.shopId}/invoices?limit=5`))
          .body,
      );
      for (const bad of [
        'garbage',
        `${first.nextCursor}x`,
        Buffer.from('{"v":1,"c":"2026-01-01","i":"x"}').toString('base64url'),
      ]) {
        const res = await t
          .as(fs.owner)
          .get(
            `/api/shops/${fs.shopId}/invoices?cursor=${encodeURIComponent(bad)}`,
          );
        expect([res.status, res.body.code]).toEqual([400, 'invalid_cursor']);
      }
      const viewer = await t.member(fs.shopId, 'VIEWER');
      await t.reauth(viewer);
      expect(
        (await t.as(viewer).get(`/api/shops/${fs.shopId}/invoices`)).status,
      ).toBe(403);
    }, 300_000);

    it('S17 AS-79: a buyer pages their own invoices the same way', async () => {
      const buyer = await t.newUser();
      expectStatus(
        await subscribeBuyer(t, buyer, {
          priceId: await t.priceId('plus'),
          paymentMethodRef: 'pm_ok',
        }),
        201,
      );
      for (const month of [5, 6]) {
        t.clock.set(new Date(Date.UTC(2026, month - 1, 1)));
        await t.renewals.run();
      }
      await t.reauth(buyer);
      const one = invoicePageSchema.parse(
        (await t.as(buyer).get('/api/me/invoices?limit=2')).body,
      );
      expect(one.items).toHaveLength(2);
      expect(one.nextCursor).not.toBeNull();
      const two = invoicePageSchema.parse(
        (
          await t
            .as(buyer)
            .get(`/api/me/invoices?limit=2&cursor=${one.nextCursor}`)
        ).body,
      );
      expect(two.items).toHaveLength(1);
      expect(two.nextCursor).toBeNull();
      expect((await t.http().get('/api/me/invoices')).status).toBe(401);
    });

    it('S17 AS-80: the detail shows the lines; a foreign or unknown invoice is the same 404, for shops and buyers', async () => {
      const fs = await createFs(t, { plan: 'pro', quantity: 2 });
      const [invoice] = await rows<{ id: string }>(
        `SELECT id FROM "Invoice" WHERE "subscriptionId" = :id`,
        { id: fs.subscriptionId },
      );
      const res = await t
        .as(fs.owner)
        .get(`/api/shops/${fs.shopId}/invoices/${invoice.id}`);
      expectStatus(res, 200);
      const detail = invoiceSchema.parse(res.body);
      expect(detail).toMatchObject({
        id: invoice.id,
        status: 'PAID',
        attempts: 1,
        nextAttemptAt: null,
        totalMinor: 19800,
        lines: [
          { kind: 'PLAN', description: 'Pro', quantity: 2, amountMinor: 19800 },
        ],
      });
      expect(detail.paidAt).not.toBeNull();

      const bo = await t.shopWithOwner();
      await t.reauth(bo.owner);
      const other = await createFs(t, {
        owner: bo.owner,
        shopId: bo.shopId,
        at: '2026-04-01T00:00:00.000Z',
      });
      const [theirs] = await rows<{ id: string }>(
        `SELECT id FROM "Invoice" WHERE "subscriptionId" = :id`,
        { id: other.subscriptionId },
      );
      await t.reauth(fs.owner);
      const foreign = await t
        .as(fs.owner)
        .get(`/api/shops/${fs.shopId}/invoices/${theirs.id}`);
      const unknown = await t
        .as(fs.owner)
        .get(
          `/api/shops/${fs.shopId}/invoices/00000000-0000-4000-8000-000000000000`,
        );
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(strip(foreign)).toEqual(strip(unknown));

      const buyer = await t.newUser();
      const stranger = await t.newUser();
      expectStatus(
        await subscribeBuyer(t, buyer, {
          priceId: await t.priceId('plus'),
          paymentMethodRef: 'pm_ok',
        }),
        201,
      );
      const [mine] = await rows<{ id: string }>(
        `SELECT i.id FROM "Invoice" i JOIN "Subscription" s ON s.id = i."subscriptionId" WHERE s."subjectId" = :id`,
        { id: buyer.id },
      );
      expect(
        (await t.as(buyer).get(`/api/me/invoices/${mine.id}`)).status,
      ).toBe(200);
      const notYours = await t.as(stranger).get(`/api/me/invoices/${mine.id}`);
      expect(notYours.status).toBe(404);
      expect(strip(notYours)).toEqual(strip(unknown));
    });

    it('S17 SC-006: across every subscription and invoice route, a foreign shop answers the same 404 and nothing changes', async () => {
      const mine = await createFs(t);
      const bo = await t.shopWithOwner();
      await t.reauth(mine.owner);
      const id = bo.shopId;
      const before = {
        subs: await rows(`SELECT * FROM "Subscription" ORDER BY id`),
        invoices: Number(
          (await rows<{ n: string }>(`SELECT count(*) AS n FROM "Invoice"`))[0]
            .n,
        ),
      };
      const body = {
        priceId: await t.priceId('pro'),
        paymentMethodRef: 'pm_ok',
      };
      const calls = [
        t.as(mine.owner).get(`/api/shops/${id}/subscription`),
        t
          .as(mine.owner)
          .post(`/api/shops/${id}/subscription`)
          .set('Idempotency-Key', key())
          .send(body),
        t
          .as(mine.owner)
          .post(`/api/shops/${id}/subscription/preview`)
          .send({ priceId: body.priceId }),
        t
          .as(mine.owner)
          .post(`/api/shops/${id}/subscription/change`)
          .set('Idempotency-Key', key())
          .send({ priceId: body.priceId }),
        t.as(mine.owner).post(`/api/shops/${id}/subscription/cancel`).send({}),
        t.as(mine.owner).post(`/api/shops/${id}/subscription/resume`).send({}),
        t
          .as(mine.owner)
          .put(`/api/shops/${id}/subscription/payment-method`)
          .send({ paymentMethodRef: 'pm_x' }),
        t.as(mine.owner).get(`/api/shops/${id}/invoices`),
        t
          .as(mine.owner)
          .get(
            `/api/shops/${id}/invoices/00000000-0000-4000-8000-000000000000`,
          ),
      ];
      const answers = await Promise.all(calls);
      for (const res of answers) expect(res.status).toBe(404);
      const unknown = await t
        .as(mine.owner)
        .get('/api/shops/00000000-0000-4000-8000-0000000000aa/subscription');
      for (const res of answers)
        expect({
          ...res.body,
          instance: undefined,
          requestId: undefined,
        }).toEqual(strip(unknown));
      expect(await rows(`SELECT * FROM "Subscription" ORDER BY id`)).toEqual(
        before.subs,
      );
      expect(
        Number(
          (await rows<{ n: string }>(`SELECT count(*) AS n FROM "Invoice"`))[0]
            .n,
        ),
      ).toBe(before.invoices);
    });
  });

  describe('S17 AS-81: plan tier events are versioned per shop', () => {
    const tierEvents = async (shopId: string) =>
      (await t.outbox('billing.subscription_plan_changed')).filter(
        (e) => e.payload.shopId === shopId,
      );

    it('S17 AS-81: PRO v1, STARTER v2, PRO v3 across subscriptions; none when the tier does not change', async () => {
      const made = await t.shopWithOwner();
      await t.reauth(made.owner);
      const owner: TestUser = made.owner;
      const pro = await t.priceId('pro');
      const starter = await t.priceId('starter');
      expectStatus(
        await subscribeShop(t, owner, made.shopId, {
          priceId: pro,
          paymentMethodRef: 'pm_ok',
        }),
        201,
      );
      expectStatus(
        await t
          .as(owner)
          .post(`/api/shops/${made.shopId}/subscription/cancel`)
          .send({ immediately: true }),
        200,
      );
      expectStatus(
        await subscribeShop(t, owner, made.shopId, {
          priceId: pro,
          paymentMethodRef: 'pm_ok',
        }),
        201,
      );
      expect(
        (await tierEvents(made.shopId)).map((e) => [
          e.payload.plan,
          e.payload.version,
        ]),
      ).toEqual([
        ['PRO', 1],
        ['STARTER', 2],
        ['PRO', 3],
      ]);

      // starter -> starter, a price change within a plan: no event
      const other = await t.shopWithOwner();
      await t.reauth(other.owner);
      expectStatus(
        await subscribeShop(t, other.owner, other.shopId, {
          priceId: starter,
          paymentMethodRef: 'pm_ok',
        }),
        201,
      );
      expectStatus(
        await t
          .as(other.owner)
          .post(`/api/shops/${other.shopId}/subscription/cancel`)
          .send({ immediately: true }),
        200,
      );
      expectStatus(
        await subscribeShop(t, other.owner, other.shopId, {
          priceId: starter,
          paymentMethodRef: 'pm_ok',
        }),
        201,
      );
      expect(
        (await tierEvents(other.shopId)).map((e) => [
          e.payload.plan,
          e.payload.version,
        ]),
      ).toEqual([['STARTER', 1]]);
      const fs = await createFs(t, { at: '2026-04-01T00:00:00.000Z' });
      await t.drainJobs();
      expect(
        (await tierEvents(fs.shopId)).map((e) => e.payload.version),
      ).toEqual([1]);
    });

    it('S17 AS-81: every event is keyed by the subject and carries the whole envelope', async () => {
      const fs = await createFs(t, { plan: 'pro' });
      await t.drainJobs();
      const all = await rows<{
        type: string;
        aggregateId: string;
        payload: Record<string, any>;
      }>(
        `SELECT type, "aggregateId", payload FROM "Outbox" WHERE type LIKE 'billing.%'`,
      );
      expect(all.length).toBeGreaterThanOrEqual(3);
      for (const row of all) {
        const envelope = eventEnvelopeSchema.parse(row.payload);
        expect(envelope).toMatchObject({
          aggregateType: 'billing',
          aggregateId: fs.shopId,
          version: 1,
        });
        expect(row.aggregateId).toBe(fs.shopId);
      }
      expect(new Set(all.map((r) => r.type))).toEqual(
        new Set([
          'billing.subscription_status_changed',
          'billing.subscription_plan_changed',
          'billing.invoice_paid',
        ]),
      );
    });

    it('S17 AS-81: the counter never repeats or skips under concurrent changes', async () => {
      const shopId = (await t.shopWithOwner()).shopId;
      const state = t.app.get<PlanStateRepository>(PLAN_STATE_REPOSITORY);
      const tx = t.app.get(TransactionRunner);
      const tiers = ['PRO', 'STARTER', 'ENTERPRISE'] as const;
      const results = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          tx.run(() =>
            state.bump(
              { subjectType: 'SHOP', subjectId: shopId },
              tiers[i % 3],
              t.clock.now(),
            ),
          ),
        ),
      );
      const versions = results
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);
      expect(versions).toEqual(versions.map((_, i) => i + 1));
      const [row] = await rows<{ planVersion: number }>(
        `SELECT "planVersion" FROM "SubjectPlanState" WHERE "subjectId" = :id`,
        { id: shopId },
      );
      expect(row.planVersion).toBe(versions.length);
      // the same tier again is not a change
      const current = (
        await rows<{ tier: 'PRO' | 'STARTER' | 'ENTERPRISE' }>(
          `SELECT tier FROM "SubjectPlanState" WHERE "subjectId" = :id`,
          { id: shopId },
        )
      )[0].tier;
      expect(
        await tx.run(() =>
          state.bump(
            { subjectType: 'SHOP', subjectId: shopId },
            current,
            t.clock.now(),
          ),
        ),
      ).toBeNull();
    });
  });

  describe('S17 the basis S18 reads', () => {
    it('S17 AS-78: the live basis exists for trialing, active and past-due subscriptions and not for unpaid or cancelled ones', async () => {
      const basis = t.app.get(SubscriptionBasisService);
      const active = await createFs(t, { plan: 'pro' });
      const pastDue = await createFs(t, { paymentMethodRef: 'pm_declined' });
      const cancelled = await createFs(t);
      await t.reauth(cancelled.owner);
      expectStatus(
        await t
          .as(cancelled.owner)
          .post(`/api/shops/${cancelled.shopId}/subscription/cancel`)
          .send({ immediately: true }),
        200,
      );
      const found = await basis.getLiveBasis('SHOP', active.shopId);
      expect(found).toMatchObject({
        subscriptionId: active.subscriptionId,
        status: 'ACTIVE',
        planCode: 'pro',
        subscriptionVersion: 0,
      });
      expect(found?.entitlements).toMatchObject({ auctions: true });
      expect((await basis.getLiveBasis('SHOP', pastDue.shopId))?.status).toBe(
        'PAST_DUE',
      );
      expect(await basis.getLiveBasis('SHOP', cancelled.shopId)).toBeNull();
      const many = await basis.getLiveBasisBySubjectIds('SHOP', [
        active.shopId,
        pastDue.shopId,
        cancelled.shopId,
        active.shopId,
      ]);
      expect([...many.keys()].sort()).toEqual(
        [active.shopId, pastDue.shopId].sort(),
      );
      await expect(
        basis.getLiveBasisBySubjectIds(
          'SHOP',
          Array.from(
            { length: 501 },
            (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          ),
        ),
      ).rejects.toThrow();
    });
  });
});
