import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { subscriptionReadSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CacheService, cacheKey } from '@app/infrastructure/cache';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { SubscriptionStatusChanged } from './application/events/billing-events';
import { EntitlementsService } from './application/entitlements.service';
import { SubscriptionBasisService } from './application/subscription-basis.service';
import { FREE_SHOP } from './domain/entitlements';
import type { CachedEntitlements } from './domain/ports';
import { SubscriptionStatusConsumer } from './infra/usage.consumers';
import { createBillingApp, type BillingTestApp } from './testing/billing-app';
import { createFs, expectStatus } from './testing/billing-flows';
import {
  S18_PLANS,
  applyS18Plans,
  moveSubscription,
  seedSubscription,
} from './testing/billing-seed';

const NOW = '2026-04-10T12:00:00.000Z';
const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;
const invalidations = (outcome: string) =>
  metric('entitlement_invalidations_total', { outcome });

const keyOf = (type: 'SHOP' | 'USER', id: string) =>
  cacheKey('entitlements', 1, type, id);

/** A promise settled from outside, to hold a basis call in flight. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

describe('Billing: entitlement cache and invalidation', () => {
  let t: BillingTestApp;
  let entitlements: EntitlementsService;
  let basis: SubscriptionBasisService;
  let cache: CacheService;
  let real: SubscriptionBasisService['getLiveBasisBySubjectIds'];

  beforeAll(async () => {
    t = await createBillingApp({ realUsage: true });
    entitlements = t.app.get(EntitlementsService, { strict: false });
    basis = t.app.get(SubscriptionBasisService, { strict: false });
    cache = t.app.get(CacheService, { strict: false });
    real = basis.getLiveBasisBySubjectIds.bind(basis);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    await applyS18Plans(t);
    t.clock.set(new Date(NOW));
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const delivery = () => t.deliver(SubscriptionStatusConsumer);
  const statusEvent = (
    over: {
      subscriptionId: string;
      subjectId: string;
      version: number;
      subjectType?: string;
      status?: string;
    },
    eventId: string = uuidv7(),
  ) => ({
    ...SubscriptionStatusChanged.create(over.subjectId, over.version, {
      subscriptionId: over.subscriptionId,
      subjectType: (over.subjectType ?? 'SHOP') as 'SHOP',
      subjectId: over.subjectId,
      status: over.status ?? 'ACTIVE',
      from: 'TRIALING',
      planCode: 'pro',
      subscriptionVersion: over.version,
    }),
    eventId,
  });
  const cached = (type: 'SHOP' | 'USER', id: string) =>
    cache.peek<CachedEntitlements>(keyOf(type, id));

  /** A shop with a seeded subscription at `version`, already read once so its entry is cached. */
  async function warm(plan: 'pro' | 'starter' = 'pro', version = 7) {
    const subjectId = uuidv4();
    const sub = await seedSubscription(t, {
      subjectType: 'SHOP',
      subjectId,
      plan,
      version,
    });
    await entitlements.get('SHOP', subjectId);
    return { subjectId, ...sub };
  }

  describe('S18 AS-12 / AS-13: cache-aside and stampede', () => {
    it('S18 AS-12: two reads within 300 s load once, +301 s loads again; the entry carries the basis version (null for the free tier)', async () => {
      const subjectId = uuidv4();
      const a = {
        subjectId,
        ...(await seedSubscription(t, {
          subjectType: 'SHOP',
          subjectId,
          plan: 'pro',
          version: 3,
        })),
      };
      const spy = jest.spyOn(basis, 'getLiveBasisBySubjectIds');

      expect(await entitlements.get('SHOP', a.subjectId)).toEqual(
        S18_PLANS.pro,
      );
      t.clock.advance(100_000);
      expect(await entitlements.get('SHOP', a.subjectId)).toEqual(
        S18_PLANS.pro,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await cached('SHOP', a.subjectId))?.value).toMatchObject({
        entitlements: S18_PLANS.pro,
        subscriptionId: a.id,
        subscriptionVersion: 3,
      });

      t.clock.advance(201_000); // 301 s after the load
      expect(await entitlements.get('SHOP', a.subjectId)).toEqual(
        S18_PLANS.pro,
      );
      expect(spy).toHaveBeenCalledTimes(2);

      const free = uuidv4();
      await entitlements.get('SHOP', free);
      expect((await cached('SHOP', free))?.value).toMatchObject({
        entitlements: FREE_SHOP,
        subscriptionId: null,
        subscriptionVersion: null,
      });
    });

    it('S18 AS-13: 50 concurrent cold reads cause exactly one basis call and get the same answer', async () => {
      const a = await warmless();
      const spy = jest
        .spyOn(basis, 'getLiveBasisBySubjectIds')
        .mockImplementation(async (...args) => {
          await new Promise((r) => setTimeout(r, 50));
          return real(...args);
        });

      const answers = await Promise.all(
        Array.from({ length: 50 }, () => entitlements.get('SHOP', a)),
      );

      expect(spy).toHaveBeenCalledTimes(1);
      expect(
        answers.every((x) => JSON.stringify(x) === JSON.stringify(answers[0])),
      ).toBe(true);
      expect(answers[0]).toEqual(S18_PLANS.pro);
    });

    async function warmless() {
      const id = uuidv4();
      await seedSubscription(t, {
        subjectType: 'SHOP',
        subjectId: id,
        plan: 'pro',
      });
      return id;
    }
  });

  describe('S18 AS-14: direct invalidation after a committed change', () => {
    it('S18 AS-14: after S17 commits a subscription the next read returns the new plan with one basis call', async () => {
      const e = uuidv4();
      expect(await entitlements.get('SHOP', e)).toEqual(FREE_SHOP);
      const sub = await seedSubscription(t, {
        subjectType: 'SHOP',
        subjectId: e,
        plan: 'pro',
        version: 1,
      });
      const spy = jest.spyOn(basis, 'getLiveBasisBySubjectIds');
      // what S17 does after its commit
      await entitlements.invalidate('SHOP', e, {
        subscriptionId: sub.id,
        subscriptionVersion: 1,
      });
      expect(await entitlements.get('SHOP', e)).toEqual(S18_PLANS.pro);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('S18 AS-14: a shop that subscribes through the API has its plan within 5 s of the commit', async () => {
      const { shopId, owner } = await t.shopWithOwner();
      expect(await entitlements.get('SHOP', shopId)).toEqual(FREE_SHOP);
      t.clock.set(new Date('2026-04-01T00:00:00.000Z'));
      await createFs(t, { owner, shopId, at: '2026-04-01T00:00:00.000Z' });

      expect(await entitlements.get('SHOP', shopId)).toEqual(S18_PLANS.starter);
      const res = await t.as(owner).get(`/api/shops/${shopId}/subscription`);
      expectStatus(res, 200);
      const read = subscriptionReadSchema.parse(res.body);
      expect(read.subscription?.status).toBe('ACTIVE');
      expect(read.entitlements).toEqual(S18_PLANS.starter);
    });
  });

  describe('S18 AS-15 / AS-16 / AS-18: the status-changed consumer', () => {
    it('S18 AS-15: the event drops the entry, and a second delivery of the same event id changes nothing', async () => {
      const e = await warm('starter', 3);
      await moveSubscription(t, e.id, { version: 4 });
      const applied = invalidations('applied');
      const event = statusEvent({
        subscriptionId: e.id,
        subjectId: e.subjectId,
        version: 4,
      });

      const first = await delivery().deliver(event);
      expect(first.counts.applied).toBe(1);
      expect(await cached('SHOP', e.subjectId)).toBeNull();
      expect(invalidations('applied')).toBe(applied + 1);

      // reloaded by the next read
      expect(await entitlements.get('SHOP', e.subjectId)).toEqual(
        S18_PLANS.starter,
      );
      const second = await delivery().deliver(event);
      expect(second.counts.duplicate).toBe(1);
      expect(await cached('SHOP', e.subjectId)).not.toBeNull();
      expect(invalidations('applied')).toBe(applied + 1);
    });

    it('S18 AS-16: an older event of the same subscription is ignored, a newer one drops the entry', async () => {
      const e = await warm('pro', 7);
      const spy = jest.spyOn(basis, 'getLiveBasisBySubjectIds');
      const stale = invalidations('stale_event');

      const old = await delivery().deliver(
        statusEvent({
          subscriptionId: e.id,
          subjectId: e.subjectId,
          version: 5,
        }),
      );
      expect(old.counts.stale).toBe(1);
      expect(invalidations('stale_event')).toBe(stale + 1);
      expect(
        (await cached('SHOP', e.subjectId))?.value.subscriptionVersion,
      ).toBe(7);
      await entitlements.get('SHOP', e.subjectId);
      expect(spy).not.toHaveBeenCalled();

      // an equal version is not newer either
      await delivery().deliver(
        statusEvent({
          subscriptionId: e.id,
          subjectId: e.subjectId,
          version: 7,
        }),
      );
      expect(await cached('SHOP', e.subjectId)).not.toBeNull();

      await delivery().deliver(
        statusEvent({
          subscriptionId: e.id,
          subjectId: e.subjectId,
          version: 8,
        }),
      );
      expect(await cached('SHOP', e.subjectId)).toBeNull();
    });

    it('S18 AS-16: an event for a different subscription of the subject (a re-subscription) drops the entry whatever its version', async () => {
      const e = await warm('pro', 7);
      await delivery().deliver(
        statusEvent({
          subscriptionId: uuidv4(),
          subjectId: e.subjectId,
          version: 1,
        }),
      );
      expect(await cached('SHOP', e.subjectId)).toBeNull();
    });

    it('S18 AS-16: an event for a subject with no entry stores nothing and a later read loads fresh', async () => {
      const id = uuidv4();
      const sub = await seedSubscription(t, {
        subjectType: 'SHOP',
        subjectId: id,
        plan: 'pro',
        version: 2,
      });
      await delivery().deliver(
        statusEvent({ subscriptionId: sub.id, subjectId: id, version: 2 }),
      );
      expect(await cached('SHOP', id)).toBeNull();
      const spy = jest.spyOn(basis, 'getLiveBasisBySubjectIds');
      expect(await entitlements.get('SHOP', id)).toEqual(S18_PLANS.pro);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('S18 AS-18: invalid payloads are dead-lettered with a reason, the cache is untouched, and the next valid message is processed', async () => {
      const e = await warm('pro', 7);
      const spy = jest.spyOn(basis, 'getLiveBasisBySubjectIds');
      const good = statusEvent({
        subscriptionId: e.id,
        subjectId: e.subjectId,
        version: 8,
      });
      const clone = () => JSON.parse(JSON.stringify(good));
      const noSubject = clone();
      delete noSubject.payload.subjectId;
      const team = clone();
      team.payload.subjectType = 'TEAM';
      const fractional = clone();
      fractional.payload.subscriptionVersion = 1.5;
      const negative = clone();
      negative.payload.subscriptionVersion = -1;
      const notUuid = clone();
      notUuid.payload.subscriptionId = 'nope';

      const result = await delivery().deliver(
        noSubject,
        team,
        fractional,
        negative,
        notUuid,
      );

      expect(result.deadLetters).toHaveLength(5);
      expect(
        result.deadLetters.every(
          (d) => d.code === 'INVALID_PAYLOAD' && d.reason.length > 0,
        ),
      ).toBe(true);
      expect(result.counts).toEqual({ applied: 0, duplicate: 0, stale: 0 });
      expect(
        (await cached('SHOP', e.subjectId))?.value.subscriptionVersion,
      ).toBe(7);
      expect(spy).not.toHaveBeenCalled();

      const next = await delivery().deliver(good);
      expect(next.counts.applied).toBe(1);
      expect(await cached('SHOP', e.subjectId)).toBeNull();
    });
  });

  describe('S18 AS-17: a slow load never overwrites a newer state', () => {
    it('S18 AS-17: the in-flight caller gets the version-7 answer, it is not stored, and the next read loads version 8', async () => {
      const subjectId = uuidv4();
      const sub = await seedSubscription(t, {
        subjectType: 'SHOP',
        subjectId,
        plan: 'pro',
        version: 7,
      });
      const gate = deferred();
      let calls = 0;
      jest
        .spyOn(basis, 'getLiveBasisBySubjectIds')
        .mockImplementation(async (...args) => {
          calls++;
          const answer = await real(...args); // reads version 7
          if (calls === 1) await gate.promise;
          return answer;
        });

      const inFlight = entitlements.get('SHOP', subjectId);
      await new Promise((r) => setTimeout(r, 50)); // the basis call has read its answer and is held
      // meanwhile S17 commits the cancellation at version 8 and its event is processed
      await moveSubscription(t, sub.id, { status: 'CANCELED', version: 8 });
      const applied = await delivery().deliver(
        statusEvent({
          subscriptionId: sub.id,
          subjectId,
          version: 8,
          status: 'CANCELED',
        }),
      );
      expect(applied.counts.applied).toBe(1);
      gate.release();

      expect(await inFlight).toEqual(S18_PLANS.pro);
      expect(await cached('SHOP', subjectId)).toBeNull();
      expect(await entitlements.get('SHOP', subjectId)).toEqual(FREE_SHOP);
      expect(calls).toBe(2);
    });

    it('S18 AS-17: the direct invalidation of S17 carries the version too: a load that began before the commit does not resurrect the old plan', async () => {
      const subjectId = uuidv4();
      const sub = await seedSubscription(t, {
        subjectType: 'SHOP',
        subjectId,
        plan: 'pro',
        version: 7,
      });
      const gate = deferred();
      let calls = 0;
      jest
        .spyOn(basis, 'getLiveBasisBySubjectIds')
        .mockImplementation(async (...args) => {
          calls++;
          const answer = await real(...args);
          if (calls === 1) await gate.promise;
          return answer;
        });
      const inFlight = entitlements.get('SHOP', subjectId);
      await new Promise((r) => setTimeout(r, 50));
      await moveSubscription(t, sub.id, { status: 'CANCELED', version: 8 });
      await entitlements.invalidate('SHOP', subjectId, {
        subscriptionId: sub.id,
        subscriptionVersion: 8,
      });
      gate.release();
      await inFlight;
      expect(await entitlements.get('SHOP', subjectId)).toEqual(FREE_SHOP);
    });
  });

  describe('S18 AS-19: stale on error (VII.9)', () => {
    it('S18 AS-19: a failing source serves the entry up to 60 minutes old and counts it, then rejects entitlements_unavailable', async () => {
      const a = await warm('pro', 6);
      jest
        .spyOn(basis, 'getLiveBasisBySubjectIds')
        .mockRejectedValue(new Error('db down'));
      const stale = metric('entitlements_stale_served_total');

      t.clock.advance(6 * 60_000); // past the 300 s lifetime
      expect(await entitlements.get('SHOP', a.subjectId)).toEqual(
        S18_PLANS.pro,
      );
      expect(metric('entitlements_stale_served_total')).toBe(stale + 1);

      t.clock.advance(53 * 60_000); // 59 minutes old: still within the hour
      expect(await entitlements.get('SHOP', a.subjectId)).toEqual(
        S18_PLANS.pro,
      );

      t.clock.advance(2 * 60_000); // 61 minutes old
      await expect(entitlements.get('SHOP', a.subjectId)).rejects.toMatchObject(
        {
          code: 'entitlements_unavailable',
        },
      );
    });
  });

  describe('S18 AS-21: subjects are isolated', () => {
    it('S18 AS-21: the same id as a shop and as a user are two entries; invalidating one leaves the other', async () => {
      const id = uuidv4();
      const shop = await seedSubscription(t, {
        subjectType: 'SHOP',
        subjectId: id,
        plan: 'pro',
        version: 1,
      });
      await seedSubscription(t, {
        subjectType: 'USER',
        subjectId: id,
        plan: 'plus',
        version: 1,
      });
      expect(await entitlements.get('SHOP', id)).toEqual(S18_PLANS.pro);
      expect(await entitlements.get('USER', id)).toEqual(S18_PLANS.plus);

      await entitlements.invalidate('SHOP', id);

      expect(await cached('SHOP', id)).toBeNull();
      expect((await cached('USER', id))?.value.entitlements).toEqual(
        S18_PLANS.plus,
      );
      void shop;
    });
  });

  describe('S18 AS-20: the cache store is down (VII.9)', () => {
    let proxy: TcpFaultProxy;
    let d: BillingTestApp;
    let dEntitlements: EntitlementsService;

    beforeAll(async () => {
      const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
      proxy = await TcpFaultProxy.start({
        host: url.hostname,
        port: Number(url.port || 6379),
      });
      d = await createBillingApp({
        realUsage: true,
        redisUrl: `redis://127.0.0.1:${proxy.port}/${new URL(process.env.REDIS_URL ?? "redis://localhost:6400/0").pathname.slice(1) || "0"}`,
      });
      dEntitlements = d.app.get(EntitlementsService, { strict: false });
    });
    afterAll(async () => {
      proxy.mode = 'pass';
      await d?.close();
      await proxy?.close();
    });
    beforeEach(async () => {
      proxy.mode = 'pass';
      await d.reset();
      await applyS18Plans(d);
      d.clock.set(new Date(NOW));
    });
    afterEach(() => {
      proxy.mode = 'pass';
      d.clock.advance(60_000); // lets the store breaker close again
    });

    const cut = () => {
      proxy.mode = 'refuse';
      proxy.sever();
    };

    it('S18 AS-20: reads degrade to the source and answer correctly; the failure is counted, not raised', async () => {
      const id = uuidv4();
      await seedSubscription(d, {
        subjectType: 'SHOP',
        subjectId: id,
        plan: 'pro',
      });
      const errors = metric('entitlements_cache_errors_total');
      cut();

      expect(await dEntitlements.get('SHOP', id)).toEqual(S18_PLANS.pro);
      expect(metric('entitlements_cache_errors_total')).toBe(errors + 1);
    });

    it('S18 AS-20: invalidate and the event consumer do not swallow the failure; the event is redelivered and then applied', async () => {
      const id = uuidv4();
      const sub = await seedSubscription(d, {
        subjectType: 'SHOP',
        subjectId: id,
        plan: 'pro',
        version: 2,
      });
      await dEntitlements.get('SHOP', id);
      const event = statusEvent({
        subscriptionId: sub.id,
        subjectId: id,
        version: 3,
      });
      const applied = invalidations('applied');
      cut();

      await expect(dEntitlements.invalidate('SHOP', id)).rejects.toMatchObject({
        code: 'entitlement_invalidation_failed',
      });
      // not acknowledged: the framework redelivers (the harness rethrows a transient failure)
      await expect(
        d.deliver(SubscriptionStatusConsumer).deliver(event),
      ).rejects.toMatchObject({
        code: 'entitlement_invalidation_failed',
      });
      expect(invalidations('applied')).toBe(applied);

      // the store is back; the runner redelivers until the message is applied (the client reconnects on its own)
      proxy.mode = 'pass';
      d.clock.advance(60_000);
      const redelivered = await waitFor(
        async () =>
          d
            .deliver(SubscriptionStatusConsumer)
            .deliver(event)
            .catch(() => null),
        { timeoutMs: 20_000, description: 'redelivery applied' },
      );
      expect(redelivered.counts.applied).toBe(1);
      expect(invalidations('applied')).toBe(applied + 1);
    });
  });
});
