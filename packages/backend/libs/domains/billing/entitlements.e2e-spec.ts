import { Controller, Get, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { v4 as uuidv4 } from 'uuid';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import {
  EntitlementGuardValidator,
  RequiresShopEntitlement,
} from './application/entitlement.guard';
import { EntitlementsService } from './application/entitlements.service';
import { SubscriptionBasisService } from './application/subscription-basis.service';
import { USAGE_STORE, type UsageStorePort } from './domain/ports';
import { FREE_BUYER, FREE_SHOP } from './domain/entitlements';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import {
  EntitlementFixtureModule,
  fixtureHits,
} from './testing/entitlement-fixture';
import {
  S18_PLANS,
  applyS18Plans,
  moveSubscription,
  seedSubscription,
} from './testing/billing-seed';

const NOW = '2026-04-10T12:00:00.000Z';

describe('Billing: entitlement checks', () => {
  let t: BillingTestApp;
  let entitlements: EntitlementsService;
  let basis: SubscriptionBasisService;
  let store: UsageStorePort;

  beforeAll(async () => {
    t = await createBillingApp({
      realUsage: true,
      extraImports: [EntitlementFixtureModule],
    });
    entitlements = t.app.get(EntitlementsService, { strict: false });
    basis = t.app.get(SubscriptionBasisService, { strict: false });
    store = t.app.get<UsageStorePort>(USAGE_STORE, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    await applyS18Plans(t);
    t.clock.set(new Date(NOW));
    fixtureHits.guarded = 0;
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const shop = () => uuidv4();
  const rejects = (promise: Promise<unknown>, code: string) =>
    expect(promise).rejects.toMatchObject({ code });
  /** A subject of the DS-1 dataset: a seeded subscription of `plan` in `status`. */
  const subject = async (
    subjectType: 'SHOP' | 'USER',
    plan: 'starter' | 'pro' | 'plus',
    status:
      'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'UNPAID' | 'CANCELED' = 'ACTIVE',
    version = 0,
  ) => {
    const subjectId = uuidv4();
    const sub = await seedSubscription(t, {
      subjectType,
      subjectId,
      plan,
      status,
      version,
    });
    return { subjectId, ...sub };
  };

  describe('S18 AS-01 / AS-02: what a subject may do', () => {
    it('S18 AS-01: a live subscription returns exactly its plan entitlements (ACTIVE, PAST_DUE, TRIALING)', async () => {
      const a = await subject('SHOP', 'pro', 'ACTIVE', 3);
      const c = await subject('SHOP', 'starter', 'PAST_DUE', 5);
      const trialing = await subject('SHOP', 'starter', 'TRIALING');
      const u = await subject('USER', 'plus');

      expect(await entitlements.get('SHOP', a.subjectId)).toEqual(
        S18_PLANS.pro,
      );
      expect(await entitlements.get('USER', u.subjectId)).toEqual(
        S18_PLANS.plus,
      );
      // the grace period keeps access
      expect(await entitlements.get('SHOP', c.subjectId)).toEqual(
        S18_PLANS.starter,
      );
      expect(await entitlements.get('SHOP', trialing.subjectId)).toEqual(
        S18_PLANS.starter,
      );
    });

    it('S18 AS-02: UNPAID, no subscription and CANCELED fall back to the free shop tier; a buyer without one gets the free buyer tier', async () => {
      const d = await subject('SHOP', 'starter', 'UNPAID');
      const canceled = await subject('SHOP', 'pro', 'CANCELED');
      const e = shop();
      const w = uuidv4();

      for (const id of [d.subjectId, canceled.subjectId, e])
        expect(await entitlements.get('SHOP', id)).toEqual(FREE_SHOP);
      // research R-2: the buyer tier carries the assistant allowance S46 relies on (deviation from DS-1 `{}`)
      expect(await entitlements.get('USER', w)).toEqual(FREE_BUYER);
      expect(await entitlements.get('USER', w)).toEqual({
        assistantTokensPerMonth: 200000,
      });
    });

    it('S18 AS-03 / AS-04: the boolean check over the service follows the entitlements', async () => {
      const a = await subject('SHOP', 'pro');
      const c = await subject('SHOP', 'starter', 'PAST_DUE');
      const e = shop();
      const u = await subject('USER', 'plus');
      const w = uuidv4();
      expect(
        await entitlements.hasEntitlement('SHOP', a.subjectId, 'auctions'),
      ).toBe(true);
      expect(
        await entitlements.hasEntitlement('SHOP', c.subjectId, 'auctions'),
      ).toBe(false);
      expect(await entitlements.hasEntitlement('SHOP', e, 'auctions')).toBe(
        false,
      );
      expect(await entitlements.hasEntitlement('SHOP', e, 'seats')).toBe(true);
      expect(
        await entitlements.hasEntitlement('SHOP', e, 'assistantTokensPerMonth'),
      ).toBe(false);
      expect(
        await entitlements.hasEntitlement('USER', u.subjectId, 'freeShipping'),
      ).toBe(true);
      expect(await entitlements.hasEntitlement('USER', w, 'freeShipping')).toBe(
        false,
      );
    });

    it('S18 AS-05: an unknown feature rejects unknown_entitlement and reads nothing', async () => {
      const spy = jest.spyOn(basis, 'getLiveBasisBySubjectIds');
      const id = shop();
      await rejects(
        entitlements.hasEntitlement('SHOP', id, 'teleport' as never),
        'unknown_entitlement',
      );
      await rejects(
        entitlements.checkLimit('SHOP', id, 'teleport' as never, 0),
        'unknown_entitlement',
      );
      await rejects(
        entitlements.checkQuota('SHOP', id, 'teleport' as never),
        'unknown_entitlement',
      );
      await rejects(
        entitlements.checkLimit('SHOP', id, 'auctions' as never, 0),
        'not_a_limit',
      );
      await rejects(
        entitlements.checkQuota('SHOP', id, 'maxProducts' as never),
        'not_a_quota',
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it('S18 AS-07: checkLimit answers from the live plan', async () => {
      const a = await subject('SHOP', 'pro');
      const e = shop();
      const w = uuidv4();
      expect(
        await entitlements.checkLimit('SHOP', a.subjectId, 'maxProducts', 9999),
      ).toEqual({
        allowed: true,
        limit: 10000,
        remaining: 1,
      });
      expect(
        await entitlements.checkLimit(
          'SHOP',
          a.subjectId,
          'maxProducts',
          10000,
        ),
      ).toEqual({
        allowed: false,
        limit: 10000,
        remaining: 0,
      });
      expect(
        await entitlements.checkLimit('SHOP', e, 'maxProducts', 10),
      ).toEqual({
        allowed: false,
        limit: 10,
        remaining: 0,
      });
      expect(
        await entitlements.checkLimit('USER', w, 'maxProducts', 0),
      ).toEqual({
        allowed: false,
        limit: 0,
        remaining: 0,
      });
      await rejects(
        entitlements.checkLimit('SHOP', e, 'maxProducts', -1),
        'invalid_current_value',
      );
      await rejects(
        entitlements.checkLimit('SHOP', e, 'maxProducts', 1.5),
        'invalid_current_value',
      );
    });
  });

  describe('S18 AS-06: batch read', () => {
    it('S18 AS-06: one batch call to the basis source, duplicates collapsed, answers equal the single reads', async () => {
      const a = await subject('SHOP', 'pro');
      const c = await subject('SHOP', 'starter', 'PAST_DUE');
      const d = await subject('SHOP', 'starter', 'UNPAID');
      const e = shop();
      const spy = jest.spyOn(basis, 'getLiveBasisBySubjectIds');

      const many = await entitlements.getMany('SHOP', [
        a.subjectId,
        c.subjectId,
        d.subjectId,
        e,
        a.subjectId,
      ]);

      expect(many.size).toBe(4);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe('SHOP');
      expect([...spy.mock.calls[0][1]].sort()).toEqual(
        [a.subjectId, c.subjectId, d.subjectId, e].sort(),
      );
      expect(many.get(a.subjectId)).toEqual(S18_PLANS.pro);
      expect(many.get(c.subjectId)).toEqual(S18_PLANS.starter);
      expect(many.get(d.subjectId)).toEqual(FREE_SHOP);
      expect(many.get(e)).toEqual(FREE_SHOP);
      for (const id of [a.subjectId, c.subjectId, d.subjectId, e])
        expect(many.get(id)).toEqual(await entitlements.get('SHOP', id));
    });

    it('S18 AS-06: an empty list returns an empty map and makes no call', async () => {
      const spy = jest.spyOn(basis, 'getLiveBasisBySubjectIds');
      expect((await entitlements.getMany('SHOP', [])).size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it('S18 AS-06: 500 distinct ids are read; 501 reject too_many_ids and nothing is read', async () => {
      const spy = jest.spyOn(basis, 'getLiveBasisBySubjectIds');
      const ids = Array.from({ length: 500 }, () => uuidv4());
      expect((await entitlements.getMany('SHOP', ids)).size).toBe(500);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      await rejects(
        entitlements.getMany('SHOP', [...ids, uuidv4()]),
        'too_many_ids',
      );
      expect(spy).not.toHaveBeenCalled();
      // duplicates do not count towards the limit
      expect((await entitlements.getMany('SHOP', [...ids, ...ids])).size).toBe(
        500,
      );
    });
  });

  describe('S18 AS-08: monthly quota', () => {
    const usage = (
      subjectId: string,
      metric: string,
      quantity: number,
      ts: string,
    ) =>
      store.insert(
        [{ identity: uuidv4(), subjectId, metric, quantity, ts: new Date(ts) }],
        new Date(ts),
      );

    it('S18 AS-08: the plan limit against the exact usage of the current UTC month', async () => {
      const a = await subject('SHOP', 'pro');
      await usage(a.subjectId, 'api.calls', 12500, '2026-04-09T10:00:00.000Z');
      expect(
        await entitlements.checkQuota('SHOP', a.subjectId, 'apiCallsPerMonth'),
      ).toEqual({
        allowed: true,
        used: 12500,
        limit: 1000000,
        resetsAt: '2026-05-01T00:00:00.000Z',
      });
    });

    it('S18 AS-08: a shop on the free tier at its quota is not allowed', async () => {
      const e = shop();
      await usage(e, 'api.calls', 1000, '2026-04-02T10:00:00.000Z');
      expect(
        await entitlements.checkQuota('SHOP', e, 'apiCallsPerMonth'),
      ).toEqual({
        allowed: false,
        used: 1000,
        limit: 1000,
        resetsAt: '2026-05-01T00:00:00.000Z',
      });
    });

    it('S18 AS-08: the window is the calendar month: usage of April does not count in May, the reset moves to June', async () => {
      const a = await subject('SHOP', 'pro');
      await usage(a.subjectId, 'api.calls', 12500, '2026-04-30T23:59:59.999Z');
      await usage(a.subjectId, 'api.calls', 7, '2026-05-01T00:00:00.000Z');
      t.clock.set(new Date('2026-05-02T08:00:00.000Z'));
      expect(
        await entitlements.checkQuota('SHOP', a.subjectId, 'apiCallsPerMonth'),
      ).toEqual({
        allowed: true,
        used: 7,
        limit: 1000000,
        resetsAt: '2026-06-01T00:00:00.000Z',
      });
    });

    it('S18 AS-08: assistantTokensPerMonth counts the llm.assistant.tokens metric', async () => {
      const u = await subject('USER', 'plus');
      await usage(
        u.subjectId,
        'llm.assistant.tokens',
        300000,
        '2026-04-05T10:00:00.000Z',
      );
      await usage(u.subjectId, 'api.calls', 999, '2026-04-05T10:00:00.000Z');
      expect(
        await entitlements.checkQuota(
          'USER',
          u.subjectId,
          'assistantTokensPerMonth',
        ),
      ).toEqual({
        allowed: true,
        used: 300000,
        limit: 2000000,
        resetsAt: '2026-05-01T00:00:00.000Z',
      });
    });

    it('S18 AS-08: when the usage store fails the call rejects usage_unavailable (VII.9)', async () => {
      const a = await subject('SHOP', 'pro');
      const clickhouse = t.app.get(ClickHouseService, { strict: false });
      const spy = jest
        .spyOn(clickhouse, 'query')
        .mockRejectedValue(new Error('connection refused'));
      try {
        await rejects(
          entitlements.checkQuota('SHOP', a.subjectId, 'apiCallsPerMonth'),
          'usage_unavailable',
        );
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      // restored: the same call answers again
      expect(
        (await entitlements.checkQuota('SHOP', a.subjectId, 'apiCallsPerMonth'))
          .used,
      ).toBe(0);
    });
  });

  describe('S18 AS-09 / AS-10 / AS-11: the route guard', () => {
    const guarded = (shopId: string) => `/api/fixture/shops/${shopId}/guarded`;

    it('S18 AS-09: a member of a shop whose plan has the feature reaches the handler', async () => {
      const { shopId, owner } = await t.shopWithOwner();
      await seedSubscription(t, {
        subjectType: 'SHOP',
        subjectId: shopId,
        plan: 'pro',
      });
      const viewer = await t.member(shopId, 'VIEWER');

      const ann = await t.as(owner).get(guarded(shopId));
      expect(ann.status).toBe(200);
      expect(ann.body).toEqual({ ok: true });
      expect((await t.as(viewer).get(guarded(shopId))).status).toBe(200);
      expect(fixtureHits.guarded).toBe(2);
    });

    it.each([
      ['a shop on a plan without the feature', 'starter'],
      ['a shop with no subscription', null],
    ] as const)(
      'S18 AS-09: %s answers 403 entitlement_required with the feature and the handler did not run',
      async (_name, plan) => {
        const { shopId, owner } = await t.shopWithOwner();
        if (plan)
          await seedSubscription(t, {
            subjectType: 'SHOP',
            subjectId: shopId,
            plan,
            status: 'PAST_DUE',
          });

        const res = await t.as(owner).get(guarded(shopId));

        expect(res.status).toBe(403);
        const problem = problemDetailsSchema.parse(res.body);
        expect(problem.code).toBe('entitlement_required');
        expect(problem.feature).toBe('auctions');
        expect(fixtureHits.guarded).toBe(0);
      },
    );

    it('S18 AS-09: a non-member gets 404 (membership first) and no credentials get 401', async () => {
      const a = await t.shopWithOwner();
      await seedSubscription(t, {
        subjectType: 'SHOP',
        subjectId: a.shopId,
        plan: 'pro',
      });
      const bo = await t.shopWithOwner();

      const foreign = await t.as(bo.owner).get(guarded(a.shopId));
      expect(foreign.status).toBe(404);
      // the same body as for a shop that does not exist: no entitlement information leaks
      const unknown = await t.as(bo.owner).get(guarded(uuidv4()));
      expect(unknown.status).toBe(404);
      expect({ ...foreign.body, instance: '', requestId: '' }).toEqual({
        ...unknown.body,
        instance: '',
        requestId: '',
      });

      expect((await t.http().get(guarded(a.shopId))).status).toBe(401);
      expect(fixtureHits.guarded).toBe(0);
    });

    it('S18 AS-10: a guarded handler without shop scoping prevents start-up and names the route', async () => {
      @Controller('misconfigured')
      class MisconfiguredController {
        @RequiresShopEntitlement('auctions')
        @Get('no-shop')
        noShop() {
          return { ok: true };
        }
      }
      @Module({
        imports: [DiscoveryModule],
        controllers: [MisconfiguredController],
        providers: [
          EntitlementGuardValidator,
          { provide: EntitlementsService, useValue: {} },
        ],
      })
      class BadModule {}

      const compiled = await Test.createTestingModule({
        imports: [BadModule],
      }).compile();
      await expect(compiled.init()).rejects.toThrow(
        /MisconfiguredController\.noShop/,
      );
      await compiled.close().catch(() => undefined);
    });

    it('S18 AS-10: a feature key outside the allowlist is refused where the route is declared', () => {
      expect(() => RequiresShopEntitlement('teleport' as never)).toThrow(
        /teleport/,
      );
    });

    it('S18 AS-11: with the basis source down and nothing cached the service rejects entitlements_unavailable and never answers the free tier', async () => {
      const a = await subject('SHOP', 'pro');
      jest
        .spyOn(basis, 'getLiveBasisBySubjectIds')
        .mockRejectedValue(new Error('relation "Subscription" does not exist'));

      await rejects(
        entitlements.get('SHOP', a.subjectId),
        'entitlements_unavailable',
      );
      await rejects(
        entitlements.hasEntitlement('SHOP', a.subjectId, 'auctions'),
        'entitlements_unavailable',
      );
    });

    it('S18 AS-11: the guard answers 503 entitlements_unavailable with a generic detail and the handler did not run', async () => {
      const { shopId, owner } = await t.shopWithOwner();
      await seedSubscription(t, {
        subjectType: 'SHOP',
        subjectId: shopId,
        plan: 'pro',
      });
      jest
        .spyOn(basis, 'getLiveBasisBySubjectIds')
        .mockRejectedValue(new Error('relation "Subscription" does not exist'));

      const res = await t.as(owner).get(guarded(shopId));

      expect(res.status).toBe(503);
      const problem = problemDetailsSchema.parse(res.body);
      expect(problem.code).toBe('entitlements_unavailable');
      expect(JSON.stringify(res.body)).not.toMatch(
        /relation|Subscription|stack/,
      );
      expect(fixtureHits.guarded).toBe(0);
    });

    it('S18 AS-01: a changed subscription is visible after the entry is dropped (the direct call S17 makes after commit)', async () => {
      const e = await subject('SHOP', 'starter', 'ACTIVE', 1);
      expect(await entitlements.get('SHOP', e.subjectId)).toEqual(
        S18_PLANS.starter,
      );
      await moveSubscription(t, e.id, { status: 'CANCELED', version: 2 });
      await entitlements.invalidate('SHOP', e.subjectId);
      expect(await entitlements.get('SHOP', e.subjectId)).toEqual(FREE_SHOP);
    });
  });
});
