import { v4 as uuidv4 } from 'uuid';
import { DispatchService } from './application/dispatch.service';
import { SurgeService } from './application/surge.service';
import { geohash } from './domain/geohash';
import {
  BERLIN,
  createDeliveryApp,
  type DeliveryTestApp,
  type DeliveryTestCourier,
} from './testing/delivery-fixtures';
import { FakeOrderFulfilment, fakeOrdersModule } from './testing/fake-orders';
import {
  DELIVERABLE_ORDER_STORE,
  type DeliverableOrderStore,
} from './domain/delivery-ports';

const KM = 1 / 111.2;
const north = (km: number) => BERLIN.pickup.lat + km * KM;
const CELL = geohash(BERLIN.pickup.lat, BERLIN.pickup.lng, 5);

/** Smoke-level SD-23 flow against the real stack; the detailed scenarios live in the delivery-*.e2e-spec files. */
describe('Courier dispatch (e2e)', () => {
  let t: DeliveryTestApp;
  let dispatch: DispatchService;

  beforeAll(async () => {
    t = await createDeliveryApp({
      extraImports: [fakeOrdersModule(new FakeOrderFulfilment())],
    });
    dispatch = t.app.get(DispatchService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const fleet = async (city: string, kms = [0.3, 1, 2.5]) => {
    const out: DeliveryTestCourier[] = [];
    for (const km of kms)
      out.push(await t.onShiftCourier({ city, lat: north(km) }));
    return out;
  };

  it('S20 AS-14: offers the nearest courier first; decline → next nearest; accept → ASSIGNED and the courier leaves the pool', async () => {
    const city = t.uniqueCity();
    const [c1, c2, c3] = await fleet(city);
    const d = await t.requested(city);
    await dispatch.dispatch(d);
    expect(await t.deliveryRow(d)).toMatchObject({
      status: 'OFFERED',
      attempt: 1,
    });
    expect((await t.offerRows(d))[0].courierId).toBe(c1.user.id);

    await t.as(c1.user).post(`/api/deliveries/${d}/decline`).expect(204);
    expect(await t.deliveryRow(d)).toMatchObject({
      status: 'OFFERED',
      attempt: 2,
    });

    await t.as(c3.user).post(`/api/deliveries/${d}/accept`).expect(404);
    await t.as(c2.user).post(`/api/deliveries/${d}/accept`).expect(200);
    expect(await t.deliveryRow(d)).toMatchObject({ status: 'ASSIGNED' });
    expect((await t.searchable(city)).sort()).toEqual(
      [c1.user.id, c3.user.id].sort(),
    );

    await t.as(c2.user).post(`/api/deliveries/${d}/picked-up`).expect(204);
    await t.as(c2.user).post(`/api/deliveries/${d}/delivered`).expect(204);
    expect((await t.searchable(city)).sort()).toEqual(
      [c1.user.id, c2.user.id, c3.user.id].sort(),
    );
  });

  it('S20 AS-25: two concurrent deliveries can never be offered the same courier', async () => {
    const city = t.uniqueCity();
    const [only] = await fleet(city, [0.3]);
    const a = await t.requested(city);
    const b = await t.requested(city);
    await Promise.all([dispatch.dispatch(a), dispatch.dispatch(b)]);
    const rows = [await t.deliveryRow(a), await t.deliveryRow(b)];
    expect(rows.filter((r) => r.status === 'OFFERED')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'REQUESTED')).toHaveLength(1);
    const live = [...(await t.offerRows(a)), ...(await t.offerRows(b))].filter(
      (o) => o.status === 'OFFERED',
    );
    expect(live).toHaveLength(1);
    expect(live[0].courierId).toBe(only.user.id);
  });

  it('S20 AS-16: offer timeout moves on to the next courier; stale timers are ignored', async () => {
    const city = t.uniqueCity();
    const [c1, c2] = await fleet(city, [0.3, 1]);
    const d = await t.requested(city);
    await dispatch.dispatch(d);
    await dispatch.onTimer({
      deliveryId: d,
      city,
      courierId: c1.user.id,
      attempt: 0,
    });
    expect(await t.deliveryRow(d)).toMatchObject({ attempt: 1 });

    t.clock.advance(15_000);
    await dispatch.onTimer({
      deliveryId: d,
      city,
      courierId: c1.user.id,
      attempt: 1,
    });
    expect(await t.deliveryRow(d)).toMatchObject({
      status: 'OFFERED',
      attempt: 2,
    });
    expect((await t.offerRows(d)).map((o) => o.courierId)).toEqual([
      c1.user.id,
      c2.user.id,
    ]);
  });

  it('S20 AS-04: location updates apply in timestamp order only; non-available couriers are not searchable', async () => {
    const city = t.uniqueCity();
    const [c1] = await fleet(city, [0.3]);
    const newer = north(2.5);
    await t
      .ping(c1.user, [t.point(1_000, newer, BERLIN.pickup.lng)])
      .expect(202);
    await t
      .ping(c1.user, [t.point(500, north(1), BERLIN.pickup.lng)])
      .expect(202); // arrived late
    const live = await t.livePosition(city, c1.user.id);
    expect(live?.lat).toBeCloseTo(newer, 3);

    await t
      .as(c1.user)
      .put('/api/couriers/me/availability')
      .send({ available: false });
    expect(await t.searchable(city)).toEqual([]);
  });

  it('S20 AS-49: surge rises in a cell where requests outnumber available couriers', async () => {
    const city = t.uniqueCity();
    await fleet(city, [0.3]);
    const members = await t.shopMembers();
    const orders = t.app.get<DeliverableOrderStore>(DELIVERABLE_ORDER_STORE);
    for (let i = 0; i < 3; i++) {
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
      await t
        .as(members.owner)
        .post(`/api/shops/${members.shopId}/deliveries`)
        .set('Idempotency-Key', uuidv4())
        .send({
          orderId,
          city,
          pickup: BERLIN.pickup,
          dropoff: BERLIN.dropoff,
        })
        .expect(201);
    }
    const computed = await t.app.get(SurgeService).compute(t.clock.now(), null);
    expect(computed.get(city)).toEqual(new Map([[CELL, 300]]));
  });
});
