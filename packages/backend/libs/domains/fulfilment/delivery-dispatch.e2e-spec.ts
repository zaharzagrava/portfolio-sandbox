import { deliveryCourierViewSchema } from '@marketplace-sandbox/contracts';
import { DispatchService } from './application/dispatch.service';
import { RecoveryService } from './application/recovery.service';
import { OFFER_GUARD, type OfferGuard } from './domain/delivery-ports';
import { OFFER_TIMEOUT_QUEUE } from './infra/dispatch-timers';
import {
  BERLIN,
  createDeliveryApp,
  type DeliveryTestApp,
  type DeliveryTestCourier,
} from './testing/delivery-fixtures';

/** Degrees of latitude per kilometre: couriers are placed due north of the pickup. */
const KM = 1 / 111.2;
const north = (km: number) => BERLIN.pickup.lat + km * KM;
const OFFER_TTL_MS = 15_000;

describe('Delivery dispatch: offers, timeouts, races, durable timers', () => {
  let t: DeliveryTestApp;
  let dispatch: DispatchService;
  let recovery: RecoveryService;

  beforeAll(async () => {
    t = await createDeliveryApp();
    dispatch = t.app.get(DispatchService);
    recovery = t.app.get(RecoveryService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const accept = (courier: DeliveryTestCourier, deliveryId: string) =>
    t.as(courier.user).post(`/api/deliveries/${deliveryId}/accept`);
  const decline = (courier: DeliveryTestCourier, deliveryId: string) =>
    t.as(courier.user).post(`/api/deliveries/${deliveryId}/decline`);
  const timer = (
    deliveryId: string,
    city: string,
    courierId: string,
    attempt: number,
  ) => ({ deliveryId, city, courierId, attempt });
  const offerStatuses = async (deliveryId: string) =>
    (await t.offerRows(deliveryId)).map((o) => [o.courierId, o.status]);

  /** Three couriers on shift about 0.3, 1 and 2.5 km from the pickup. */
  const threeCouriers = async (city: string) => {
    const c1 = await t.onShiftCourier({ city, lat: north(0.3) });
    const c2 = await t.onShiftCourier({ city, lat: north(1) });
    const c3 = await t.onShiftCourier({ city, lat: north(2.5) });
    return { c1, c2, c3 };
  };

  describe('US2 - offers (AS-14, AS-15)', () => {
    it('S20 AS-14: the nearest courier gets the offer with attempt 1 and a 15 s expiry; record, timer, push and history agree', async () => {
      const city = t.uniqueCity();
      const { c1, c2, c3 } = await threeCouriers(city);
      const d1 = await t.requested(city);
      const now = t.clock.now();

      await dispatch.dispatch(d1);

      const row = await t.deliveryRow(d1);
      expect(row).toMatchObject({
        status: 'OFFERED',
        attempt: 1,
        courierId: null,
        version: 2,
      });
      expect(row.nextActionAt).toEqual(new Date(now.getTime() + OFFER_TTL_MS));
      const offers = await t.offerRows(d1);
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        courierId: c1.user.id,
        attempt: 1,
        status: 'OFFERED',
        respondedAt: null,
      });
      expect(offers[0].expiresAt).toEqual(
        new Date(now.getTime() + OFFER_TTL_MS),
      );
      expect(t.queued()).toEqual([
        {
          queue: OFFER_TIMEOUT_QUEUE,
          body: timer(d1, city, c1.user.id, 1),
          delaySeconds: 15,
        },
      ]);
      expect(t.pushes(`user:${c1.user.id}`)).toEqual([
        expect.objectContaining({
          type: 'delivery_offer',
          data: {
            deliveryId: d1,
            pickup: BERLIN.pickup,
            dropoff: BERLIN.dropoff,
            feeMinor: 499,
            currency: 'EUR',
            expiresAt: new Date(now.getTime() + OFFER_TTL_MS).toISOString(),
          },
        }),
      ]);
      expect(t.pushes(`user:${c2.user.id}`)).toEqual([]);
      expect(t.pushes(`user:${c3.user.id}`)).toEqual([]);
      expect(await t.historyRows(d1)).toEqual([
        expect.objectContaining({ from: null, to: 'REQUESTED', version: 1 }),
        expect.objectContaining({
          from: 'REQUESTED',
          to: 'OFFERED',
          actorKind: 'system',
          actorId: c1.user.id,
          version: 2,
        }),
      ]);
      expect(await t.outboxRows(d1)).toHaveLength(0);
    });

    it('S20 AS-15: a decline answers 204, moves on to the next courier with attempt 2, keeps the decliner AVAILABLE and never offers it the delivery again', async () => {
      const city = t.uniqueCity();
      const { c1, c2, c3 } = await threeCouriers(city);
      const d1 = await t.requested(city);
      await dispatch.dispatch(d1);

      await decline(c1, d1).expect(204);

      expect(await t.offerRows(d1)).toEqual([
        expect.objectContaining({
          courierId: c1.user.id,
          status: 'DECLINED',
          attempt: 1,
          respondedAt: t.clock.now(),
        }),
        expect.objectContaining({
          courierId: c2.user.id,
          status: 'OFFERED',
          attempt: 2,
        }),
      ]);
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'OFFERED',
        attempt: 2,
      });
      expect((await t.courierRow(c1.user.id))?.status).toBe('AVAILABLE');
      expect(t.queued().map((q) => q.body)).toEqual([
        timer(d1, city, c1.user.id, 1),
        timer(d1, city, c2.user.id, 2),
      ]);

      // C1 pings again and the other two decline: the permanent exclusion (the offer record) keeps C1 out.
      await t.ping(c1.user, [t.point(0, north(0.3))]).expect(202);
      await decline(c2, d1).expect(204);
      await decline(c3, d1).expect(204);

      expect(await offerStatuses(d1)).toEqual([
        [c1.user.id, 'DECLINED'],
        [c2.user.id, 'DECLINED'],
        [c3.user.id, 'DECLINED'],
      ]);
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'REQUESTED',
        attempt: 4,
      });
    });
  });

  describe('US2 - timeouts and eligibility (AS-16, AS-17)', () => {
    it('S20 AS-16: the timer expires the offer, withdraws it, offers the next courier; a duplicate and stale messages change nothing', async () => {
      const city = t.uniqueCity();
      const { c1, c2 } = await threeCouriers(city);
      const d1 = await t.requested(city);
      await dispatch.dispatch(d1);
      t.clock.advance(OFFER_TTL_MS);

      await dispatch.onTimer(timer(d1, city, c1.user.id, 1));

      expect(await offerStatuses(d1)).toEqual([
        [c1.user.id, 'EXPIRED'],
        [c2.user.id, 'OFFERED'],
      ]);
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'OFFERED',
        attempt: 2,
      });
      expect(t.pushes(`user:${c1.user.id}`).map((p) => p.type)).toEqual([
        'delivery_offer',
        'delivery_offer_withdrawn',
      ]);
      expect(t.pushes(`user:${c1.user.id}`)[1].data).toEqual({
        deliveryId: d1,
      });
      expect(
        (await t.historyRows(d1)).map((h) => [h.from, h.to, h.detail]),
      ).toEqual([
        [null, 'REQUESTED', null],
        ['REQUESTED', 'OFFERED', null],
        ['OFFERED', 'REQUESTED', 'timeout'],
        ['REQUESTED', 'OFFERED', null],
      ]);

      const before = {
        row: await t.deliveryRow(d1),
        offers: await t.offerRows(d1),
        history: (await t.historyRows(d1)).length,
        queued: t.queued().length,
      };
      await dispatch.onTimer(timer(d1, city, c1.user.id, 1)); // duplicate
      await dispatch.onTimer(timer(d1, city, c1.user.id, 2)); // wrong attempt
      await dispatch.onTimer(timer(d1, city, c2.user.id, 1)); // wrong courier
      await dispatch.onTimer(timer(d1, city, c2.user.id, 2)); // right pair, but the offer is not over yet
      expect({
        row: await t.deliveryRow(d1),
        offers: await t.offerRows(d1),
        history: (await t.historyRows(d1)).length,
        queued: t.queued().length,
      }).toEqual(before);
    });

    it('S20 AS-16: a timer for an offer that was accepted or declined meanwhile is a no-op', async () => {
      const city = t.uniqueCity();
      const { c1, c2 } = await threeCouriers(city);
      const accepted = await t.requested(city);
      await dispatch.dispatch(accepted);
      await accept(c1, accepted).expect(200);
      const declined = await t.requested(city);
      await dispatch.dispatch(declined);
      await decline(c2, declined).expect(204);
      t.clock.advance(OFFER_TTL_MS);
      const snapshot = async () => [
        await t.deliveryRow(accepted),
        await t.deliveryRow(declined),
        await t.offerRows(accepted),
        await t.offerRows(declined),
      ];
      const before = await snapshot();

      await dispatch.onTimer(timer(accepted, city, c1.user.id, 1));
      await dispatch.onTimer(timer(declined, city, c2.user.id, 1));

      expect(await snapshot()).toEqual(before);
    });

    it('S20 AS-17: a position 61 s old is skipped, 60 s old is eligible, a fresh ping makes the courier eligible again', async () => {
      const stale = t.uniqueCity();
      const old = await t.onShiftCourier({ city: stale, ageMs: 61_000 });
      const fallback = await t.onShiftCourier({
        city: stale,
        lat: north(1),
      });
      const d1 = await t.requested(stale);
      await dispatch.dispatch(d1);
      expect(await offerStatuses(d1)).toEqual([[fallback.user.id, 'OFFERED']]);

      const edge = t.uniqueCity();
      const exact = await t.onShiftCourier({ city: edge, ageMs: 60_000 });
      const d2 = await t.requested(edge);
      await dispatch.dispatch(d2);
      expect(await offerStatuses(d2)).toEqual([[exact.user.id, 'OFFERED']]);

      // The 61 s courier reports a fresh point and gets the next delivery.
      await t.ping(old.user, [t.point(0)]).expect(202);
      const d3 = await t.requested(stale);
      await dispatch.dispatch(d3);
      expect(await offerStatuses(d3)).toEqual([[old.user.id, 'OFFERED']]);
    });

    it('S20 AS-17: a courier who went AVAILABLE but never reported a point is not eligible', async () => {
      const city = t.uniqueCity();
      await t.newCourier({ city, status: 'AVAILABLE' });
      const d1 = await t.requested(city);

      await dispatch.dispatch(d1);

      expect(await t.offerRows(d1)).toEqual([]);
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'REQUESTED',
        attempt: 1,
      });
    });
  });

  describe('US2 - widening radii and retries (AS-18, AS-19, AS-20)', () => {
    it('S20 AS-18: a courier about 5 km away is found in the 6 km step and offered', async () => {
      const city = t.uniqueCity();
      const far = await t.onShiftCourier({ city, lat: north(5) });
      const d1 = await t.requested(city);

      await dispatch.dispatch(d1);

      expect(await offerStatuses(d1)).toEqual([[far.user.id, 'OFFERED']]);
    });

    it('S20 AS-18: the nearer of two eligible couriers is offered first, whatever the radius step it was found in', async () => {
      const city = t.uniqueCity();
      await t.onShiftCourier({ city, lat: north(5) });
      const near = await t.onShiftCourier({ city, lat: north(0.5) });
      const d1 = await t.requested(city);

      await dispatch.dispatch(d1);

      expect(await offerStatuses(d1)).toEqual([[near.user.id, 'OFFERED']]);
    });

    it('S20 AS-18: a courier about 14 km away is out of reach: nobody is offered, the attempt is consumed and a retry is queued in 20 s', async () => {
      const city = t.uniqueCity();
      await t.onShiftCourier({ city, lat: north(14) });
      const d1 = await t.requested(city);
      const now = t.clock.now();

      await dispatch.dispatch(d1);

      const row = await t.deliveryRow(d1);
      expect(row).toMatchObject({
        status: 'REQUESTED',
        attempt: 1,
        version: 1,
      });
      expect(row.nextActionAt).toEqual(new Date(now.getTime() + 20_000));
      expect(await t.offerRows(d1)).toEqual([]);
      expect(t.queued()).toEqual([
        {
          queue: OFFER_TIMEOUT_QUEUE,
          body: timer(d1, city, '', 1),
          delaySeconds: 20,
        },
      ]);
    });

    it('S20 AS-19: when the retry timer fires and a courier has become eligible, that courier is offered; stale retries are ignored', async () => {
      const city = t.uniqueCity();
      const d1 = await t.requested(city);
      await dispatch.dispatch(d1);
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'REQUESTED',
        attempt: 1,
      });
      t.clock.advance(20_000);
      const late = await t.onShiftCourier({ city });

      await dispatch.onTimer(t.queued()[0].body);

      expect(await offerStatuses(d1)).toEqual([[late.user.id, 'OFFERED']]);
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'OFFERED',
        attempt: 2,
      });

      // a retry whose attempt differs, and one for a delivery that is no longer REQUESTED
      const d2 = await t.requested(city, { attempt: 3 });
      const before = [await t.deliveryRow(d2), await t.deliveryRow(d1)];
      await dispatch.onTimer(timer(d2, city, '', 2));
      await dispatch.onTimer(timer(d1, city, '', 1));
      expect([await t.deliveryRow(d2), await t.deliveryRow(d1)]).toEqual(
        before,
      );
      expect(await t.offerRows(d2)).toEqual([]);
    });

    it('S20 AS-20: the eighth consumed attempt ends in CANCELLED no_courier_available with a push, an outbox event and no further timer; a late timer is a no-op', async () => {
      const city = t.uniqueCity();
      const d1 = await t.requested(city, { attempt: 0 });
      const buyer = (await t.deliveryRow(d1)).buyerId;
      await dispatch.dispatch(d1);
      for (let attempt = 1; attempt < 8; attempt++) {
        t.clock.advance(20_000);
        await dispatch.onTimer(timer(d1, city, '', attempt));
      }
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'REQUESTED',
        attempt: 8,
      });
      expect(t.queued()).toHaveLength(8);

      t.clock.advance(20_000);
      await dispatch.onTimer(timer(d1, city, '', 8));

      const row = await t.deliveryRow(d1);
      expect(row).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'no_courier_available',
        nextActionAt: null,
      });
      expect(t.queued()).toHaveLength(8);
      const last = (await t.historyRows(d1)).at(-1);
      expect(last).toMatchObject({
        from: 'REQUESTED',
        to: 'CANCELLED',
        actorKind: 'system',
        detail: 'no_courier_available',
      });
      const outbox = await t.outboxRows(d1);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].payload).toMatchObject({
        type: 'delivery.status_changed',
        payload: {
          deliveryId: d1,
          buyerId: buyer,
          status: 'CANCELLED',
          previousStatus: 'REQUESTED',
          reason: 'no_courier_available',
          deliveryVersion: 2,
        },
      });
      expect(t.pushes(`delivery:${d1}`).at(-1)).toMatchObject({
        type: 'status',
        data: { status: 'CANCELLED', deliveryVersion: 2 },
      });

      const before = [row, (await t.historyRows(d1)).length];
      await dispatch.onTimer(timer(d1, city, '', 8));
      expect([
        await t.deliveryRow(d1),
        (await t.historyRows(d1)).length,
      ]).toEqual(before);
      expect(await t.outboxRows(d1)).toHaveLength(1);
    });

    it('S20 AS-20: a delivery that already used its attempts on offers is cancelled by the next dispatch step', async () => {
      const city = t.uniqueCity();
      const d1 = await t.requested(city, { attempt: 8 });

      await dispatch.dispatch(d1);

      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'no_courier_available',
      });
      expect(t.queued()).toEqual([]);
    });
  });

  describe('US2 - one live offer and one assignment per courier (AS-21, AS-22)', () => {
    it('S20 AS-21: two deliveries racing for one courier: exactly one is OFFERED, the other REQUESTED with a retry timer', async () => {
      const city = t.uniqueCity();
      const c1 = await t.onShiftCourier({ city });
      const da = await t.requested(city);
      const db = await t.requested(city);

      await Promise.all([dispatch.dispatch(da), dispatch.dispatch(db)]);

      const rows = [await t.deliveryRow(da), await t.deliveryRow(db)];
      expect(rows.map((r) => r.status).sort()).toEqual([
        'OFFERED',
        'REQUESTED',
      ]);
      const loser = rows.find((r) => r.status === 'REQUESTED')!;
      expect(loser.attempt).toBe(1);
      const live = await t.sql(
        `SELECT "deliveryId" FROM "DeliveryOffer" WHERE "courierId" = :id AND "status" = 'OFFERED'`,
        { id: c1.user.id },
      );
      expect(live).toHaveLength(1);
      expect(t.queued().map((q) => q.body)).toEqual(
        expect.arrayContaining([timer(loser.id, city, '', 1)]),
      );
    });

    it('S20 AS-21: the same race with the cache guard forced to lose is decided by the store of record', async () => {
      const city = t.uniqueCity();
      const c1 = await t.onShiftCourier({ city });
      const da = await t.requested(city);
      const db = await t.requested(city);
      const guard = t.app.get<OfferGuard>(OFFER_GUARD);
      const spy = jest.spyOn(guard, 'tryAcquire').mockResolvedValue(true);

      try {
        await Promise.all([dispatch.dispatch(da), dispatch.dispatch(db)]);
      } finally {
        spy.mockRestore();
      }

      const rows = [await t.deliveryRow(da), await t.deliveryRow(db)];
      expect(rows.map((r) => r.status).sort()).toEqual([
        'OFFERED',
        'REQUESTED',
      ]);
      expect(
        await t.sql(
          `SELECT 1 AS "one" FROM "DeliveryOffer" WHERE "courierId" = :id AND "status" = 'OFFERED'`,
          { id: c1.user.id },
        ),
      ).toHaveLength(1);
      const loser = rows.find((r) => r.status === 'REQUESTED')!;
      expect(loser.attempt).toBe(1);
      expect(await t.offerRows(loser.id)).toEqual([]);
    });

    it('S20 AS-22: a BUSY courier is never offered a delivery, even when a stale entry keeps it in the index', async () => {
      const city = t.uniqueCity();
      const c1 = await t.onShiftCourier({ city });
      const busyWith = await t.makeBusy(c1);
      await t.geo.applyLocation({
        city,
        courierId: c1.user.id,
        ...BERLIN.pickup,
        ts: t.clock.nowMs() + 1, // newer than the ping, or the live index ignores it
        searchable: true,
      });
      expect(await t.searchable(city)).toEqual([c1.user.id]);
      const d2 = await t.requested(city);

      await dispatch.dispatch(d2);

      expect(await t.offerRows(d2)).toEqual([]);
      expect(await t.deliveryRow(d2)).toMatchObject({
        status: 'REQUESTED',
        attempt: 1,
      });
      expect((await t.deliveryRow(busyWith)).courierId).toBe(c1.user.id);
    });

    it('S20 AS-22: a forced second accept for a courier who holds an assignment answers 409 courier_busy and leaves exactly one ASSIGNED delivery', async () => {
      const city = t.uniqueCity();
      const c1 = await t.onShiftCourier({ city });
      const first = await t.giveOffer(c1);
      await accept(c1, first).expect(200);
      // Offers made through a faulted guard: the first offer is ACCEPTED, so the unique index lets a second one in.
      const second = await t.giveOffer(c1);

      const [a, b] = await Promise.all([
        accept(c1, second),
        accept(c1, second),
      ]);

      expect([a.status, b.status]).toEqual([409, 409]);
      expect(a.body.code).toBe('courier_busy');
      expect(b.body.code).toBe('courier_busy');
      expect(
        await t.sql(
          `SELECT "id" FROM "Delivery" WHERE "courierId" = :id AND "status" = 'ASSIGNED'`,
          { id: c1.user.id },
        ),
      ).toEqual([{ id: first }]);
      expect(await t.deliveryRow(second)).toMatchObject({
        status: 'OFFERED',
        courierId: null,
      });
      expect(await offerStatuses(second)).toEqual([[c1.user.id, 'OFFERED']]);
    });
  });

  describe('US2 - accept (AS-23, AS-24)', () => {
    it('S20 AS-23: accept answers the courier view; delivery, offer, courier, history, outbox and the buyer push all agree; the pending timer changes nothing', async () => {
      const city = t.uniqueCity();
      const { c1 } = await threeCouriers(city);
      const d1 = await t.requested(city);
      await dispatch.dispatch(d1);
      t.clock.advance(5_000);

      const res = await accept(c1, d1).expect(200);

      expect(deliveryCourierViewSchema.parse(res.body)).toMatchObject({
        id: d1,
        status: 'ASSIGNED',
        pickup: BERLIN.pickup,
        dropoff: BERLIN.dropoff,
        feeMinor: 499,
        currency: 'EUR',
      });
      expect(res.body).not.toHaveProperty('buyerId');
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'ASSIGNED',
        courierId: c1.user.id,
        nextActionAt: null,
        version: 3,
      });
      expect((await t.offerRows(d1))[0]).toMatchObject({
        status: 'ACCEPTED',
        respondedAt: t.clock.now(),
      });
      expect((await t.courierRow(c1.user.id))?.status).toBe('BUSY');
      expect(await t.searchable(city)).not.toContain(c1.user.id);
      expect((await t.historyRows(d1)).at(-1)).toMatchObject({
        from: 'OFFERED',
        to: 'ASSIGNED',
        actorKind: 'courier',
        actorId: c1.user.id,
        version: 3,
      });
      const outbox = await t.outboxRows(d1);
      expect(
        outbox.map(
          (o) => (o.payload as { payload: { status: string } }).payload.status,
        ),
      ).toEqual(['ASSIGNED']);
      expect(t.pushes(`delivery:${d1}`).at(-1)).toMatchObject({
        type: 'status',
        data: { status: 'ASSIGNED', deliveryVersion: 3 },
      });
      expect(JSON.stringify(t.pushes(`delivery:${d1}`))).not.toContain(
        c1.user.id,
      );

      t.clock.advance(OFFER_TTL_MS);
      const before = [await t.deliveryRow(d1), await t.offerRows(d1)];
      await dispatch.onTimer(timer(d1, city, c1.user.id, 1));
      expect([await t.deliveryRow(d1), await t.offerRows(d1)]).toEqual(before);
    });

    it('S20 AS-24: a never-offered courier gets 404, an earlier offer gets offer_not_active, an expired live offer gets offer_expired and the timer then moves on', async () => {
      const city = t.uniqueCity();
      const c1 = await t.onShiftCourier({ city, lat: north(0.3) });
      const c2 = await t.onShiftCourier({ city, lat: north(1) });
      const c3 = await t.newCourier({ city });
      const d1 = await t.requested(city);
      await dispatch.dispatch(d1);
      await t.seedOffer({
        deliveryId: d1,
        courierId: c3.user.id,
        status: 'DECLINED',
        attempt: 0,
      });
      const never = await t.newCourier({ city });

      const unknown = await accept(never, d1).expect(404);
      expect(unknown.body.code).toBe('delivery_not_found');
      const earlier = await accept(c3, d1).expect(409);
      expect(earlier.body.code).toBe('offer_not_active');

      const before = [await t.deliveryRow(d1), await t.offerRows(d1)];
      t.clock.advance(OFFER_TTL_MS);
      const expired = await accept(c1, d1).expect(409);
      expect(expired.body.code).toBe('offer_expired');
      expect([await t.deliveryRow(d1), await t.offerRows(d1)]).toEqual(before);

      await dispatch.onTimer(timer(d1, city, c1.user.id, 1));
      expect(await offerStatuses(d1)).toEqual([
        [c3.user.id, 'DECLINED'],
        [c1.user.id, 'EXPIRED'],
        [c2.user.id, 'OFFERED'],
      ]);
    });

    it('S20 AS-24: a cancelled delivery answers 409 invalid_delivery_transition with its status and the command; 401 without credentials; 400 for a malformed id', async () => {
      const city = t.uniqueCity();
      const c1 = await t.newCourier({ city, status: 'AVAILABLE' });
      const cancelled = await t.seedDelivery({ city, status: 'CANCELLED' });
      await t.seedOffer({
        deliveryId: cancelled,
        courierId: c1.user.id,
        status: 'EXPIRED',
      });

      const res = await accept(c1, cancelled).expect(409);
      expect(res.body).toMatchObject({
        code: 'invalid_delivery_transition',
        currentStatus: 'CANCELLED',
        command: 'accept',
      });
      await t.http().post(`/api/deliveries/${cancelled}/accept`).expect(401);
      await t.as(c1.user).post('/api/deliveries/not-a-uuid/accept').expect(400);
    });
  });

  describe('US2 - races between accept, timeout and cancel (AS-25)', () => {
    it('S20 AS-25: accept and the timeout handler at the same moment: exactly one wins and never an ASSIGNED delivery with a second live offer', async () => {
      const city = t.uniqueCity();
      const { c1 } = await threeCouriers(city);
      const d1 = await t.requested(city);
      await dispatch.dispatch(d1);
      const expiry = new Date(t.clock.now().getTime() + OFFER_TTL_MS);
      t.clock.advance(14_000);

      // the accept judges the offer by the app clock (still live), the timer by the instant it was due
      const [res] = await Promise.all([
        accept(c1, d1),
        dispatch.onTimer(timer(d1, city, c1.user.id, 1), expiry),
      ]);

      const offers = await t.offerRows(d1);
      const accepted = res.status === 200 ? 1 : 0;
      const expired = offers.filter(
        (o) => o.courierId === c1.user.id && o.status === 'EXPIRED',
      ).length;
      expect(accepted + expired).toBe(1);
      const row = await t.deliveryRow(d1);
      const live = offers.filter((o) => o.status === 'OFFERED').length;
      expect(live + (row.status === 'ASSIGNED' ? 1 : 0)).toBe(1);
    });

    it('S20 AS-25: accept and a shop cancel at the same moment leave a CANCELLED delivery, a free courier and no live offer; the history shows each outcome once', async () => {
      const city = t.uniqueCity();
      const c1 = await t.onShiftCourier({ city });
      const { shopId, owner, buyer } = await t.shopMembers();
      const d1 = await t.requested(city, { shopId, buyerId: buyer.id });
      await dispatch.dispatch(d1);

      const [acceptRes, cancelRes] = await Promise.all([
        accept(c1, d1),
        t
          .as(owner)
          .post(`/api/shops/${shopId}/deliveries/${d1}/cancel`)
          .send({ reason: 'buyer_changed_mind' }),
      ]);

      expect(cancelRes.status).toBe(200);
      expect(await t.deliveryRow(d1)).toMatchObject({ status: 'CANCELLED' });
      expect((await t.courierRow(c1.user.id))?.status).toBe('AVAILABLE');
      expect(
        (await t.offerRows(d1)).filter((o) => o.status === 'OFFERED'),
      ).toHaveLength(0);
      const history = await t.historyRows(d1);
      const assigned = history.filter((h) => h.to === 'ASSIGNED').length;
      const refused = acceptRes.status === 409 ? 1 : 0;
      expect(assigned + refused).toBe(1);
      expect(history.filter((h) => h.to === 'CANCELLED')).toHaveLength(1);
    });
  });

  describe('US2 - courier goes off shift (AS-26)', () => {
    it('S20 AS-26: going off shift during an offer expires it, withdraws it and offers the next courier at once', async () => {
      const city = t.uniqueCity();
      const { c1, c2 } = await threeCouriers(city);
      const d1 = await t.requested(city);
      await dispatch.dispatch(d1);

      await t
        .as(c1.user)
        .put('/api/couriers/me/availability')
        .send({ available: false })
        .expect(200);

      expect(await offerStatuses(d1)).toEqual([
        [c1.user.id, 'EXPIRED'],
        [c2.user.id, 'OFFERED'],
      ]);
      expect((await t.courierRow(c1.user.id))?.status).toBe('OFFLINE');
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'OFFERED',
        attempt: 2,
      });
      expect(
        (await t.historyRows(d1)).filter((h) => h.to === 'REQUESTED').at(-1),
      ).toMatchObject({ from: 'OFFERED', detail: 'courier_offline' });
      expect(t.pushes(`user:${c1.user.id}`).map((p) => p.type)).toEqual([
        'delivery_offer',
        'delivery_offer_withdrawn',
      ]);
    });
  });

  describe('US2 - durable timers (AS-27)', () => {
    it('S20 AS-27: with the timeout message lost, the recovery job expires the overdue offer exactly like the timer', async () => {
      const city = t.uniqueCity();
      const { c1, c2 } = await threeCouriers(city);
      const d1 = await t.requested(city);
      await dispatch.dispatch(d1);
      // the queued message is never delivered (queue emptied): only the stored due time is left
      t.clock.advance(OFFER_TTL_MS);

      const result = await recovery.recoverOverdue(t.clock.now(), null);

      expect(result).toMatchObject({ offerExpiries: 1, dispatchRetries: 0 });
      expect(await offerStatuses(d1)).toEqual([
        [c1.user.id, 'EXPIRED'],
        [c2.user.id, 'OFFERED'],
      ]);
      expect(
        (await t.historyRows(d1)).filter((h) => h.to === 'REQUESTED').at(-1),
      ).toMatchObject({ from: 'OFFERED', detail: 'timeout' });
    });

    it('S20 AS-27: a retry whose enqueue failed is dispatched by the recovery job once it is due', async () => {
      const city = t.uniqueCity();
      const d1 = await t.requested(city);
      t.failEnqueues(1);
      await dispatch.dispatch(d1);
      expect(t.queued()).toEqual([]);
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'REQUESTED',
        attempt: 1,
      });
      t.clock.advance(20_000);
      const late = await t.onShiftCourier({ city });

      const early = await recovery.recoverOverdue(
        new Date(t.clock.now().getTime() - 1_000),
        null,
      );
      expect(early).toMatchObject({ offerExpiries: 0, dispatchRetries: 0 });
      const result = await recovery.recoverOverdue(t.clock.now(), null);

      expect(result).toMatchObject({ offerExpiries: 0, dispatchRetries: 1 });
      expect(await offerStatuses(d1)).toEqual([[late.user.id, 'OFFERED']]);
    });

    it('S20 AS-27: the recovery job twice at once, with a late timer message, produces exactly one effect', async () => {
      const city = t.uniqueCity();
      const { c1, c2 } = await threeCouriers(city);
      const d1 = await t.requested(city);
      await dispatch.dispatch(d1);
      t.clock.advance(OFFER_TTL_MS);
      const now = t.clock.now();

      await Promise.all([
        recovery.recoverOverdue(now, null),
        recovery.recoverOverdue(now, null),
        dispatch.onTimer(timer(d1, city, c1.user.id, 1)),
      ]);

      expect(await offerStatuses(d1)).toEqual([
        [c1.user.id, 'EXPIRED'],
        [c2.user.id, 'OFFERED'],
      ]);
      expect(await t.deliveryRow(d1)).toMatchObject({
        status: 'OFFERED',
        attempt: 2,
      });
      expect(
        (await t.historyRows(d1)).filter((h) => h.detail === 'timeout'),
      ).toHaveLength(1);
      expect(t.pushes(`user:${c1.user.id}`).map((p) => p.type)).toEqual([
        'delivery_offer',
        'delivery_offer_withdrawn',
      ]);
    });

    it('S20 AS-27: the recovery job ignores cities this instance does not own', async () => {
      const mine = t.uniqueCity();
      const theirs = t.uniqueCity();
      const a = await t.requested(mine);
      const b = await t.requested(theirs);
      t.clock.advance(1_000);

      const result = await recovery.recoverOverdue(t.clock.now(), [mine]);

      expect(result.dispatchRetries).toBe(1);
      expect((await t.deliveryRow(a)).attempt).toBe(1);
      expect((await t.deliveryRow(b)).attempt).toBe(0);
    });
  });
});
