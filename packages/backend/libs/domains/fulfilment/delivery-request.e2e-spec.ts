import { v4 as uuidv4 } from 'uuid';
import {
  deliveryBuyerListSchema,
  deliveryBuyerViewSchema,
  deliveryCourierViewSchema,
  deliveryPageSchema,
  deliveryShopViewSchema,
} from '@marketplace-sandbox/contracts';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { DispatchService } from './application/dispatch.service';
import { geohash } from './domain/geohash';
import {
  DELIVERABLE_ORDER_STORE,
  SURGE_STORE,
  type DeliverableOrderStore,
  type SurgeStore,
} from './domain/delivery-ports';
import {
  BERLIN,
  createDeliveryApp,
  type DeliveryTestApp,
} from './testing/delivery-fixtures';

type Caller = Parameters<DeliveryTestApp['as']>[0];

describe('Delivery request: idempotency, tenant isolation and visibility', () => {
  let t: DeliveryTestApp;
  let orders: DeliverableOrderStore;
  let dispatchService: DispatchService;

  beforeAll(async () => {
    t = await createDeliveryApp();
    orders = t.app.get<DeliverableOrderStore>(DELIVERABLE_ORDER_STORE);
    dispatchService = t.app.get(DispatchService);
  });
  afterAll(() => t.close());
  // Only the spies this file installs are restored: the fixture's own spies live as long as the app.
  const spies: jest.SpyInstance[] = [];
  const spy = <S extends jest.SpyInstance>(instance: S): S => {
    spies.push(instance);
    return instance;
  };
  afterEach(() => {
    while (spies.length > 0) spies.pop()?.mockRestore();
  });
  beforeEach(() => t.reset());

  /** An order the copy knows as paid for `shopIds`. */
  const paidOrder = async (
    shopIds: string[],
    buyerId: string,
    currency = 'EUR',
  ) => {
    const orderId = uuidv4();
    await orders.applyPaid(
      { orderId, buyerId, shopIds, currency, orderVersion: 4 },
      t.clock.now(),
    );
    return orderId;
  };
  const bodyFor = (orderId: string, city: string, extra: object = {}) => ({
    orderId,
    city,
    pickup: BERLIN.pickup,
    dropoff: BERLIN.dropoff,
    ...extra,
  });
  const request = (
    user: Caller,
    shopId: string,
    body: unknown,
    key: string | null = uuidv4(),
  ) => {
    const req = t.as(user).post(`/api/shops/${shopId}/deliveries`);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send(body as object);
  };
  const rowsOf = (shopId: string) =>
    t.sql<{ id: string; status: string; buyerId: string }>(
      `SELECT "id", "status", "buyerId" FROM "Delivery" WHERE "shopId" = :shopId ORDER BY "createdAt", "id"`,
      { shopId },
    );
  const milestones = async (id: string) =>
    (await t.outboxRows(id)).map(
      (o) => (o.payload as { payload: { status: string } }).payload.status,
    );

  /** A shop with an owner, a buyer, a paid order and a city with one courier on shift. */
  const world = async (options: { onShift?: boolean } = {}) => {
    const members = await t.shopMembers();
    const city = t.uniqueCity();
    const courier =
      options.onShift === false
        ? await t.newCourier({ city })
        : await t.onShiftCourier({ city });
    const orderId = await paidOrder([members.shopId], members.buyer.id);
    return { ...members, city, courier, orderId };
  };

  describe('US4 - request, validation and order rules (AS-37 to AS-39)', () => {
    it('S20 AS-37: 201 with Location and a schema-valid body; the buyer comes from the order, the fee and surge are fixed, the first dispatch ran', async () => {
      const w = await world();

      const res = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(201);

      const view = deliveryShopViewSchema.parse(res.body);
      expect(view).toMatchObject({
        orderId: w.orderId,
        status: 'OFFERED',
        city: w.city,
        pickup: BERLIN.pickup,
        dropoff: BERLIN.dropoff,
        feeMinor: 499,
        currency: 'EUR',
        surge: 1,
        createdAt: t.clock.now().toISOString(),
      });
      expect(res.headers.location).toBe(
        `/api/shops/${w.shopId}/deliveries/${view.id}`,
      );
      expect(await t.deliveryRow(view.id)).toMatchObject({
        shopId: w.shopId,
        buyerId: w.buyer.id,
        status: 'OFFERED',
        courierId: null,
      });
      expect(await t.offerRows(view.id)).toMatchObject([
        { courierId: w.courier.user.id, status: 'OFFERED' },
      ]);
      expect(t.queued().map((m) => m.body.deliveryId)).toEqual([view.id]);
    });

    it('S20 AS-37: with no courier on shift the same request answers REQUESTED, with one creation history row and one REQUESTED outbox row', async () => {
      const w = await world({ onShift: false });

      const res = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(201);

      expect(res.body.status).toBe('REQUESTED');
      expect(await t.historyRows(res.body.id)).toMatchObject([
        { from: null, to: 'REQUESTED', version: 1 },
      ]);
      expect(await milestones(res.body.id)).toEqual(['REQUESTED']);
    });

    it('S20 AS-37: the delivery, its history row and its outbox row commit together - a failing outbox write leaves nothing behind', async () => {
      const w = await world();
      spy(jest.spyOn(t.app.get(OutboxService), 'append')).mockRejectedValueOnce(
        new Error('outbox unavailable'),
      );

      const res = await request(w.owner, w.shopId, bodyFor(w.orderId, w.city));

      expect(res.status).toBe(500);
      expect(await rowsOf(w.shopId)).toEqual([]);
      const [{ n }] = await t.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM "DeliveryEvent" e JOIN "Delivery" d ON d."id" = e."deliveryId" WHERE d."shopId" = :shopId`,
        { shopId: w.shopId },
      );
      expect(n).toBe(0);
    });

    it('S20 AS-37: the currency is the order currency and the fee follows the surge of the pickup cell in integer arithmetic', async () => {
      const w = await world();
      const usdOrder = await paidOrder([w.shopId], w.buyer.id, 'USD');
      await t.app
        .get<SurgeStore>(SURGE_STORE)
        .write(
          w.city,
          new Map([[geohash(BERLIN.pickup.lat, BERLIN.pickup.lng, 5), 125]]),
          180,
        );

      const res = await request(
        w.owner,
        w.shopId,
        bodyFor(usdOrder, w.city),
      ).expect(201);

      // round_half_up(499 x 1.25) = 624 (623.75)
      expect(res.body).toMatchObject({
        feeMinor: 624,
        currency: 'USD',
        surge: 1.25,
      });
      expect(Number((await t.deliveryRow(res.body.id)).feeMinor)).toBe(624);
      // the request counted as demand in the pickup cell (window of ten minutes, frozen clock)
      const demand = await t.app
        .get<SurgeStore>(SURGE_STORE)
        .demandByCell(w.city, t.clock.now().getTime());
      expect(demand).toEqual(
        new Map([[geohash(BERLIN.pickup.lat, BERLIN.pickup.lng, 5), 1]]),
      );
    });

    describe.each([
      [
        'orderId missing',
        (b: Record<string, unknown>) => delete b.orderId,
        'orderId',
      ],
      [
        'orderId not a UUID',
        (b: Record<string, unknown>) => (b.orderId = 'order-1'),
        'orderId',
      ],
      [
        'city uppercase',
        (b: Record<string, unknown>) => (b.city = 'Berlin'),
        'city',
      ],
      [
        'city too short',
        (b: Record<string, unknown>) => (b.city = 'b'),
        'city',
      ],
      [
        'pickup missing',
        (b: Record<string, unknown>) => delete b.pickup,
        'pickup',
      ],
      [
        'dropoff missing',
        (b: Record<string, unknown>) => delete b.dropoff,
        'dropoff',
      ],
      [
        'pickup lat above 90',
        (b: Record<string, unknown>) => (b.pickup = { lat: 90.5, lng: 13 }),
        'pickup',
      ],
      [
        'pickup lng above 180',
        (b: Record<string, unknown>) => (b.pickup = { lat: 52, lng: 181 }),
        'pickup',
      ],
      [
        'dropoff lat below -90',
        (b: Record<string, unknown>) => (b.dropoff = { lat: -91, lng: 13 }),
        'dropoff',
      ],
      [
        'dropoff lng below -180',
        (b: Record<string, unknown>) => (b.dropoff = { lat: 52, lng: -181 }),
        'dropoff',
      ],
      [
        'unknown field buyerId',
        (b: Record<string, unknown>) => (b.buyerId = uuidv4()),
        'buyerId',
      ],
      [
        'unknown field feeMinor',
        (b: Record<string, unknown>) => (b.feeMinor = 1),
        'feeMinor',
      ],
      [
        'unknown field surge',
        (b: Record<string, unknown>) => (b.surge = 1),
        'surge',
      ],
    ])('validation class: %s', (name, mutate, field) => {
      it(`S20 AS-38: ${name} is 400 validation_failed naming ${field} and writes no row`, async () => {
        const w = await world();
        const body: Record<string, unknown> = bodyFor(w.orderId, w.city);
        mutate(body);

        const res = await request(w.owner, w.shopId, body).expect(400);

        expect(res.body.code).toBe('validation_failed');
        expect(JSON.stringify(res.body)).toContain(field);
        expect(await rowsOf(w.shopId)).toEqual([]);
      });
    });

    it('S20 AS-38: a route over 30 km is 422 route_too_long and an unserved city is 422 city_not_served; neither writes a row', async () => {
      const w = await world();

      const far = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city, {
          dropoff: { lat: BERLIN.pickup.lat + 0.3, lng: BERLIN.pickup.lng },
        }),
      ).expect(422);
      expect(far.body.code).toBe('route_too_long');

      const unserved = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, t.uniqueCity('nowhere')),
      ).expect(422);
      expect(unserved.body.code).toBe('city_not_served');
      expect(await rowsOf(w.shopId)).toEqual([]);
    });

    it('S20 AS-38: a route of about 3 km is accepted; no credentials is 401; a VIEWER is 403', async () => {
      const w = await world();

      await t
        .http()
        .post(`/api/shops/${w.shopId}/deliveries`)
        .set('Idempotency-Key', uuidv4())
        .send(bodyFor(w.orderId, w.city))
        .expect(401);
      await request(w.viewer, w.shopId, bodyFor(w.orderId, w.city)).expect(403);
      expect(await rowsOf(w.shopId)).toEqual([]);
      await request(w.owner, w.shopId, bodyFor(w.orderId, w.city)).expect(201);
    });

    it('S20 AS-39: a foreign order, an unknown order and an order without this shop are 404 order_not_found; a member of another shop is 404; no row is written', async () => {
      const w = await world();
      const other = await t.shopMembers();
      const foreign = await paidOrder([other.shopId], w.buyer.id);

      for (const orderId of [foreign, uuidv4()]) {
        const res = await request(
          w.owner,
          w.shopId,
          bodyFor(orderId, w.city),
        ).expect(404);
        expect(res.body.code).toBe('order_not_found');
      }
      await request(other.owner, w.shopId, bodyFor(w.orderId, w.city)).expect(
        404,
      );
      expect(await rowsOf(w.shopId)).toEqual([]);
    });

    it('S20 AS-39: a cancelled order is 409 order_not_deliverable', async () => {
      const w = await world();
      await orders.applyCancelled(
        { orderId: w.orderId, buyerId: w.buyer.id, orderVersion: 6 },
        t.clock.now(),
      );

      const res = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(409);

      expect(res.body.code).toBe('order_not_deliverable');
      expect(await rowsOf(w.shopId)).toEqual([]);
    });

    it('S20 AS-39: an open delivery for the order is 409 delivery_already_open; a DELIVERED one is 409 delivery_already_completed; after a CANCELLED one a new delivery is created', async () => {
      const w = await world();
      const first = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(201);

      const open = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(409);
      expect(open.body.code).toBe('delivery_already_open');

      await t.sql(
        `UPDATE "Delivery" SET "status" = 'DELIVERED' WHERE "id" = :id RETURNING "id"`,
        { id: first.body.id },
      );
      const done = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(409);
      expect(done.body.code).toBe('delivery_already_completed');

      const second = await paidOrder([w.shopId], w.buyer.id);
      const cancelled = await request(
        w.owner,
        w.shopId,
        bodyFor(second, w.city),
      ).expect(201);
      await t
        .as(w.owner)
        .post(`/api/shops/${w.shopId}/deliveries/${cancelled.body.id}/cancel`)
        .send({ reason: 'changed_plans' })
        .expect(200);
      const again = await request(
        w.owner,
        w.shopId,
        bodyFor(second, w.city),
      ).expect(201);
      expect(again.body.id).not.toBe(cancelled.body.id);
      const statuses = new Map(
        (await rowsOf(w.shopId)).map((r) => [r.id, r.status]),
      );
      expect(statuses.get(first.body.id)).toBe('DELIVERED');
      expect(statuses.get(cancelled.body.id)).toBe('CANCELLED');
      expect(statuses.size).toBe(3);
    });
  });

  describe('US4 - idempotency, concurrency, limits and rate (AS-40 to AS-43)', () => {
    it('S20 AS-40: a replay with the same key and body returns the stored 201 body; one row, one outbox row and one dispatch exist', async () => {
      const w = await world();
      const dispatch = spy(jest.spyOn(dispatchService, 'dispatch'));
      const key = uuidv4();
      const body = bodyFor(w.orderId, w.city);

      const first = await request(w.owner, w.shopId, body, key).expect(201);
      const replay = await request(w.owner, w.shopId, body, key).expect(201);

      expect(replay.body).toEqual(first.body);
      expect(replay.headers.location).toBe(first.headers.location);
      expect(await rowsOf(w.shopId)).toHaveLength(1);
      expect(await milestones(first.body.id)).toEqual(['REQUESTED']);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('S20 AS-40: a request with the key still in flight is 409 idempotency_in_flight; once it finishes the key replays', async () => {
      const w = await world();
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const latch = new Promise<void>((resolve) => (release = resolve));
      const original = dispatchService.dispatch.bind(dispatchService);
      spy(jest.spyOn(dispatchService, 'dispatch')).mockImplementation(
        async (...args) => {
          entered();
          await latch;
          return original(...args);
        },
      );
      const key = uuidv4();
      const body = bodyFor(w.orderId, w.city);

      const pending = request(w.owner, w.shopId, body, key).then((r) => r);
      await inside;
      const busy = await request(w.owner, w.shopId, body, key).expect(409);
      release();
      const first = await pending;

      expect(busy.body.code).toBe('idempotency_in_flight');
      expect(first.status).toBe(201);
      const replay = await request(w.owner, w.shopId, body, key).expect(201);
      expect(replay.body.id).toBe(first.body.id);
      expect(await rowsOf(w.shopId)).toHaveLength(1);
    });

    it('S20 AS-40: the key reused with a different body is 422 idempotency_key_reuse', async () => {
      const w = await world();
      const key = uuidv4();
      await request(w.owner, w.shopId, bodyFor(w.orderId, w.city), key).expect(
        201,
      );
      const other = await paidOrder([w.shopId], w.buyer.id);

      const res = await request(
        w.owner,
        w.shopId,
        bodyFor(other, w.city),
        key,
      ).expect(422);

      expect(res.body.code).toBe('idempotency_key_reuse');
      expect(await rowsOf(w.shopId)).toHaveLength(1);
    });

    it('S20 AS-40: a missing key is 422 idempotency_key_required and a malformed key is 422 idempotency_key_invalid; no row is written', async () => {
      const w = await world();
      const body = bodyFor(w.orderId, w.city);

      const missing = await request(w.owner, w.shopId, body, null).expect(422);
      const malformed = await request(
        w.owner,
        w.shopId,
        body,
        'not valid!',
      ).expect(422);

      expect(missing.body.code).toBe('idempotency_key_required');
      expect(malformed.body.code).toBe('idempotency_key_invalid');
      expect(await rowsOf(w.shopId)).toEqual([]);
    });

    it('S20 AS-41: two requests with different keys for one order at the same moment give exactly one 201 and one delivery_already_open', async () => {
      const w = await world();
      const body = bodyFor(w.orderId, w.city);

      const results = await Promise.all([
        request(w.owner, w.shopId, body),
        request(w.owner, w.shopId, body),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe(
        'delivery_already_open',
      );
      expect(await rowsOf(w.shopId)).toHaveLength(1);
    });

    const seedOpen = async (
      shopId: string,
      buyerId: string,
      n: number,
      city: string,
    ) => {
      for (let i = 0; i < n; i++)
        await t.requested(city, { shopId, buyerId, orderId: uuidv4() });
    };

    it('S20 AS-42: with 200 open deliveries a request is 409 open_delivery_limit and writes no row', async () => {
      const w = await world();
      await seedOpen(w.shopId, w.buyer.id, 200, w.city);

      const res = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(409);

      expect(res.body.code).toBe('open_delivery_limit');
      expect(await rowsOf(w.shopId)).toHaveLength(200);
    }, 120_000);

    it('S20 AS-42: with 199 open deliveries two requests for different orders race and exactly one succeeds; the shop never exceeds 200', async () => {
      const w = await world();
      await seedOpen(w.shopId, w.buyer.id, 199, w.city);
      const second = await paidOrder([w.shopId], w.buyer.id);

      const results = await Promise.all([
        request(w.owner, w.shopId, bodyFor(w.orderId, w.city)),
        request(w.owner, w.shopId, bodyFor(second, w.city)),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe(
        'open_delivery_limit',
      );
      expect(await rowsOf(w.shopId)).toHaveLength(200);
    }, 120_000);

    it('S20 AS-43: the 61st request in a minute is 429 rate_limited with Retry-After and writes no row; another shop is unaffected', async () => {
      const w = await world();
      // 60 requests in two waves of 30 at once (was one by one); every answer is still checked
      for (let wave = 0; wave < 2; wave++)
        await Promise.all(
          Array.from({ length: 30 }, () =>
            request(w.owner, w.shopId, bodyFor(uuidv4(), w.city)).expect(404),
          ),
        );

      const limited = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(429);

      expect(limited.body.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(await rowsOf(w.shopId)).toEqual([]);
      const other = await world();
      await request(
        other.owner,
        other.shopId,
        bodyFor(other.orderId, other.city),
      ).expect(201);
    }, 120_000);

    it('S20 AS-43: with the limiter store down the request fails closed with 503 rate_limiter_unavailable and writes no row', async () => {
      const w = await world();
      t.limiterStoreDown(true);

      const res = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(503);

      expect(res.body.code).toBe('rate_limiter_unavailable');
      expect(await rowsOf(w.shopId)).toEqual([]);
    });
  });

  describe('US4 - who can see a delivery (AS-44)', () => {
    /** A delivery of the world accepted by its courier, who has reported a position. */
    const assigned = async () => {
      const w = await world();
      const created = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(201);
      const id: string = created.body.id;
      const offered = await t
        .as(w.courier.user)
        .get(`/api/deliveries/${id}`)
        .expect(200);
      await t
        .as(w.courier.user)
        .post(`/api/deliveries/${id}/accept`)
        .expect(200);
      await t.ping(w.courier.user, [t.point(0)]).expect(202);
      return { ...w, id, offered: offered.body };
    };
    const readAs = (user: Caller, id: string) =>
      t.as(user).get(`/api/deliveries/${id}`);

    it('S20 AS-44: the buyer sees the buyer view with the courier vehicle and a fresh position, and no courier id, offer, attempt or version', async () => {
      const a = await assigned();

      const res = await readAs(a.buyer, a.id).expect(200);

      const view = deliveryBuyerViewSchema.parse(res.body);
      expect(Object.keys(res.body).sort()).toEqual([
        'courier',
        'createdAt',
        'currency',
        'dropoff',
        'feeMinor',
        'id',
        'orderId',
        'pickup',
        'status',
        'updatedAt',
      ]);
      expect(view).toMatchObject({
        id: a.id,
        orderId: a.orderId,
        status: 'ASSIGNED',
        feeMinor: 499,
        courier: {
          vehicle: 'bike',
          position: {
            ...BERLIN.pickup,
            ts: t.clock.now().getTime(),
            stale: false,
          },
        },
      });
      expect(JSON.stringify(res.body)).not.toContain(a.courier.user.id);
    });

    it('S20 AS-44: the position is stale after 60 seconds and shown only while ASSIGNED or PICKED_UP', async () => {
      const a = await assigned();

      t.clock.advance(61_000);
      const stale = await readAs(a.buyer, a.id).expect(200);
      expect(stale.body.courier.position.stale).toBe(true);

      await t.sql(
        `UPDATE "Delivery" SET "status" = 'PICKED_UP' WHERE "id" = :id RETURNING "id"`,
        { id: a.id },
      );
      const moving = await readAs(a.buyer, a.id).expect(200);
      expect(moving.body.courier.position).toBeDefined();

      await t.sql(
        `UPDATE "Delivery" SET "status" = 'DELIVERED' WHERE "id" = :id RETURNING "id"`,
        { id: a.id },
      );
      const done = await readAs(a.buyer, a.id).expect(200);
      expect(done.body.courier).toEqual({ vehicle: 'bike' });
    });

    it('S20 AS-44: before any courier is assigned the buyer view has no courier', async () => {
      const w = await world();
      const created = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(201);

      const res = await readAs(w.buyer, created.body.id).expect(200);

      expect(res.body.status).toBe('OFFERED');
      expect(res.body.courier).toBeUndefined();
    });

    it('S20 AS-44: the assigned courier sees the courier view without the buyer id', async () => {
      const a = await assigned();

      const res = await readAs(a.courier.user, a.id).expect(200);

      deliveryCourierViewSchema.parse(res.body);
      expect(Object.keys(res.body).sort()).toEqual([
        'currency',
        'dropoff',
        'feeMinor',
        'id',
        'pickup',
        'status',
      ]);
      expect(res.body.status).toBe('ASSIGNED');
      expect(JSON.stringify(res.body)).not.toContain(a.buyer.id);
    });

    it('S20 AS-44: a courier holding the live offer sees the courier view with offerExpiresAt and no buyer id', async () => {
      const a = await assigned();

      expect(a.offered).toEqual({
        id: a.id,
        status: 'OFFERED',
        pickup: BERLIN.pickup,
        dropoff: BERLIN.dropoff,
        feeMinor: 499,
        currency: 'EUR',
        offerExpiresAt: new Date(
          t.clock.now().getTime() + 15_000,
        ).toISOString(),
      });
    });

    it('S20 AS-44: another buyer, another courier, a courier whose offer was declined, a member of another shop and the shop itself get 404 delivery_not_found', async () => {
      const a = await assigned();
      const b2 = await t.newUser();
      const c3 = await t.onShiftCourier({ city: a.city });
      const declined = await t.onShiftCourier({ city: a.city });
      await t.seedOffer({
        deliveryId: a.id,
        courierId: declined.user.id,
        status: 'DECLINED',
        attempt: 2,
      });
      const other = await t.shopMembers();

      for (const who of [b2, c3.user, declined.user, other.owner, a.owner]) {
        const res = await readAs(who, a.id).expect(404);
        expect(res.body.code).toBe('delivery_not_found');
      }
    });

    it('S20 AS-44: no credentials is 401 and an id that is not a UUID is 400', async () => {
      const a = await assigned();

      await t.http().get(`/api/deliveries/${a.id}`).expect(401);
      await readAs(a.buyer, 'not-a-uuid').expect(400);
      await readAs(a.buyer, uuidv4()).expect(404);
    });

    it("S20 AS-44: GET /orders/:orderId/deliveries lists the buyer's own deliveries for the order only; another buyer gets an empty list", async () => {
      const a = await assigned();
      const b2 = await t.newUser();

      const mine = await t
        .as(a.buyer)
        .get(`/api/orders/${a.orderId}/deliveries`)
        .expect(200);
      const theirs = await t
        .as(b2)
        .get(`/api/orders/${a.orderId}/deliveries`)
        .expect(200);

      const list = deliveryBuyerListSchema.parse(mine.body);
      expect(list.items.map((i) => i.id)).toEqual([a.id]);
      expect(list.items[0].courier?.position?.stale).toBe(false);
      expect(theirs.body).toEqual({ items: [] });
      await t.http().get(`/api/orders/${a.orderId}/deliveries`).expect(401);
      await t.as(a.buyer).get('/api/orders/not-a-uuid/deliveries').expect(400);
    });
  });

  describe('US4 - shop reads (AS-45)', () => {
    const STATUSES = [
      'REQUESTED',
      'OFFERED',
      'ASSIGNED',
      'PICKED_UP',
      'DELIVERED',
      'CANCELLED',
    ] as const;

    /** 45 deliveries of the shop (ties on createdAt every third row) and 5 of another shop. */
    const seeded = async () => {
      const m = await t.shopMembers();
      const other = await t.shopMembers();
      const city = t.uniqueCity();
      const ids: string[] = [];
      for (let i = 0; i < 45; i++) {
        if (i % 3 === 0) t.clock.advance(1_000);
        const status = STATUSES[i % STATUSES.length];
        ids.push(
          await t.seedDelivery({
            shopId: m.shopId,
            buyerId: m.buyer.id,
            city,
            status,
            courierId: null,
            orderId: uuidv4(),
          }),
        );
      }
      for (let i = 0; i < 5; i++)
        await t.seedDelivery({
          shopId: other.shopId,
          buyerId: other.buyer.id,
          city,
        });
      return { ...m, other, ids };
    };
    const page = (user: Caller, shopId: string, query: string) =>
      t.as(user).get(`/api/shops/${shopId}/deliveries${query}`);

    it('S20 AS-45: pages of 20, 20 and 5 arrive newest first then by id descending, with an opaque cursor, no duplicates and no misses, only this shop', async () => {
      const s = await seeded();
      const expected = (
        await t.sql<{ id: string }>(
          `SELECT "id" FROM "Delivery" WHERE "shopId" = :shopId ORDER BY "createdAt" DESC, "id" DESC`,
          { shopId: s.shopId },
        )
      ).map((r) => r.id);

      const p1 = await page(s.owner, s.shopId, '?limit=20').expect(200);
      const first = deliveryPageSchema.parse(p1.body);
      expect(typeof first.nextCursor).toBe('string');
      for (const id of expected.slice(0, 20))
        expect(first.nextCursor).not.toContain(id);
      const p2 = await page(
        s.viewer,
        s.shopId,
        `?limit=20&cursor=${encodeURIComponent(first.nextCursor!)}`,
      ).expect(200);
      const second = deliveryPageSchema.parse(p2.body);
      const p3 = await page(
        s.owner,
        s.shopId,
        `?limit=20&cursor=${encodeURIComponent(second.nextCursor!)}`,
      ).expect(200);
      const third = deliveryPageSchema.parse(p3.body);

      expect([
        first.items.length,
        second.items.length,
        third.items.length,
      ]).toEqual([20, 20, 5]);
      expect(third.nextCursor).toBeNull();
      const all = [...first.items, ...second.items, ...third.items];
      expect(all.map((i) => i.id)).toEqual(expected);
      expect(new Set(all.map((i) => i.id)).size).toBe(45);
      const times = all.map((i) => i.createdAt);
      expect([...times].sort().reverse()).toEqual(times);
      expect(all.every((i) => i.history === undefined)).toBe(true);
    }, 120_000);

    it('S20 AS-45: the status filter returns only that status', async () => {
      const s = await seeded();

      const res = await page(
        s.owner,
        s.shopId,
        '?status=CANCELLED&limit=50',
      ).expect(200);

      const view = deliveryPageSchema.parse(res.body);
      expect(view.items).toHaveLength(7);
      expect(view.items.every((i) => i.status === 'CANCELLED')).toBe(true);
      expect(view.nextCursor).toBeNull();
    }, 120_000);

    it.each([
      ['an unknown status', '?status=BOGUS'],
      ['limit 0', '?limit=0'],
      ['limit 51', '?limit=51'],
      ['limit not a number', '?limit=many'],
      ['a malformed cursor', '?cursor=not-a-cursor'],
      ['an unknown parameter', '?sort=asc'],
    ])('S20 AS-45: %s is 400 validation_failed', async (_name, query) => {
      const m = await t.shopMembers();

      const res = await page(m.owner, m.shopId, query).expect(400);

      expect(res.body.code).toBe('validation_failed');
    });

    it('S20 AS-45: the detail has the transition history and neither the courier id nor courier coordinates; another shop is 404; no credentials is 401', async () => {
      const w = await world();
      const created = await request(
        w.owner,
        w.shopId,
        bodyFor(w.orderId, w.city),
      ).expect(201);
      const id: string = created.body.id;
      const other = await t.shopMembers();

      const res = await t
        .as(w.viewer)
        .get(`/api/shops/${w.shopId}/deliveries/${id}`)
        .expect(200);

      const view = deliveryShopViewSchema.parse(res.body);
      expect(view.history?.map((h) => [h.from, h.to])).toEqual([
        [null, 'REQUESTED'],
        ['REQUESTED', 'OFFERED'],
      ]);
      for (const entry of view.history ?? [])
        expect(Object.keys(entry).sort()).toEqual(
          expect.arrayContaining(['actorKind', 'at', 'to']),
        );
      expect(JSON.stringify(res.body)).not.toContain(w.courier.user.id);
      expect(res.body.courier).toBeUndefined();
      // a member of another shop: the shop gate answers 404 on this shop, and 404 delivery_not_found on their own
      await t
        .as(other.owner)
        .get(`/api/shops/${w.shopId}/deliveries/${id}`)
        .expect(404);
      const foreign = await t
        .as(other.owner)
        .get(`/api/shops/${other.shopId}/deliveries/${id}`)
        .expect(404);
      expect(foreign.body.code).toBe('delivery_not_found');
      await t.http().get(`/api/shops/${w.shopId}/deliveries/${id}`).expect(401);
      await t.http().get(`/api/shops/${w.shopId}/deliveries`).expect(401);
    });
  });
});
