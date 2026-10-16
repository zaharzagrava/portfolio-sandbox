import { Command } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  DISPATCH_TIMERS,
  RING_REGISTRY,
  SURGE_STORE,
  type DispatchTimers,
  type RingRegistry,
  type SurgeStore,
} from './domain/delivery-ports';
import { ownerOf } from './domain/dispatcher-ring';
import { geohash } from './domain/geohash';
import {
  courierKey,
  demandKey,
  keyShapes,
  RING_KEY,
  trackThrottleKey,
} from './infra/courier-keys';
import { HEARTBEAT_EXPIRY_MS } from './infra/ring-registry';
import { FakeOrderFulfilment, fakeOrdersModule } from './testing/fake-orders';
import {
  BERLIN,
  createDeliveryApp,
  type DeliveryTestApp,
} from './testing/delivery-fixtures';
import {
  startWorkerInstance,
  type WorkerInstance,
} from './testing/worker-instance';

const fakeOrders = new FakeOrderFulfilment();
const OFFER_TTL_MS = 15_000;
const CELL = geohash(BERLIN.pickup.lat, BERLIN.pickup.lng, 5);

const counter = (name: string, city: string) =>
  MetricsRegistry.value(name, { city }) ?? 0;

describe('Delivery city ownership and cell isolation', () => {
  let t: DeliveryTestApp;
  let a: WorkerInstance;
  let b: WorkerInstance;
  let store: SurgeStore;
  /** Every hand-back or timer an instance tried to put on the queue (the real queue is not used). */
  const sent = new Map<string, Array<{ body: unknown; delay: number }>>();

  beforeAll(async () => {
    t = await createDeliveryApp({
      extraImports: [fakeOrdersModule(fakeOrders)],
    });
    store = t.app.get<SurgeStore>(SURGE_STORE);
    a = await startWorkerInstance(t.clock, fakeOrders);
    b = await startWorkerInstance(t.clock, fakeOrders);
    for (const instance of [a, b]) {
      sent.set(instance.instanceId, []);
      jest
        .spyOn(instance.app.get<DispatchTimers>(DISPATCH_TIMERS), 'enqueue')
        .mockImplementation((body, delay) => {
          sent.get(instance.instanceId)!.push({ body, delay });
          return Promise.resolve();
        });
    }
  });
  afterAll(async () => {
    await a.close();
    await b.close();
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    for (const queue of sent.values()) queue.length = 0;
    fakeOrders.reset();
    await t.redis.client.del(RING_KEY);
    await a.heartbeat.beat();
    await b.heartbeat.beat();
  });

  /** A city slug the ring gives to `owner` when `instances` are alive. */
  const cityOwnedBy = (
    owner: WorkerInstance,
    instances = [a.instanceId, b.instanceId],
  ) => {
    for (let i = 0; i < 500; i++) {
      const city = t.uniqueCity();
      if (ownerOf(city, instances) === owner.instanceId) return city;
    }
    throw new Error('no city found for the owner');
  };
  const other = (instance: WorkerInstance) => (instance === a ? b : a);

  /** An offered delivery in `city` whose offer is over after `clock.advance(OFFER_TTL_MS)`; returns the timer message. */
  const offeredAndLapsed = async (city: string) => {
    await t.onShiftCourier({ city });
    const deliveryId = await t.requested(city);
    await t.dispatch(deliveryId);
    const message = t.queued()[0].body;
    t.clock.advance(OFFER_TTL_MS);
    return { deliveryId, message };
  };
  const offerStatus = async (deliveryId: string) =>
    (await t.offerRows(deliveryId)).map((o) => o.status);

  describe('US7 - ownership in operation (AS-53)', () => {
    it('S20 AS-53: a timer message for a city the other instance owns is handed back with a 1 s delay and has no effect', async () => {
      const city = cityOwnedBy(b);
      const { deliveryId, message } = await offeredAndLapsed(city);
      const before = counter('delivery_hand_backs_total', city);

      await a.worker.handle(message);

      expect(sent.get(a.instanceId)).toEqual([
        { body: { ...message, handBacks: 1 }, delay: 1 },
      ]);
      expect(await offerStatus(deliveryId)).toEqual(['OFFERED']);
      expect((await t.deliveryRow(deliveryId)).status).toBe('OFFERED');
      expect(counter('delivery_hand_backs_total', city)).toBe(before + 1);
    });

    it('S20 AS-53: the owner handles the same message at once', async () => {
      const city = cityOwnedBy(b);
      const { deliveryId, message } = await offeredAndLapsed(city);

      await b.worker.handle(message);

      expect(await offerStatus(deliveryId)).toEqual(['EXPIRED']);
      expect(sent.get(b.instanceId)!.map((s) => s.body)).not.toContainEqual(
        expect.objectContaining({ handBacks: expect.any(Number) }),
      );
    });

    it('S20 AS-53: after 3 hand-backs any instance handles the message', async () => {
      const city = cityOwnedBy(b);
      const { deliveryId, message } = await offeredAndLapsed(city);

      await a.worker.handle(message);
      await a.worker.handle({ ...(message as object), handBacks: 1 });
      await a.worker.handle({ ...(message as object), handBacks: 2 });
      expect(
        sent
          .get(a.instanceId)!
          .map((s) => (s.body as { handBacks: number }).handBacks),
      ).toEqual([1, 2, 3]);
      expect(await offerStatus(deliveryId)).toEqual(['OFFERED']);

      await a.worker.handle({ ...(message as object), handBacks: 3 });

      expect(await offerStatus(deliveryId)).toEqual(['EXPIRED']);
      expect(
        sent
          .get(a.instanceId)!
          .map((s) => (s.body as { handBacks?: number }).handBacks),
      ).not.toContain(4);
    });

    it('S20 AS-53: a hand-back that cannot be queued is handled here instead of being lost', async () => {
      const city = cityOwnedBy(b);
      const { deliveryId, message } = await offeredAndLapsed(city);
      const timers = a.app.get<DispatchTimers>(DISPATCH_TIMERS);
      jest
        .spyOn(timers, 'enqueue')
        .mockRejectedValueOnce(new Error('queue refused the message'));

      await a.worker.handle(message);

      expect(await offerStatus(deliveryId)).toEqual(['EXPIRED']);
    });

    it('S20 AS-53: when the owner stops beating (clock advanced) the other instance owns its cities', async () => {
      const city = cityOwnedBy(b);
      expect(await a.ownership.owns(city)).toBe(false);
      expect(await b.ownership.owns(city)).toBe(true);

      t.clock.advance(HEARTBEAT_EXPIRY_MS + 1);
      await a.heartbeat.beat();

      expect(await a.ownership.owns(city)).toBe(true);
      const { deliveryId, message } = await offeredAndLapsed(city);
      await a.worker.handle(message);
      expect(await offerStatus(deliveryId)).toEqual(['EXPIRED']);
      expect(sent.get(a.instanceId)).not.toContainEqual(
        expect.objectContaining({ delay: 1 }),
      );
    });

    it('S20 AS-53: the recovery job on the surviving instance picks up the stuck deliveries of the expired owner', async () => {
      const city = cityOwnedBy(b);
      await t.onShiftCourier({ city });
      const stuck = await t.requested(city);
      await a.recovery.recoverOverdue(t.clock.now());
      expect((await t.deliveryRow(stuck)).status).toBe('REQUESTED');

      t.clock.advance(HEARTBEAT_EXPIRY_MS + 1);
      await a.heartbeat.beat();
      await a.recovery.recoverOverdue(t.clock.now());

      expect((await t.deliveryRow(stuck)).status).toBe('OFFERED');
    });

    it('S20 AS-53: recovery and surge touch only the cities the instance owns', async () => {
      const cityA = cityOwnedBy(a);
      const cityB = cityOwnedBy(b);
      const dueA = await (async () => {
        await t.onShiftCourier({ city: cityA });
        return t.requested(cityA);
      })();
      const dueB = await (async () => {
        await t.onShiftCourier({ city: cityB });
        return t.requested(cityB);
      })();
      await store.recordDemand(cityA, CELL, t.clock.nowMs());
      await store.recordDemand(cityB, CELL, t.clock.nowMs());

      await a.recovery.recoverOverdue(t.clock.now());
      expect((await t.deliveryRow(dueA)).status).toBe('OFFERED');
      expect((await t.deliveryRow(dueB)).status).toBe('REQUESTED');
      expect([...(await a.surge.compute(t.clock.now())).keys()]).toEqual([
        cityA,
      ]);

      await b.recovery.recoverOverdue(t.clock.now());
      expect((await t.deliveryRow(dueB)).status).toBe('OFFERED');
      expect([...(await b.surge.compute(t.clock.now())).keys()]).toEqual([
        cityB,
      ]);
    });

    it('S20 AS-53: an instance set seen as empty makes every instance process every city', async () => {
      await t.redis.client.del(RING_KEY);
      const cityA = t.uniqueCity();
      const cityB = t.uniqueCity();
      for (const city of [cityA, cityB]) await t.onShiftCourier({ city });
      const dueA = await t.requested(cityA);
      const dueB = await t.requested(cityB);

      expect(await a.ownership.owns(cityB)).toBe(true);
      expect(await b.ownership.owns(cityA)).toBe(true);
      await a.recovery.recoverOverdue(t.clock.now());

      expect((await t.deliveryRow(dueA)).status).toBe('OFFERED');
      expect((await t.deliveryRow(dueB)).status).toBe('OFFERED');
    });

    it('S20 AS-53: a ring registry that cannot be read also means every city', async () => {
      const city = cityOwnedBy(b);
      jest
        .spyOn(a.app.get<RingRegistry>(RING_REGISTRY), 'liveInstances')
        .mockRejectedValueOnce(new Error('redis is down'));

      expect(await a.ownership.owns(city)).toBe(true);
    });

    it('S20 AS-53: every worker is in the registry with the clock time of its last beat, and leaves it on a graceful shutdown', async () => {
      const beats = await t.redis.client.hgetall(RING_KEY);
      expect(beats).toEqual({
        [a.instanceId]: String(t.clock.nowMs()),
        [b.instanceId]: String(t.clock.nowMs()),
      });

      // the shutdown hook of the app (Nest calls it on close; the shared model classes keep the spec from closing a
      // second app mid-run)
      await b.heartbeat.onModuleDestroy();

      expect(Object.keys(await t.redis.client.hgetall(RING_KEY))).toEqual([
        a.instanceId,
      ]);
    });

    it('S20 AS-53: the scheduled tick covers the cities of its instance and queues a follow-up for each other instance, which covers theirs', async () => {
      const cityB = cityOwnedBy(b);
      await t.onShiftCourier({ city: cityB });
      const dueB = await t.requested(cityB);
      const jobId = uuidv4();

      await a.handlers.recover({}, { jobId });

      expect((await t.deliveryRow(dueB)).status).toBe('REQUESTED');
      const followUps = await t.sql<{ payload: { for: string } }>(
        `SELECT "payload" FROM "Job" WHERE "type" = 'fulfilment.recover-deliveries' AND "idempotencyKey" = :key`,
        { key: `fulfilment.recover-deliveries:${jobId}:${b.instanceId}` },
      );
      expect(followUps.map((j) => j.payload)).toEqual([{ for: b.instanceId }]);

      await a.handlers.recover({ for: b.instanceId });

      expect((await t.deliveryRow(dueB)).status).toBe('OFFERED');
    });

    it('S20 AS-53: a follow-up for an instance that has left covers nothing', async () => {
      const city = cityOwnedBy(b);
      await t.onShiftCourier({ city });
      const due = await t.requested(city);

      await a.handlers.recover({ for: 'gone-instance' });

      expect((await t.deliveryRow(due)).status).toBe('REQUESTED');
    });
  });

  describe('US7 - cell isolation (AS-54)', () => {
    it('S20 AS-54: every per-city key carries the city as its only hash tag', async () => {
      const city = t.uniqueCity();
      const shapes = keyShapes(city, {
        courierId: uuidv4(),
        deliveryId: uuidv4(),
        minute: 27_000_000,
      });

      expect(Object.keys(shapes).sort()).toEqual([
        'courierKey',
        'demandKey',
        'geoKey',
        'offerLockKey',
        'surgeKey',
        'trackThrottleKey',
      ]);
      for (const [name, key] of Object.entries(shapes))
        expect({ name, tags: key.match(/\{[^{}]*\}/g) }).toEqual({
          name,
          tags: [`{${city}}`],
        });
    });

    it('S20 AS-54: after a full flow every Redis key that names the city has the tag, and the history message key is the city', async () => {
      const shop = await t.shopMembers();
      const city = t.uniqueCity();
      const courier = await t.onShiftCourier({ city });
      const id = await t.requested(city, {
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      await t.dispatch(id);
      await t.as(courier.user).post(`/api/deliveries/${id}/accept`).expect(200);
      t.clock.advance(1_000);
      await t.ping(courier.user, [t.point()]).expect(202);
      await store.recordDemand(city, CELL, t.clock.nowMs());

      const keys = await t.redis.client.keys(`*${city}*`);

      expect(keys).toEqual(
        expect.arrayContaining([
          courierKey(city, courier.user.id),
          demandKey(city, Math.floor(t.clock.nowMs() / 60_000)),
          trackThrottleKey(city, id),
        ]),
      );
      for (const key of keys) expect(key).toContain(`{${city}}`);
      expect(t.produced(courier.user.id).map((m) => m.key)).toEqual([
        city,
        city,
      ]);
    });

    describe('with every key of city a failing', () => {
      const restores: Array<() => void> = [];
      /** Makes every Redis command that names a key of `city` fail, on the given clients. */
      const faultCity = (city: string, clients: RedisService[]) => {
        for (const redis of clients) {
          const client = redis.client;
          const original = client.sendCommand.bind(client);
          const spy = jest.spyOn(client, 'sendCommand').mockImplementation(((
            command: Command,
            stream?: unknown,
          ) => {
            if (!command.args.some((arg) => String(arg).includes(`{${city}}`)))
              return original(command, stream as never);
            // ioredis callers wait on the command's own promise
            command.reject(new Error('forced fault on the keys of the city'));
            return command.promise;
          }) as never);
          restores.push(() => spy.mockRestore());
        }
      };
      afterEach(() => {
        while (restores.length > 0) restores.pop()?.();
      });

      it('S20 AS-54: city b is still offered, accepted and timed out in the normal times, and the failures are counted for a only', async () => {
        await t.redis.client.del(RING_KEY);
        const cityA = t.uniqueCity('city-a');
        const cityB = t.uniqueCity('city-b');
        await t.onShiftCourier({ city: cityA });
        // the nearer courier of b gets the first offer, the other one the second
        const courierB1 = await t.onShiftCourier({
          city: cityB,
          lat: BERLIN.pickup.lat + 0.001,
        });
        await t.onShiftCourier({ city: cityB, lat: BERLIN.pickup.lat + 0.01 });
        const dueA = await t.requested(cityA);
        const dueB1 = await t.requested(cityB);
        const dueB2 = await t.requested(cityB);
        await t.dispatch(dueB1); // b's first delivery is offered before the fault
        const failuresA = counter('delivery_dispatch_failures_total', cityA);
        const failuresB = counter('delivery_dispatch_failures_total', cityB);
        faultCity(cityA, [t.redis, a.redis, b.redis]);

        // the recovery tick: a's delivery fails, b's is dispatched
        const result = await a.recovery.recoverOverdue(t.clock.now(), null);

        expect(result.dispatchRetries).toBe(1);
        expect((await t.deliveryRow(dueB2)).status).toBe('OFFERED');
        expect(await offerStatus(dueB2)).toEqual(['OFFERED']);
        expect((await t.deliveryRow(dueA)).status).toBe('REQUESTED');
        expect(counter('delivery_dispatch_failures_total', cityA)).toBe(
          failuresA + 2, // the delivery and the index clean-up of the city
        );
        expect(counter('delivery_dispatch_failures_total', cityB)).toBe(
          failuresB,
        );

        // b accepts its offer while a is down
        await t
          .as(courierB1.user)
          .post(`/api/deliveries/${dueB1}/accept`)
          .expect(200);
        expect((await t.deliveryRow(dueB1)).status).toBe('ASSIGNED');

        // b's other offer times out on schedule and goes on to nobody else; a's timer fails and is counted for a
        t.clock.advance(OFFER_TTL_MS);
        const offerB2 = (await t.offerRows(dueB2))[0];
        await a.worker.handle({
          deliveryId: dueB2,
          city: cityB,
          courierId: offerB2.courierId,
          attempt: offerB2.attempt,
        });
        expect(await offerStatus(dueB2)).toEqual(['EXPIRED']);
        await expect(
          a.worker.handle({
            deliveryId: dueA,
            city: cityA,
            courierId: '',
            attempt: 0,
          }),
        ).rejects.toThrow('forced fault');
        expect(counter('delivery_dispatch_failures_total', cityA)).toBe(
          failuresA + 3,
        );
        expect(counter('delivery_dispatch_failures_total', cityB)).toBe(
          failuresB,
        );
      });
    });
  });
});
