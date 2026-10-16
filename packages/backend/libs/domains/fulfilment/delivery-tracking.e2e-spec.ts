import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { streamKey } from '@app/infrastructure/realtime/keys';
import { DispatchService } from './application/dispatch.service';
import { DeliveryTopicsModule } from './realtime-topics.module';
import {
  BERLIN,
  createDeliveryApp,
  type DeliveryTestApp,
  type DeliveryTestCourier,
} from './testing/delivery-fixtures';

const pushFailures = (topic: 'delivery' | 'user') =>
  MetricsRegistry.value('delivery_push_failures_total', { topic }) ?? 0;

describe('Delivery live tracking: subscription policy, throttle and replay', () => {
  let t: DeliveryTestApp;
  let topics: TopicRegistry;
  let dispatch: DispatchService;

  beforeAll(async () => {
    t = await createDeliveryApp({ extraImports: [DeliveryTopicsModule] });
    topics = t.app.get(TopicRegistry);
    dispatch = t.app.get(DispatchService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const accept = (c: DeliveryTestCourier, id: string) =>
    t.as(c.user).post(`/api/deliveries/${id}/accept`);
  const pickedUp = (c: DeliveryTestCourier, id: string) =>
    t.as(c.user).post(`/api/deliveries/${id}/picked-up`);
  const delivered = (c: DeliveryTestCourier, id: string) =>
    t.as(c.user).post(`/api/deliveries/${id}/delivered`);
  const replayed = async (deliveryId: string) =>
    (
      await t.redis.client.xrange(streamKey(`delivery:${deliveryId}`), '-', '+')
    ).map(([, fields]) => ({
      type: fields[1],
      data: JSON.parse(fields[3]) as Record<string, unknown>,
    }));

  /** A delivery offered to a fresh courier on shift and accepted through the API. */
  const assigned = async () => {
    const shop = await t.shopMembers();
    const city = t.uniqueCity();
    const courier = await t.onShiftCourier({ city });
    const id = await t.requested(city, {
      shopId: shop.shopId,
      buyerId: shop.buyer.id,
    });
    await dispatch.dispatch(id);
    await accept(courier, id).expect(200);
    // the next ping must be newer than the one that put the courier on the map
    t.clock.advance(1_000);
    return { id, courier, city, shop };
  };
  const positionPushes = (id: string) =>
    t.pushes(`delivery:${id}`).filter((p) => p.type === 'courier_position');

  describe('US5 - subscription policy (AS-46)', () => {
    it('S20 AS-46: the buyer and the assigned courier may subscribe to delivery:<id>', async () => {
      const { id, courier, shop } = await assigned();

      expect(
        await topics.canSubscribe({ userId: shop.buyer.id }, `delivery:${id}`),
      ).toBe(true);
      expect(
        await topics.canSubscribe(
          { userId: courier.user.id },
          `delivery:${id}`,
        ),
      ).toBe(true);
    });

    it('S20 AS-46: another buyer, a courier that held an offer, a shop member, an anonymous viewer and an unknown delivery are denied', async () => {
      const { id, city, shop } = await assigned();
      const declined = await t.onShiftCourier({ city });
      await t.seedOffer({
        deliveryId: id,
        courierId: declined.user.id,
        status: 'DECLINED',
        attempt: 2,
      });
      const b2 = await t.newUser();

      for (const viewer of [
        { userId: b2.id },
        { userId: declined.user.id },
        { userId: shop.owner.id },
        { userId: shop.viewer.id },
        {},
      ])
        expect(await topics.canSubscribe(viewer, `delivery:${id}`)).toBe(false);
      expect(
        await topics.canSubscribe(
          { userId: shop.buyer.id },
          `delivery:${uuidv4()}`,
        ),
      ).toBe(false);
      expect(
        await topics.canSubscribe(
          { userId: shop.buyer.id },
          'delivery:not-a-uuid',
        ),
      ).toBe(false);
    });

    it("S20 AS-46: the rule is one query on this domain's store with the principal in the predicate", async () => {
      const { id, shop } = await assigned();
      const queries: string[] = [];
      const db = t.app.get(Sequelize);
      const original = db.query.bind(db);
      const spy = jest.spyOn(db, 'query').mockImplementation(((
        q: unknown,
        o: unknown,
      ) => {
        queries.push(typeof q === 'string' ? q : '');
        return (original as (...a: unknown[]) => unknown)(q, o);
      }) as never);
      try {
        await topics.canSubscribe({ userId: shop.buyer.id }, `delivery:${id}`);
      } finally {
        spy.mockRestore();
      }
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('"Delivery"');
      expect(queries[0]).toContain(':userId');
    });
  });

  describe('US5 - position pushes (AS-47)', () => {
    it('S20 AS-47: one ping per second for 5 s publishes 2 courier_position messages, live only, never in the replay stream', async () => {
      const { id, courier } = await assigned();
      const first = t.clock.nowMs();

      for (let i = 0; i < 5; i++) {
        await t
          .ping(courier.user, [
            t.point(0, BERLIN.pickup.lat + i / 1000, BERLIN.pickup.lng),
          ])
          .expect(202);
        t.clock.advance(1_000);
      }

      const pushes = positionPushes(id);
      expect(pushes).toHaveLength(2);
      expect(pushes[0]).toMatchObject({
        topic: `delivery:${id}`,
        data: { lat: BERLIN.pickup.lat, lng: BERLIN.pickup.lng, ts: first },
        options: { replay: false },
      });
      expect(pushes[1]).toMatchObject({
        data: { lat: BERLIN.pickup.lat + 3 / 1000, ts: first + 3_000 },
        options: { replay: false },
      });
      expect((await replayed(id)).map((m) => m.type)).not.toContain(
        'courier_position',
      );
    });

    it('S20 AS-47: the throttle is per delivery and measured on the injected clock', async () => {
      const a = await assigned();
      const b = await assigned();

      await t.ping(a.courier.user, [t.point()]).expect(202);
      await t.ping(b.courier.user, [t.point()]).expect(202);
      t.clock.advance(2_001);
      await t.ping(a.courier.user, [t.point()]).expect(202);

      expect(positionPushes(a.id)).toHaveLength(2);
      expect(positionPushes(b.id)).toHaveLength(1);
    });

    it('S20 AS-47: pings are pushed while PICKED_UP and stop after DELIVERED', async () => {
      const { id, courier } = await assigned();
      await pickedUp(courier, id).expect(204);
      await t.ping(courier.user, [t.point()]).expect(202);
      expect(positionPushes(id)).toHaveLength(1);

      await delivered(courier, id).expect(204);
      t.clock.advance(5_000);
      await t.ping(courier.user, [t.point()]).expect(202);

      expect(positionPushes(id)).toHaveLength(1);
    });

    it('S20 AS-47: a courier without an active delivery, and a stale live mirror of a finished delivery, publish nothing', async () => {
      const city = t.uniqueCity();
      const idle = await t.onShiftCourier({ city });
      await t.ping(idle.user, [t.point(1)]).expect(202);
      expect(t.pushes().filter((p) => p.type === 'courier_position')).toEqual(
        [],
      );

      for (const status of [
        'REQUESTED',
        'OFFERED',
        'DELIVERED',
        'CANCELLED',
      ] as const) {
        const courier = await t.onShiftCourier({ city });
        const stale = await t.seedDelivery({
          city,
          status,
          courierId: status === 'DELIVERED' ? courier.user.id : null,
        });
        // the mirror still names the delivery (it is derived state and can lag)
        await t.geo.setStatus(city, courier.user.id, 'BUSY', stale);
        await t.ping(courier.user, [t.point(1)]).expect(202);
        expect(positionPushes(stale)).toEqual([]);
      }
    });

    it('S20 AS-47: a push that fails does not fail the ping', async () => {
      const { id, courier } = await assigned();
      t.realtimeDown('throws');
      const before = pushFailures('delivery');

      await t.ping(courier.user, [t.point()]).expect(202);

      expect(positionPushes(id)).toHaveLength(1);
      expect(pushFailures('delivery')).toBe(before + 1);
    });
  });

  describe('US5 - status pushes and the replay stream (AS-48)', () => {
    it('S20 AS-48: every transition publishes status {status, deliveryVersion, at} into the replay stream without courier identity', async () => {
      const { id, courier, shop } = await assigned();
      await pickedUp(courier, id).expect(204);
      await delivered(courier, id).expect(204);

      const stream = await replayed(id);
      expect(
        stream.map((m) => [m.type, m.data.status, m.data.deliveryVersion]),
      ).toEqual([
        ['status', 'OFFERED', 2],
        ['status', 'ASSIGNED', 3],
        ['status', 'PICKED_UP', 4],
        ['status', 'DELIVERED', 5],
      ]);
      for (const message of stream) {
        expect(Object.keys(message.data).sort()).toEqual([
          'at',
          'deliveryVersion',
          'status',
        ]);
        expect(JSON.stringify(message)).not.toContain(courier.user.id);
        expect(JSON.stringify(message)).not.toContain(shop.buyer.id);
      }
      expect(
        t.pushes(`delivery:${id}`).filter((p) => p.type === 'status'),
      ).toHaveLength(4);
    });

    it('S20 AS-48: with the realtime store down the transition commits, the failure is counted and logged', async () => {
      const shop = await t.shopMembers();
      const city = t.uniqueCity();
      const courier = await t.onShiftCourier({ city });
      const id = await t.requested(city, {
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      await dispatch.dispatch(id);
      const warn = jest.spyOn(Logger.prototype, 'warn');
      t.realtimeDown('unpublished');
      const before = pushFailures('delivery');

      await accept(courier, id).expect(200);

      expect((await t.deliveryRow(id)).status).toBe('ASSIGNED');
      expect(pushFailures('delivery')).toBe(before + 1);
      expect(warn.mock.calls.map((call) => call[0])).toContainEqual(
        expect.objectContaining({
          event: 'delivery.push_failed',
          step: 'status',
          deliveryId: id,
          city,
        }),
      );
      warn.mockRestore();
    });

    it('S20 AS-48: a publisher that rejects is counted and logged too, and the transition commits', async () => {
      const shop = await t.shopMembers();
      const city = t.uniqueCity();
      const courier = await t.onShiftCourier({ city });
      const id = await t.requested(city, {
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      await dispatch.dispatch(id);
      t.realtimeDown('throws');
      const before = pushFailures('delivery');

      await accept(courier, id).expect(200);

      expect((await t.deliveryRow(id)).status).toBe('ASSIGNED');
      expect(pushFailures('delivery')).toBe(before + 1);
    });
  });
});
