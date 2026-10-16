import { v4 as uuidv4 } from 'uuid';
import { SurgeService } from './application/surge.service';
import { geohash } from './domain/geohash';
import {
  DELIVERABLE_ORDER_STORE,
  SURGE_STORE,
  type DeliverableOrderStore,
  type SurgeStore,
} from './domain/delivery-ports';
import { surgeKey } from './infra/courier-keys';
import { DeliveryJobHandlers } from './infra/delivery-job-handlers';
import { COMPUTE_SURGE_JOB } from './infra/delivery-jobs';
import { FakeOrderFulfilment, fakeOrdersModule } from './testing/fake-orders';
import {
  BERLIN,
  createDeliveryApp,
  type DeliveryTestApp,
} from './testing/delivery-fixtures';

const CELL = geohash(BERLIN.pickup.lat, BERLIN.pickup.lng, 5);
const MINUTE = 60_000;
const fakeOrders = new FakeOrderFulfilment();

describe('Delivery surge pricing', () => {
  let t: DeliveryTestApp;
  let surge: SurgeService;
  let store: SurgeStore;
  let orders: DeliverableOrderStore;

  beforeAll(async () => {
    t = await createDeliveryApp({
      extraImports: [fakeOrdersModule(fakeOrders)],
    });
    surge = t.app.get(SurgeService);
    store = t.app.get<SurgeStore>(SURGE_STORE);
    orders = t.app.get<DeliverableOrderStore>(DELIVERABLE_ORDER_STORE);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  /** A shop with an owner, a buyer and `n` paid orders. */
  const shopWithOrders = async (n: number) => {
    const members = await t.shopMembers();
    const orderIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const orderId = uuidv4();
      await orders.applyPaid(
        {
          orderId,
          buyerId: members.buyer.id,
          shopIds: [members.shopId],
          currency: 'EUR',
          orderVersion: 4,
        },
        t.clock.now(),
      );
      orderIds.push(orderId);
    }
    return { ...members, orderIds };
  };
  const request = (
    w: { owner: Parameters<DeliveryTestApp['as']>[0]; shopId: string },
    orderId: string,
    city: string,
  ) =>
    t
      .as(w.owner)
      .post(`/api/shops/${w.shopId}/deliveries`)
      .set('Idempotency-Key', uuidv4())
      .send({
        orderId,
        city,
        pickup: BERLIN.pickup,
        dropoff: BERLIN.dropoff,
      });
  const demand = (city: string, times: number) =>
    Promise.all(
      Array.from({ length: times }, () =>
        store.recordDemand(city, CELL, t.clock.nowMs()),
      ),
    );

  describe('US6 - the minutely computation (AS-49)', () => {
    it('S20 AS-49: one eligible courier and 3 requests in the cell give surge 3.0, and the next request is priced 1497 with surge 3', async () => {
      const w = await shopWithOrders(4);
      const city = t.uniqueCity();
      await t.onShiftCourier({ city });
      for (const orderId of w.orderIds.slice(0, 3))
        await request(w, orderId, city).expect(201);

      const computed = await surge.compute(t.clock.now(), null);

      expect(computed.get(city)).toEqual(new Map([[CELL, 300]]));
      expect(await store.read(city, CELL)).toBe(300);
      const priced = await request(w, w.orderIds[3], city).expect(201);
      expect(priced.body).toMatchObject({ feeMinor: 1497, surge: 3 });
      expect(Number((await t.deliveryRow(priced.body.id)).feeMinor)).toBe(1497);
    });

    it('S20 AS-49: the ratio rounds to quarter steps, is clamped to 3.0 and a cell at ratio 1 or below has no entry', async () => {
      const city = t.uniqueCity();
      await t.onShiftCourier({ city });
      await t.onShiftCourier({ city });
      await demand(city, 3); // 3 / 2 = 1.5

      expect((await surge.compute(t.clock.now(), null)).get(city)).toEqual(
        new Map([[CELL, 150]]),
      );

      await demand(city, 20); // 23 / 2 = 11.5, clamped
      expect((await surge.compute(t.clock.now(), null)).get(city)).toEqual(
        new Map([[CELL, 300]]),
      );

      const quiet = t.uniqueCity();
      await t.onShiftCourier({ city: quiet });
      await demand(quiet, 1); // 1 / 1 = 1.0
      const result = await surge.compute(t.clock.now(), null);
      expect(result.get(quiet)).toEqual(new Map());
      expect(await store.read(quiet, CELL)).toBeNull();
    });

    it('S20 AS-49: requests older than 10 minutes do not count', async () => {
      const city = t.uniqueCity();
      await t.onShiftCourier({ city });
      await demand(city, 3);
      t.clock.advance(10 * MINUTE);
      await demand(city, 2);

      expect((await surge.compute(t.clock.now(), null)).get(city)).toEqual(
        new Map([[CELL, 200]]),
      );

      t.clock.advance(11 * MINUTE);
      expect((await surge.compute(t.clock.now(), null)).get(city)).toEqual(
        new Map(),
      );
      expect(await store.read(city, CELL)).toBeNull();
    });

    it('S20 AS-49: supply counts only eligible couriers - not offline, busy or stale ones', async () => {
      const city = t.uniqueCity();
      await t.onShiftCourier({ city });
      await t.onShiftCourier({ city, ageMs: 61_000 });
      await t.newCourier({ city }); // registered, off shift
      const busy = await t.onShiftCourier({ city });
      await t.makeBusy(busy);
      await demand(city, 3);

      // 3 requests over ONE eligible courier; counting the other three would give 3 / 4 and no entry
      expect((await surge.compute(t.clock.now(), null)).get(city)).toEqual(
        new Map([[CELL, 300]]),
      );
    });

    it('S20 AS-49: the stored map expires after 180 s, and an expired map reads as 1.0 and prices 499', async () => {
      const w = await shopWithOrders(1);
      const city = t.uniqueCity();
      await t.onShiftCourier({ city });
      await demand(city, 3);
      await surge.compute(t.clock.now(), null);

      // Redis expires keys on its own clock: assert the 180 s expiry, then let the key go as it would
      const ttl = await t.redis.client.ttl(surgeKey(city));
      expect(ttl).toBeGreaterThan(170);
      expect(ttl).toBeLessThanOrEqual(180);
      await t.redis.client.del(surgeKey(city));

      expect(await store.read(city, CELL)).toBeNull();
      const res = await request(w, w.orderIds[0], city).expect(201);
      expect(res.body).toMatchObject({ feeMinor: 499, surge: 1 });
    });

    it('S20 AS-49: a city whose demand is gone loses its map at the next computation', async () => {
      const city = t.uniqueCity();
      await t.onShiftCourier({ city });
      await demand(city, 3);
      await surge.compute(t.clock.now(), null);
      expect(await store.read(city, CELL)).toBe(300);

      t.clock.advance(11 * MINUTE);
      await surge.compute(t.clock.now(), null);

      expect(await store.read(city, CELL)).toBeNull();
    });

    it('S20 AS-49: the job is registered as a 60 s schedule with a handler, so a tick is one job claimed once; a repeated run gives the same map', async () => {
      const handlers = t.app.get(DeliveryJobHandlers);
      await handlers.onApplicationBootstrap(); // the schedule rows are emptied by reset
      const [schedule] = await t.sql<{
        cron: string;
        jobType: string;
        overlap: string;
      }>(
        `SELECT "cron", "jobType", "overlap" FROM "JobSchedule" WHERE "name" = :name`,
        { name: COMPUTE_SURGE_JOB },
      );
      expect(schedule).toEqual({
        cron: '0 * * * * *',
        jobType: COMPUTE_SURGE_JOB,
        overlap: 'skip',
      });

      const city = t.uniqueCity();
      await t.onShiftCourier({ city });
      await demand(city, 3);
      await handlers.computeSurge();
      await handlers.computeSurge();
      expect(await store.read(city, CELL)).toBe(300);
    });

    it('S20 AS-49: only cities that have couriers are computed - no whole-geo scan across cities, no Redis city set', async () => {
      const served = t.uniqueCity();
      await t.onShiftCourier({ city: served });
      const unserved = t.uniqueCity();
      await demand(served, 3);
      await demand(unserved, 3);

      const computed = await surge.compute(t.clock.now(), null);

      expect([...computed.keys()]).toContain(served);
      expect(computed.has(unserved)).toBe(false);
      expect(await store.read(unserved, CELL)).toBeNull();
    });
  });
});
