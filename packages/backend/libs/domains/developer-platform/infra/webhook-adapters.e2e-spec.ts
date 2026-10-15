import { getConnectionToken } from '@nestjs/sequelize';
import { v7 as uuidv7 } from 'uuid';
import { JobsTestProbe } from '@app/infrastructure/jobs';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CLOSED_BREAKER } from '../domain/breaker';
import {
  BreakerStore,
  DeliveryLog,
  DeliveryQueue,
  DeliveryRecord,
  EndpointHistory,
  EndpointRepository,
  NewEndpoint,
} from '../domain/webhook-ports';
import { DEFAULT_WEBHOOK_SETTINGS } from '../domain/webhook-settings';
import {
  createWebhookKit,
  type WebhookKit,
} from '../testing/webhook-e2e.fixture';
import { RedisBreakerStore } from './redis-breaker.store';

/**
 * The store adapters of the capability against the real engines of the test stack (Postgres, DynamoDB Local, Redis) and
 * the queue port's own option validation. The wired behaviour is proven by the story specs through HTTP; these specs prove
 * the conditional statements the stories rely on, one by one.
 */
describe('Webhooks: store adapters', () => {
  let kit: WebhookKit;
  let queue: InMemoryTaskQueue;
  let endpoints: EndpointRepository;
  let history: EndpointHistory;
  let log: DeliveryLog;
  let breaker: BreakerStore;
  let deliveryQueue: DeliveryQueue;

  beforeAll(async () => {
    queue = new InMemoryTaskQueue();
    kit = await createWebhookKit({
      overrides: [{ provide: TaskQueue, useValue: queue }],
    });
    endpoints = kit.app.get(EndpointRepository, { strict: false });
    history = kit.app.get(EndpointHistory, { strict: false });
    log = kit.app.get(DeliveryLog, { strict: false });
    breaker = kit.app.get(BreakerStore, { strict: false });
    deliveryQueue = kit.app.get(DeliveryQueue, { strict: false });
  }, 120_000);
  afterAll(() => kit?.close());

  const NOW = new Date('2026-10-06T12:00:00.000Z');
  const newEndpoint = (
    shopId: string,
    over: Partial<NewEndpoint> = {},
  ): NewEndpoint => {
    const id = over.id ?? uuidv7();
    return {
      id,
      shopId,
      url: `https://hooks.acme.test/${id}`,
      urlNormalized: `https://hooks.acme.test/${id}`,
      events: ['order.paid', 'product.stock_low'],
      apiVersion: '2026-10-01',
      secretSealed: 'sealed',
      now: NOW,
      ...over,
    };
  };

  describe('endpoint repository (Postgres)', () => {
    it('S43 AS-01: inserts an enabled endpoint and counts it for its shop', async () => {
      const shopId = uuidv7();
      const result = await endpoints.insertWithinLimit(newEndpoint(shopId), 20);
      expect(result).toMatchObject({
        outcome: 'created',
        endpoint: {
          shopId,
          status: 'enabled',
          disabledReason: null,
          failingSince: null,
          events: ['order.paid', 'product.stock_low'],
        },
      });
      const [counter] = await kit.rows<{ endpoints: number }>(
        `SELECT endpoints FROM "WebhookShopCounter" WHERE "shopId" = :shopId`,
        { shopId },
      );
      expect(counter.endpoints).toBe(1);
    });

    it('S43 AS-12: the same normalised address in the same shop is a duplicate and leaves the counter alone; another shop may use it', async () => {
      const shopId = uuidv7();
      const first = newEndpoint(shopId, {
        urlNormalized: 'https://same.acme.test/in',
      });
      await endpoints.insertWithinLimit(first, 20);
      expect(
        await endpoints.insertWithinLimit(
          newEndpoint(shopId, { urlNormalized: 'https://same.acme.test/in' }),
          20,
        ),
      ).toEqual({ outcome: 'duplicate_url' });
      const [counter] = await kit.rows<{ endpoints: number }>(
        `SELECT endpoints FROM "WebhookShopCounter" WHERE "shopId" = :shopId`,
        { shopId },
      );
      expect(counter.endpoints).toBe(1);
      expect(
        (
          await endpoints.insertWithinLimit(
            newEndpoint(uuidv7(), {
              urlNormalized: 'https://same.acme.test/in',
            }),
            20,
          )
        ).outcome,
      ).toBe('created');
    });

    it('S43 AS-12: concurrent creates of one new address give one created and the rest duplicates (20 rounds)', async () => {
      for (let round = 0; round < 20; round++) {
        const shopId = uuidv7();
        const urlNormalized = `https://race-${round}.acme.test/in`;
        const results = await Promise.all(
          Array.from({ length: 4 }, () =>
            endpoints.insertWithinLimit(
              newEndpoint(shopId, { urlNormalized }),
              20,
            ),
          ),
        );
        expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
        expect(
          results.filter((r) => r.outcome === 'duplicate_url'),
        ).toHaveLength(3);
        const [counter] = await kit.rows<{ endpoints: number }>(
          `SELECT endpoints FROM "WebhookShopCounter" WHERE "shopId" = :shopId`,
          { shopId },
        );
        expect(counter.endpoints).toBe(1);
      }
    });

    it('S43 AS-11: the limit holds under concurrent creates: exactly the allowed number succeed, counter = rows (20 rounds)', async () => {
      for (let round = 0; round < 20; round++) {
        const shopId = uuidv7();
        for (let i = 0; i < 18; i++)
          await endpoints.insertWithinLimit(newEndpoint(shopId), 20);
        const results = await Promise.all(
          Array.from({ length: 3 }, () =>
            endpoints.insertWithinLimit(newEndpoint(shopId), 20),
          ),
        );
        expect(results.filter((r) => r.outcome === 'created')).toHaveLength(2);
        expect(
          results.filter((r) => r.outcome === 'limit_reached'),
        ).toHaveLength(1);
        const [{ rows: count }] = await kit.rows<{ rows: number }>(
          `SELECT count(*)::int AS rows FROM "WebhookEndpoint" WHERE "shopId" = :shopId`,
          { shopId },
        );
        const [counter] = await kit.rows<{ endpoints: number }>(
          `SELECT endpoints FROM "WebhookShopCounter" WHERE "shopId" = :shopId`,
          { shopId },
        );
        expect(count).toBe(20);
        expect(counter.endpoints).toBe(20);
      }
    }, 120_000);

    it('S43 AS-11: deleting an endpoint frees a slot', async () => {
      const shopId = uuidv7();
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const input = newEndpoint(shopId);
        ids.push(input.id);
        await endpoints.insertWithinLimit(input, 20);
      }
      expect(
        (await endpoints.insertWithinLimit(newEndpoint(shopId), 20)).outcome,
      ).toBe('limit_reached');
      expect(await endpoints.delete(shopId, ids[0])).toMatchObject({
        id: ids[0],
      });
      expect(
        (await endpoints.insertWithinLimit(newEndpoint(shopId), 20)).outcome,
      ).toBe('created');
    });

    it('S43 AS-13: every lookup carries the shop: another shop and an unknown id are both null; delete of another shop changes nothing', async () => {
      const shopId = uuidv7();
      const input = newEndpoint(shopId);
      await endpoints.insertWithinLimit(input, 20);
      expect(await endpoints.findById(uuidv7(), input.id)).toBeNull();
      expect(await endpoints.findById(shopId, uuidv7())).toBeNull();
      expect(await endpoints.delete(uuidv7(), input.id)).toBeNull();
      expect(await endpoints.findById(shopId, input.id)).not.toBeNull();
    });

    it('S43 AS-05: keyset pages are ordered (createdAt desc, id desc) with no gap and no duplicate', async () => {
      const shopId = uuidv7();
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const input = newEndpoint(shopId, {
          now: new Date(NOW.getTime() + i * 1000),
        });
        ids.push(input.id);
        await endpoints.insertWithinLimit(input, 20);
      }
      const seen: string[] = [];
      let after: { createdAt: Date; id: string } | undefined;
      for (;;) {
        const page = await endpoints.listPage(shopId, { limit: 3, after });
        const items = page.slice(0, 3);
        seen.push(...items.map((e) => e.id));
        if (page.length <= 3) break;
        const last = items[items.length - 1];
        after = { createdAt: last.createdAt, id: last.id };
      }
      expect(seen).toEqual([...ids].reverse());
    });

    it('S43 AS-09: a transition asserts the source status: the second of two concurrent enables conflicts (20 rounds)', async () => {
      for (let round = 0; round < 20; round++) {
        const shopId = uuidv7();
        const input = newEndpoint(shopId);
        await endpoints.insertWithinLimit(input, 20);
        await endpoints.transition(
          shopId,
          input.id,
          'enabled',
          { status: 'disabled', disabledReason: 'manual' },
          NOW,
        );
        const results = await Promise.all([
          endpoints.transition(
            shopId,
            input.id,
            'disabled',
            { status: 'enabled', disabledReason: null },
            NOW,
          ),
          endpoints.transition(
            shopId,
            input.id,
            'disabled',
            { status: 'enabled', disabledReason: null },
            NOW,
          ),
        ]);
        expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
        expect(results.filter((r) => r.outcome === 'conflict')).toHaveLength(1);
      }
    });

    it('S43 AS-08: enabling clears the failure window; a transition on another shop is not_found', async () => {
      const shopId = uuidv7();
      const input = newEndpoint(shopId);
      await endpoints.insertWithinLimit(input, 20);
      await endpoints.markFailing(input.id, NOW);
      await endpoints.transition(
        shopId,
        input.id,
        'enabled',
        { status: 'disabled', disabledReason: 'auto_failing' },
        NOW,
      );
      const enabled = await endpoints.transition(
        shopId,
        input.id,
        'disabled',
        { status: 'enabled', disabledReason: null },
        NOW,
      );
      expect(enabled).toMatchObject({
        outcome: 'applied',
        endpoint: {
          status: 'enabled',
          disabledReason: null,
          failingSince: null,
        },
      });
      expect(
        (
          await endpoints.transition(
            uuidv7(),
            input.id,
            'enabled',
            { status: 'disabled', disabledReason: 'manual' },
            NOW,
          )
        ).outcome,
      ).toBe('not_found');
    });

    it('S43 AS-07: an update changes only the given facets and returns the previous row; a duplicate address changes nothing', async () => {
      const shopId = uuidv7();
      const a = newEndpoint(shopId, {
        urlNormalized: 'https://a.acme.test/in',
      });
      const b = newEndpoint(shopId, {
        urlNormalized: 'https://b.acme.test/in',
      });
      await endpoints.insertWithinLimit(a, 20);
      await endpoints.insertWithinLimit(b, 20);
      const updated = await endpoints.update(
        shopId,
        a.id,
        { events: ['order.paid'], apiVersion: '2026-01-15' },
        NOW,
      );
      expect(updated).toMatchObject({
        outcome: 'applied',
        endpoint: {
          events: ['order.paid'],
          apiVersion: '2026-01-15',
          urlNormalized: 'https://a.acme.test/in',
        },
        before: {
          events: ['order.paid', 'product.stock_low'],
          apiVersion: '2026-10-01',
        },
      });
      expect(
        await endpoints.update(
          shopId,
          a.id,
          {
            url: 'https://b.acme.test/in',
            urlNormalized: 'https://b.acme.test/in',
          },
          NOW,
        ),
      ).toEqual({ outcome: 'duplicate_url' });
      expect((await endpoints.findById(shopId, a.id))!.urlNormalized).toBe(
        'https://a.acme.test/in',
      );
      expect(
        (
          await endpoints.update(
            uuidv7(),
            a.id,
            { events: ['order.paid'] },
            NOW,
          )
        ).outcome,
      ).toBe('not_found');
    });

    it('S43 AS-20: rotation is refused while a previous secret is valid, allowed after its expiry or after expiring it (20 rounds of the race)', async () => {
      const shopId = uuidv7();
      const input = newEndpoint(shopId);
      await endpoints.insertWithinLimit(input, 20);
      const expires = new Date(NOW.getTime() + 24 * 3600_000);
      const first = await endpoints.rotateSecret(
        shopId,
        input.id,
        { secretSealed: 'sealed-2', previousExpiresAt: expires },
        NOW,
      );
      expect(first).toMatchObject({
        outcome: 'applied',
        endpoint: {
          secretSealed: 'sealed-2',
          previousSecretSealed: 'sealed',
          previousSecretExpiresAt: expires,
        },
      });
      expect(
        (
          await endpoints.rotateSecret(
            shopId,
            input.id,
            { secretSealed: 'sealed-3', previousExpiresAt: expires },
            NOW,
          )
        ).outcome,
      ).toBe('conflict');
      // at the expiry instant the previous secret no longer counts
      expect(
        (
          await endpoints.rotateSecret(
            shopId,
            input.id,
            { secretSealed: 'sealed-3', previousExpiresAt: expires },
            expires,
          )
        ).outcome,
      ).toBe('applied');
      // ending early
      const early = await endpoints.expirePreviousSecret(
        shopId,
        input.id,
        new Date(expires.getTime() + 1000),
      );
      expect(early.outcome).toBe('conflict'); // no previous secret valid any more at that instant
      for (let round = 0; round < 20; round++) {
        const fresh = newEndpoint(shopId);
        await endpoints.insertWithinLimit(fresh, 20);
        const results = await Promise.all(
          [1, 2].map((n) =>
            endpoints.rotateSecret(
              shopId,
              fresh.id,
              { secretSealed: `s${n}`, previousExpiresAt: expires },
              NOW,
            ),
          ),
        );
        expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(1);
        expect(results.filter((r) => r.outcome === 'conflict')).toHaveLength(1);
        expect(
          (await endpoints.expirePreviousSecret(shopId, fresh.id, NOW)).outcome,
        ).toBe('applied');
        expect(
          (await endpoints.expirePreviousSecret(shopId, fresh.id, NOW)).outcome,
        ).toBe('conflict');
        await endpoints.delete(shopId, fresh.id);
      }
    });

    it('S43 AS-55: the failure window starts once, clears on recovery, and the sweep disables only past the cutoff', async () => {
      const shopId = uuidv7();
      const input = newEndpoint(shopId);
      await endpoints.insertWithinLimit(input, 20);
      const t0 = new Date(NOW.getTime() - 3 * 86_400_000);
      expect(await endpoints.markFailing(input.id, t0)).toEqual(t0);
      expect(await endpoints.markFailing(input.id, NOW)).toEqual(t0); // the first failure stays the start
      const cutoffBefore = new Date(t0.getTime() - 1);
      expect(
        await endpoints.disableIfFailingSince(input.id, cutoffBefore, NOW),
      ).toBeNull();
      expect(
        (await endpoints.findFailingBefore(t0, 10)).map((r) => r.id),
      ).toContain(input.id);
      const disabled = await endpoints.disableIfFailingSince(input.id, t0, NOW);
      expect(disabled).toMatchObject({
        status: 'disabled',
        disabledReason: 'auto_failing',
        failingSince: t0,
      });
      expect(
        await endpoints.disableIfFailingSince(input.id, t0, NOW),
      ).toBeNull(); // once
      const other = newEndpoint(shopId);
      await endpoints.insertWithinLimit(other, 20);
      await endpoints.markFailing(other.id, t0);
      await endpoints.markHealthy(other.id);
      expect(
        (await endpoints.findById(shopId, other.id))!.failingSince,
      ).toBeNull();
    });

    it('S43 AS-66: a shop purge removes endpoints in batches and the counter with the last batch', async () => {
      const shopId = uuidv7();
      for (let i = 0; i < 5; i++)
        await endpoints.insertWithinLimit(newEndpoint(shopId), 20);
      expect(await endpoints.deleteForShop(shopId, 3)).toHaveLength(3);
      expect(await endpoints.deleteForShop(shopId, 3)).toHaveLength(2);
      expect(await endpoints.deleteForShop(shopId, 3)).toHaveLength(0);
      expect(
        await kit.rows(
          `SELECT 1 FROM "WebhookShopCounter" WHERE "shopId" = :shopId`,
          { shopId },
        ),
      ).toHaveLength(0);
    });
  });

  describe('endpoint history (Postgres)', () => {
    it('S43 AS-01: appends entries, reads them per endpoint and shop, and purges by age and by shop', async () => {
      const shopId = uuidv7();
      const endpointId = uuidv7();
      const old = new Date(NOW.getTime() - 401 * 86_400_000);
      await history.append([
        {
          endpointId,
          shopId,
          facet: 'created',
          fromValue: null,
          toValue: 'hooks.acme.test',
          actorId: null,
          at: old,
        },
        {
          endpointId,
          shopId,
          facet: 'status',
          fromValue: 'enabled',
          toValue: 'disabled',
          actorId: uuidv7(),
          at: NOW,
        },
      ]);
      expect(
        (await history.listForEndpoint(shopId, endpointId, 10)).map(
          (e) => e.facet,
        ),
      ).toEqual(['created', 'status']);
      expect(await history.listForEndpoint(uuidv7(), endpointId, 10)).toEqual(
        [],
      );
      expect(
        await history.deleteOlderThan(
          new Date(NOW.getTime() - 400 * 86_400_000),
          100,
        ),
      ).toBeGreaterThanOrEqual(1);
      expect(
        (await history.listForEndpoint(shopId, endpointId, 10)).map(
          (e) => e.facet,
        ),
      ).toEqual(['status']);
      expect(await history.deleteForShop(shopId, 100)).toBe(1);
    });
  });

  describe('delivery log (DynamoDB)', () => {
    const delivery = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
      endpointId: uuidv7(),
      shopId: uuidv7(),
      eventId: `evt_${uuidv7().replace(/-/g, '').slice(0, 32)}`,
      deliveryId: uuidv7(),
      type: 'order.paid',
      kind: 'event',
      state: 'queued',
      attempt: 1,
      nextAttemptAt: null,
      claimedAt: null,
      body: '{"id":"evt"}',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      ...over,
    });
    const attemptOf = (
      d: DeliveryRecord,
      over: { attempt?: number; startedAt?: Date; ok?: boolean } = {},
    ) => ({
      endpointId: d.endpointId,
      deliveryId: d.deliveryId,
      eventId: d.eventId,
      type: d.type,
      attemptId: uuidv7(),
      attempt: over.attempt ?? 1,
      startedAt: over.startedAt ?? NOW,
      durationMs: 12,
      status: over.ok === false ? 500 : 200,
      ok: over.ok ?? true,
      replay: false,
      expiresAt: d.expiresAt,
    });

    it('S43 AS-30: a delivery is created once per (endpoint, event); the second create is exists and keeps the first', async () => {
      const d = delivery();
      expect(await log.createDelivery(d)).toBe('created');
      expect(await log.createDelivery({ ...d, body: 'other' })).toBe('exists');
      expect((await log.getDelivery(d.endpointId, d.eventId, NOW))!.body).toBe(
        '{"id":"evt"}',
      );
    });

    it('S43 AS-67: an item is returned at expiry - 1 s and not at expiry', async () => {
      const d = delivery({ expiresAt: new Date(NOW.getTime() + 60_000) });
      await log.createDelivery(d);
      expect(
        await log.getDelivery(
          d.endpointId,
          d.eventId,
          new Date(NOW.getTime() + 59_000),
        ),
      ).not.toBeNull();
      expect(
        await log.getDelivery(d.endpointId, d.eventId, d.expiresAt),
      ).toBeNull();
    });

    it('S43 AS-44: two workers claiming the same attempt at once: exactly one wins (20 rounds)', async () => {
      for (let round = 0; round < 20; round++) {
        const d = delivery();
        await log.createDelivery(d);
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            log.claim(d.endpointId, d.eventId, 1, NOW, 60_000),
          ),
        );
        expect(results.filter((r) => r.claimed)).toHaveLength(1);
        expect(
          results.filter((r) => !r.claimed && r.reason === 'in_flight'),
        ).toHaveLength(4);
      }
    });

    it('S43 AS-44: a delivered delivery is never claimed again', async () => {
      const d = delivery();
      await log.createDelivery(d);
      const claim = await log.claim(d.endpointId, d.eventId, 1, NOW, 60_000);
      expect(claim.claimed).toBe(true);
      await log.recordAttempt(attemptOf(d), { state: 'delivered', attempt: 2 });
      expect(await log.claim(d.endpointId, d.eventId, 1, NOW, 60_000)).toEqual({
        claimed: false,
        reason: 'delivered',
      });
      expect(await log.claim(d.endpointId, d.eventId, 2, NOW, 60_000)).toEqual({
        claimed: false,
        reason: 'delivered',
      });
      expect(
        await log.claim(d.endpointId, 'evt_missing', 1, NOW, 60_000),
      ).toEqual({ claimed: false, reason: 'missing' });
    });

    it('S43 AS-43: a claim older than the margin is reclaimed and the repeat consumes the next attempt number', async () => {
      const d = delivery();
      await log.createDelivery(d);
      await log.claim(d.endpointId, d.eventId, 1, NOW, 30_000); // the worker dies here
      expect(
        await log.claim(
          d.endpointId,
          d.eventId,
          1,
          new Date(NOW.getTime() + 29_000),
          30_000,
        ),
      ).toMatchObject({ claimed: false, reason: 'in_flight' });
      const repeat = await log.claim(
        d.endpointId,
        d.eventId,
        1,
        new Date(NOW.getTime() + 31_000),
        30_000,
      );
      expect(repeat).toMatchObject({
        claimed: true,
        delivery: { attempt: 2, state: 'delivering' },
      });
    });

    it('S43 AS-47: a claimed attempt given back (breaker open) keeps its number and waits for the close time; a superseded worker changes nothing', async () => {
      const d = delivery();
      await log.createDelivery(d);
      await log.claim(d.endpointId, d.eventId, 1, NOW, 30_000);
      const closes = new Date(NOW.getTime() + 60_000);

      await log.release(d.endpointId, d.eventId, 2, closes); // wrong attempt number: no effect
      expect(await log.getDelivery(d.endpointId, d.eventId, NOW)).toMatchObject(
        { state: 'delivering', attempt: 1 },
      );

      await log.release(d.endpointId, d.eventId, 1, closes);
      const given = await log.getDelivery(d.endpointId, d.eventId, NOW);
      expect(given).toMatchObject({ state: 'retry_scheduled', attempt: 1 });
      expect(given!.nextAttemptAt).toEqual(closes);
      expect(given!.claimedAt).toBeNull();
      expect(
        await log.claim(d.endpointId, d.eventId, 1, closes, 30_000),
      ).toMatchObject({ claimed: true, delivery: { attempt: 1 } });
    });

    it('S43 AS-40: recording an attempt writes the attempt and the next state together, and schedules the retry', async () => {
      const d = delivery();
      await log.createDelivery(d);
      await log.claim(d.endpointId, d.eventId, 1, NOW, 30_000);
      const retryAt = new Date(NOW.getTime() + 30_000);
      await log.recordAttempt(attemptOf(d, { ok: false }), {
        state: 'retry_scheduled',
        attempt: 2,
        nextAttemptAt: retryAt,
      });
      expect(await log.getDelivery(d.endpointId, d.eventId, NOW)).toMatchObject(
        {
          state: 'retry_scheduled',
          attempt: 2,
          nextAttemptAt: retryAt,
          claimedAt: null,
        },
      );
      expect(await log.countAttempts(d.endpointId, d.eventId, NOW)).toBe(1);
      expect(
        await log.claim(d.endpointId, d.eventId, 2, retryAt, 30_000),
      ).toMatchObject({ claimed: true, delivery: { attempt: 2 } });
    });

    it('S43 AS-54: a result from a superseded worker is dropped: no attempt is recorded twice', async () => {
      const d = delivery();
      await log.createDelivery(d);
      await log.claim(d.endpointId, d.eventId, 1, NOW, 30_000);
      await log.claim(
        d.endpointId,
        d.eventId,
        1,
        new Date(NOW.getTime() + 31_000),
        30_000,
      ); // reclaimed as attempt 2
      await log.recordAttempt(attemptOf(d, { attempt: 1 }), {
        state: 'delivered',
        attempt: 2,
      }); // the slow first worker
      expect(await log.countAttempts(d.endpointId, d.eventId, NOW)).toBe(0);
      expect((await log.getDelivery(d.endpointId, d.eventId, NOW))!.state).toBe(
        'delivering',
      );
    });

    it('S43 AS-50: cancelling a pending delivery is final; a delivered one is left alone', async () => {
      const pending = delivery();
      const done = delivery();
      await log.createDelivery(pending);
      await log.createDelivery(done);
      await log.claim(done.endpointId, done.eventId, 1, NOW, 30_000);
      await log.recordAttempt(attemptOf(done), {
        state: 'delivered',
        attempt: 2,
      });
      await log.cancel(
        pending.endpointId,
        pending.eventId,
        'endpoint_disabled',
      );
      await log.cancel(done.endpointId, done.eventId, 'endpoint_disabled');
      expect(
        await log.getDelivery(pending.endpointId, pending.eventId, NOW),
      ).toMatchObject({
        state: 'cancelled',
        cancelReason: 'endpoint_disabled',
      });
      expect(
        (await log.getDelivery(done.endpointId, done.eventId, NOW))!.state,
      ).toBe('delivered');
      expect(
        await log.claim(pending.endpointId, pending.eventId, 1, NOW, 30_000),
      ).toEqual({ claimed: false, reason: 'terminal' });
    });

    it('S43 AS-60: attempts are listed newest first, filtered, cut at 30 days and paged by cursor without gap or duplicate', async () => {
      // an attempt is recorded only by the worker that claimed it, so each one goes through a claim
      const fresh = delivery();
      await log.createDelivery(fresh);
      const written: Date[] = [];
      for (let i = 0; i < 7; i++) {
        const claim = await log.claim(
          fresh.endpointId,
          fresh.eventId,
          i + 1,
          NOW,
          30_000,
        );
        expect(claim.claimed).toBe(true);
        const startedAt = new Date(NOW.getTime() + i * 1000);
        written.push(startedAt);
        await log.recordAttempt(
          attemptOf(fresh, { attempt: i + 1, startedAt, ok: i % 2 === 0 }),
          { state: 'retry_scheduled', attempt: i + 2, nextAttemptAt: NOW },
        );
      }
      const all = await log.listAttempts(fresh.endpointId, { limit: 100 }, NOW);
      expect(all.map((a) => a.startedAt)).toEqual([...written].reverse());
      const pages: Date[] = [];
      let after: { startedAt: Date; attemptId: string } | undefined;
      for (;;) {
        const page = await log.listAttempts(
          fresh.endpointId,
          { limit: 3, after },
          NOW,
        );
        pages.push(...page.map((a) => a.startedAt));
        if (page.length < 3) break;
        after = { startedAt: page[2].startedAt, attemptId: page[2].attemptId };
      }
      expect(pages).toEqual([...written].reverse());
      expect(
        (
          await log.listAttempts(
            fresh.endpointId,
            { limit: 100, ok: false },
            NOW,
          )
        ).every((a) => !a.ok),
      ).toBe(true);
      expect(
        await log.listAttempts(
          fresh.endpointId,
          { limit: 100, eventId: 'evt_other' },
          NOW,
        ),
      ).toEqual([]);
      expect(
        await log.listAttempts(
          fresh.endpointId,
          { limit: 100 },
          fresh.expiresAt,
        ),
      ).toEqual([]);
      expect(await log.listAttempts(uuidv7(), { limit: 100 }, NOW)).toEqual([]);
    });

    it('S43 AS-66: the items of an endpoint are deleted in batches', async () => {
      const d = delivery();
      await log.createDelivery(d);
      await log.claim(d.endpointId, d.eventId, 1, NOW, 30_000);
      await log.recordAttempt(attemptOf(d), { state: 'delivered', attempt: 2 });
      expect(await log.deleteForEndpoint(d.endpointId, 1)).toBe(1);
      expect(await log.deleteForEndpoint(d.endpointId, 10)).toBe(1);
      expect(await log.deleteForEndpoint(d.endpointId, 10)).toBe(0);
      expect(await log.getDelivery(d.endpointId, d.eventId, NOW)).toBeNull();
    });
  });

  describe('breaker store (Redis)', () => {
    it('S43 AS-47: five failures open the breaker for a minute, the probe lease has one winner (20 rounds), a success closes it', async () => {
      const now = NOW.getTime();
      for (let round = 0; round < 20; round++) {
        const id = uuidv7();
        for (let i = 1; i <= 4; i++)
          expect((await breaker.recordFailure(id, now)).openUntil).toBeNull();
        const fifth = await breaker.recordFailure(id, now);
        expect(fifth).toMatchObject({
          consecutiveFailures: 5,
          openUntil: now + 60_000,
        });
        expect(await breaker.get(id)).toMatchObject({
          consecutiveFailures: 5,
          openUntil: now + 60_000,
          probeInFlight: false,
        });
        const wins = await Promise.all(
          Array.from({ length: 6 }, () => breaker.acquireProbe(id, 5_000)),
        );
        expect(wins.filter(Boolean)).toHaveLength(1);
        expect((await breaker.get(id)).probeInFlight).toBe(true);
        const sixth = await breaker.recordFailure(id, now + 60_000);
        expect(sixth).toMatchObject({
          consecutiveFailures: 6,
          openUntil: now + 60_000 + 120_000,
        });
        expect((await breaker.get(id)).probeInFlight).toBe(false);
        await breaker.recordSuccess(id);
        expect(await breaker.get(id)).toEqual(CLOSED_BREAKER);
      }
    });

    it('S43 AS-49: when the store fails the breaker answers closed, counts the degradation and never throws', async () => {
      const failing = {
        client: {
          hgetall: () => Promise.reject(new Error('redis down')),
          exists: () => Promise.reject(new Error('redis down')),
          set: () => Promise.reject(new Error('redis down')),
          hincrby: () => Promise.reject(new Error('redis down')),
          del: () => Promise.reject(new Error('redis down')),
        },
      } as unknown as RedisService;
      const broken = new RedisBreakerStore(failing, {
        ...DEFAULT_WEBHOOK_SETTINGS,
      });
      const before =
        MetricsRegistry.value('webhook_breaker_degraded_total') ?? 0;
      const id = uuidv7();
      expect(await broken.get(id)).toEqual(CLOSED_BREAKER);
      expect(await broken.acquireProbe(id, 1000)).toBe(true);
      expect(await broken.recordFailure(id, NOW.getTime())).toEqual(
        CLOSED_BREAKER,
      );
      await expect(broken.recordSuccess(id)).resolves.toBeUndefined();
      expect(MetricsRegistry.value('webhook_breaker_degraded_total')).toBe(
        before + 4,
      );
    });
  });

  describe('delivery queue (FIFO options)', () => {
    it('S43 AS-30: a message goes to the FIFO queue with group = endpoint and a deduplication id per endpoint, event, kind and attempt; no body, no secret', async () => {
      queue.sent.length = 0;
      const base = {
        endpointId: uuidv7(),
        eventId: 'evt_' + 'a'.repeat(32),
        deliveryId: uuidv7(),
        kind: 'event' as const,
        attempt: 1,
      };
      await deliveryQueue.enqueue(base);
      await deliveryQueue.enqueue(base);
      await deliveryQueue.enqueue({ ...base, endpointId: uuidv7() });
      await deliveryQueue.enqueue({ ...base, attempt: 2 });
      expect(queue.sent.map((m) => m.queue)).toEqual(
        Array(4).fill('webhook-deliveries.fifo'),
      );
      const [a, b, c, d] = queue.sent;
      expect(a.options).toEqual({
        groupId: base.endpointId,
        dedupeId: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(a.options!.dedupeId).toBe(b.options!.dedupeId); // a repeat is dropped by the queue
      expect(a.options!.dedupeId).not.toBe(c.options!.dedupeId); // another endpoint of the same shop has the same event id
      expect(a.options!.dedupeId).not.toBe(d.options!.dedupeId);
      expect(Object.keys(a.body as object).sort()).toEqual([
        'attempt',
        'deliveryId',
        'endpointId',
        'eventId',
        'kind',
      ]);
    });

    it('S43 AS-47: a delayed retry is a job with its own key per instant and its own deduplication id once it re-enters the lane', async () => {
      const message = {
        endpointId: uuidv7(),
        eventId: 'evt_' + 'c'.repeat(32),
        deliveryId: uuidv7(),
        kind: 'event' as const,
        attempt: 4,
      };
      const first = new Date('2026-10-06T12:05:00.000Z');
      const later = new Date('2026-10-06T12:06:00.000Z');
      await deliveryQueue.scheduleRetry(message, first);
      await deliveryQueue.scheduleRetry(message, first); // the same instant: one job
      await deliveryQueue.scheduleRetry(message, later); // put off again with the same attempt number: another job
      const jobs = await new JobsTestProbe(
        kit.app.get(getConnectionToken()),
      ).find('webhooks.retry', { endpointId: message.endpointId });
      expect(jobs.map((j) => new Date(j.runAt).toISOString())).toEqual([
        first.toISOString(),
        later.toISOString(),
      ]);
      expect(jobs[1].payload).toMatchObject({
        ...message,
        scheduledFor: later.toISOString(),
      });

      queue.sent.length = 0;
      await deliveryQueue.enqueue(message);
      await deliveryQueue.enqueue({
        ...message,
        scheduledFor: first.toISOString(),
      });
      await deliveryQueue.enqueue({
        ...message,
        scheduledFor: later.toISOString(),
      });
      const ids = queue.sent.map((m) => m.options!.dedupeId);
      expect(new Set(ids).size).toBe(3);
    });

    it('S43 AS-33: a batch with a rejected entry throws, so the caller does not acknowledge its source event', async () => {
      const original = queue.enqueueBatch.bind(queue);
      queue.enqueueBatch = () =>
        Promise.resolve({
          sent: 1,
          failed: [{ index: 1, reason: 'rejected' }],
        });
      try {
        await expect(
          deliveryQueue.enqueueMany([
            {
              endpointId: uuidv7(),
              eventId: 'evt_' + 'b'.repeat(32),
              deliveryId: uuidv7(),
              kind: 'event',
              attempt: 1,
            },
            {
              endpointId: uuidv7(),
              eventId: 'evt_' + 'b'.repeat(32),
              deliveryId: uuidv7(),
              kind: 'event',
              attempt: 1,
            },
          ]),
        ).rejects.toThrow(/rejected 1 of 2/);
      } finally {
        queue.enqueueBatch = original;
      }
    });
  });
});
