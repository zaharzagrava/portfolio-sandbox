import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  deliveryCourierViewSchema,
  deliveryShopViewSchema,
} from '@marketplace-sandbox/contracts';
import { OrderCancelled } from '@app/domains/orders';
import { ShopDeleted } from '@app/domains/tenancy';
import { waitFor } from '@app/test/utils/async-helpers';
import { readTopic } from '@app/test/utils/kafka-test';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import { NonRetryableJobError } from '@app/infrastructure/jobs/job-types';
import { DispatchService } from './application/dispatch.service';
import { RecoveryService } from './application/recovery.service';
import { DeliveryProjectorModule } from './delivery-projector.module';
import {
  DELIVERABLE_ORDER_STORE,
  DELIVERY_REPOSITORY,
  type DeliverableOrderStore,
  type DeliveryRepository,
} from './domain/delivery-ports';
import { offerLockKey } from './infra/courier-keys';
import { DeliveryJobHandlers } from './infra/delivery-job-handlers';
import {
  DeliveryOrderCancelledProjector,
  DeliveryShopDeletedProjector,
} from './infra/delivery-order.consumers';
import { FakeOrderFulfilment, fakeOrdersModule } from './testing/fake-orders';
import {
  BERLIN,
  createDeliveryApp,
  type DeliveryTestApp,
  type DeliveryTestCourier,
} from './testing/delivery-fixtures';

const fakeOrders = new FakeOrderFulfilment();
const LIFECYCLE_JOB = 'fulfilment.apply-order-lifecycle';

describe('Delivery lifecycle: state machine, replay, cancellation and order write-back', () => {
  let t: DeliveryTestApp;
  let dispatch: DispatchService;
  let recovery: RecoveryService;
  let handlers: DeliveryJobHandlers;
  let orders: DeliverableOrderStore;
  const kit = new ConsumerKit();

  beforeAll(async () => {
    t = await createDeliveryApp({
      extraImports: [fakeOrdersModule(fakeOrders)],
    });
    dispatch = t.app.get(DispatchService);
    recovery = t.app.get(RecoveryService);
    handlers = t.app.get(DeliveryJobHandlers);
    orders = t.app.get<DeliverableOrderStore>(DELIVERABLE_ORDER_STORE);
    await kit.start();
  });
  afterAll(async () => {
    await kit.stopAll();
    await t.close();
  });
  beforeEach(async () => {
    fakeOrders.reset();
    await t.reset();
  });

  const accept = (c: DeliveryTestCourier, id: string) =>
    t.as(c.user).post(`/api/deliveries/${id}/accept`);
  const pickedUp = (c: { user: DeliveryTestCourier['user'] }, id: string) =>
    t.as(c.user).post(`/api/deliveries/${id}/picked-up`);
  const delivered = (c: { user: DeliveryTestCourier['user'] }, id: string) =>
    t.as(c.user).post(`/api/deliveries/${id}/delivered`);
  const cancel = (
    user: DeliveryTestCourier['user'],
    shopId: string,
    id: string,
    body: unknown = { reason: 'buyer_changed_mind' },
  ) =>
    t
      .as(user)
      .post(`/api/shops/${shopId}/deliveries/${id}/cancel`)
      .send(body as object);

  /** A delivery of `shopId` offered to a fresh courier on shift and accepted through the API. */
  const assigned = async (
    shop: { shopId: string; buyer: { id: string } },
    city = t.uniqueCity(),
  ) => {
    const courier = await t.onShiftCourier({ city });
    const id = await t.requested(city, {
      shopId: shop.shopId,
      buyerId: shop.buyer.id,
    });
    await dispatch.dispatch(id);
    await accept(courier, id).expect(200);
    return { id, courier, city };
  };

  const snapshot = async (id: string) => ({
    row: await t.deliveryRow(id),
    history: (await t.historyRows(id)).length,
    outbox: (await t.outboxRows(id)).length,
  });
  const milestones = async (id: string) =>
    (await t.outboxRows(id)).map(
      (o) => (o.payload as { payload: { status: string } }).payload.status,
    );
  const jobsFor = async (deliveryId: string) =>
    t.sql<{ status: string }>(
      `SELECT "payload"->>'status' AS "status" FROM "Job"
        WHERE "type" = :type AND "payload"->>'deliveryId' = :deliveryId ORDER BY "createdAt"`,
      { type: LIFECYCLE_JOB, deliveryId },
    );

  describe('US3 - the happy path (AS-29)', () => {
    it('S20 AS-29: accept, picked-up and delivered write one history row, one outbox milestone and one buyer push each; the courier is free again', async () => {
      const shop = await t.shopMembers();
      const { id, courier, city } = await assigned(shop);

      await pickedUp(courier, id).expect(204);
      expect((await t.deliveryRow(id)).status).toBe('PICKED_UP');
      await delivered(courier, id).expect(204);

      expect(await t.deliveryRow(id)).toMatchObject({
        status: 'DELIVERED',
        courierId: courier.user.id,
        version: 5,
        nextActionAt: null,
      });
      const history = await t.historyRows(id);
      expect(history.map((h) => [h.from, h.to, h.version])).toEqual([
        [null, 'REQUESTED', 1],
        ['REQUESTED', 'OFFERED', 2],
        ['OFFERED', 'ASSIGNED', 3],
        ['ASSIGNED', 'PICKED_UP', 4],
        ['PICKED_UP', 'DELIVERED', 5],
      ]);
      expect(history.slice(2).map((h) => [h.actorKind, h.actorId])).toEqual([
        ['courier', courier.user.id],
        ['courier', courier.user.id],
        ['courier', courier.user.id],
      ]);
      expect(await milestones(id)).toEqual([
        'ASSIGNED',
        'PICKED_UP',
        'DELIVERED',
      ]);
      expect(
        t
          .pushes(`delivery:${id}`)
          .slice(-3)
          .map((p) => p.data),
      ).toEqual([
        expect.objectContaining({ status: 'ASSIGNED', deliveryVersion: 3 }),
        expect.objectContaining({ status: 'PICKED_UP', deliveryVersion: 4 }),
        expect.objectContaining({ status: 'DELIVERED', deliveryVersion: 5 }),
      ]);
      expect((await t.courierRow(courier.user.id))?.status).toBe('AVAILABLE');
      t.clock.advance(1_000);
      await t.ping(courier.user, [t.point(0)]).expect(202);
      expect(await t.searchable(city)).toContain(courier.user.id);
    });

    it('S20 AS-29: the accept answer is the courier view and the write-back jobs for the three milestones are queued once each', async () => {
      const shop = await t.shopMembers();
      const city = t.uniqueCity();
      const courier = await t.onShiftCourier({ city });
      const id = await t.requested(city, {
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      await dispatch.dispatch(id);

      const res = await accept(courier, id).expect(200);
      await pickedUp(courier, id).expect(204);
      await delivered(courier, id).expect(204);

      expect(deliveryCourierViewSchema.parse(res.body).status).toBe('ASSIGNED');
      expect((await jobsFor(id)).map((j) => j.status)).toEqual([
        'ASSIGNED',
        'PICKED_UP',
        'DELIVERED',
      ]);
    });
  });

  describe('US3 - illegal moves and actor guards (AS-30, AS-31)', () => {
    type Case = [
      command: 'picked-up' | 'delivered' | 'accept' | 'cancel',
      status: string,
      name: string,
    ];
    const cases: Case[] = [
      ['picked-up', 'REQUESTED', 'pickUp'],
      ['picked-up', 'OFFERED', 'pickUp'],
      ['picked-up', 'DELIVERED', 'pickUp'],
      ['picked-up', 'CANCELLED', 'pickUp'],
      ['delivered', 'REQUESTED', 'deliver'],
      ['delivered', 'OFFERED', 'deliver'],
      ['delivered', 'ASSIGNED', 'deliver'],
      ['delivered', 'CANCELLED', 'deliver'],
      ['accept', 'ASSIGNED', 'accept'],
      ['accept', 'PICKED_UP', 'accept'],
      ['cancel', 'PICKED_UP', 'cancel'],
      ['cancel', 'DELIVERED', 'cancel'],
      ['cancel', 'CANCELLED', 'cancel'],
    ];

    it.each(cases)(
      'S20 AS-30: %s on a %s delivery answers 409 invalid_delivery_transition (%s) and changes nothing',
      async (command, status, name) => {
        const shop = await t.shopMembers();
        const city = t.uniqueCity();
        const courier = await t.newCourier({ city, status: 'AVAILABLE' });
        const other = await t.newCourier({ city, status: 'AVAILABLE' });
        // The caller is related to the delivery: it is its courier, or it holds / held an offer for it (accept).
        const open = status === 'REQUESTED' || status === 'OFFERED';
        const id = await t.seedDelivery({
          city,
          status: status as 'ASSIGNED',
          shopId: shop.shopId,
          buyerId: shop.buyer.id,
          courierId: open
            ? null
            : command === 'accept'
              ? other.user.id
              : courier.user.id,
        });
        if (open || command === 'accept')
          await t.seedOffer({
            deliveryId: id,
            courierId: courier.user.id,
            status: status === 'OFFERED' ? 'OFFERED' : 'EXPIRED',
          });
        const before = await snapshot(id);

        const res =
          command === 'picked-up'
            ? await pickedUp(courier, id)
            : command === 'delivered'
              ? await delivered(courier, id)
              : command === 'accept'
                ? await accept(courier, id)
                : await cancel(shop.owner, shop.shopId, id);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'invalid_delivery_transition',
          currentStatus: status,
          command: name,
        });
        expect(await snapshot(id)).toEqual(before);
      },
    );

    it('S20 AS-31: another courier, the buyer and a stranger get 404 delivery_not_found on picked-up and delivered, and nothing changes; 401 without credentials', async () => {
      const shop = await t.shopMembers();
      const { id, courier, city } = await assigned(shop);
      const other = await t.onShiftCourier({ city });
      const stranger = await t.newUser();
      const before = await snapshot(id);

      for (const actor of [other, shop.buyer, stranger]) {
        const who = 'user' in actor ? actor : { user: actor };
        const a = await pickedUp(who, id).expect(404);
        const b = await delivered(who, id).expect(404);
        expect(a.body.code).toBe('delivery_not_found');
        expect(b.body.code).toBe('delivery_not_found');
      }
      await t.http().post(`/api/deliveries/${id}/picked-up`).expect(401);
      await t.http().post(`/api/deliveries/${id}/delivered`).expect(401);
      expect(await snapshot(id)).toEqual(before);
      await pickedUp(courier, id).expect(204);
    });

    it('S20 AS-31: a malformed id is 400', async () => {
      const courier = await t.newCourier();
      await pickedUp(courier, 'nope').expect(400);
      await delivered(courier, 'nope').expect(400);
    });
  });

  describe('US3 - cancel by the shop (AS-32)', () => {
    const expectCancelledEffects = async (
      id: string,
      owner: DeliveryTestCourier['user'],
      previous: string,
    ) => {
      expect(await t.deliveryRow(id)).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'buyer_changed_mind',
        nextActionAt: null,
      });
      expect((await t.historyRows(id)).at(-1)).toMatchObject({
        from: previous,
        to: 'CANCELLED',
        actorKind: 'shop',
        actorId: owner.id,
        detail: 'buyer_changed_mind',
      });
      expect((await t.outboxRows(id)).at(-1)?.payload).toMatchObject({
        payload: {
          status: 'CANCELLED',
          previousStatus: previous,
          reason: 'buyer_changed_mind',
        },
      });
      expect(t.pushes(`delivery:${id}`).at(-1)).toMatchObject({
        type: 'status',
        data: expect.objectContaining({ status: 'CANCELLED' }),
      });
      expect(JSON.stringify(t.pushes(`delivery:${id}`))).not.toContain(
        'buyer_changed_mind',
      );
    };

    it('S20 AS-32: cancelling a REQUESTED delivery answers the shop view and touches no courier', async () => {
      const shop = await t.shopMembers();
      const city = t.uniqueCity();
      const courier = await t.onShiftCourier({ city });
      const id = await t.requested(city, {
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
        attempt: 2,
      });

      const res = await cancel(shop.owner, shop.shopId, id).expect(200);

      expect(deliveryShopViewSchema.parse(res.body)).toMatchObject({
        id,
        status: 'CANCELLED',
      });
      await expectCancelledEffects(id, shop.owner, 'REQUESTED');
      expect(t.pushes(`user:${courier.user.id}`)).toEqual([]);
    });

    it('S20 AS-32: cancelling an OFFERED delivery expires the offer, frees the guard and withdraws the offer from the courier', async () => {
      const shop = await t.shopMembers();
      const city = t.uniqueCity();
      const courier = await t.onShiftCourier({ city });
      const id = await t.requested(city, {
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      await dispatch.dispatch(id);
      expect(
        await t.redis.client.exists(offerLockKey(city, courier.user.id)),
      ).toBe(1);

      await cancel(shop.owner, shop.shopId, id).expect(200);

      await expectCancelledEffects(id, shop.owner, 'OFFERED');
      expect((await t.offerRows(id))[0]).toMatchObject({
        courierId: courier.user.id,
        status: 'EXPIRED',
      });
      expect(
        await t.redis.client.exists(offerLockKey(city, courier.user.id)),
      ).toBe(0);
      expect(t.pushes(`user:${courier.user.id}`).map((p) => p.type)).toEqual([
        'delivery_offer',
        'delivery_offer_withdrawn',
      ]);
      expect((await t.courierRow(courier.user.id))?.status).toBe('AVAILABLE');
    });

    it('S20 AS-32: cancelling an ASSIGNED delivery frees the courier and tells them', async () => {
      const shop = await t.shopMembers();
      const { id, courier, city } = await assigned(shop);

      await cancel(shop.owner, shop.shopId, id).expect(200);

      await expectCancelledEffects(id, shop.owner, 'ASSIGNED');
      expect((await t.courierRow(courier.user.id))?.status).toBe('AVAILABLE');
      expect(await t.searchable(city)).toContain(courier.user.id);
      expect(t.pushes(`user:${courier.user.id}`).at(-1)).toMatchObject({
        type: 'delivery_cancelled',
        data: { deliveryId: id },
      });
      expect(await milestones(id)).toEqual(['ASSIGNED', 'CANCELLED']);
    });

    it('S20 AS-32: a second cancel is 409; a VIEWER is 403; another shop gets 404; a bad body is 400; no credentials is 401', async () => {
      const shop = await t.shopMembers();
      const other = await t.shopMembers();
      const city = t.uniqueCity();
      const id = await t.requested(city, {
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      const before = await snapshot(id);

      await cancel(shop.viewer, shop.shopId, id).expect(403);
      const foreign = await cancel(other.owner, other.shopId, id).expect(404);
      expect(foreign.body.code).toBe('delivery_not_found');
      await cancel(shop.owner, shop.shopId, id, {}).expect(400);
      await cancel(shop.owner, shop.shopId, id, { reason: '' }).expect(400);
      await cancel(shop.owner, shop.shopId, id, {
        reason: 'x'.repeat(201),
      }).expect(400);
      await cancel(shop.owner, shop.shopId, id, {
        reason: 'ok',
        status: 'CANCELLED',
      }).expect(400);
      await t
        .http()
        .post(`/api/shops/${shop.shopId}/deliveries/${id}/cancel`)
        .send({ reason: 'ok' })
        .expect(401);
      expect(await snapshot(id)).toEqual(before);

      await cancel(shop.owner, shop.shopId, id, {
        reason: 'x'.repeat(200),
      }).expect(200);
      const again = await cancel(shop.owner, shop.shopId, id).expect(409);
      expect(again.body).toMatchObject({
        code: 'invalid_delivery_transition',
        currentStatus: 'CANCELLED',
        command: 'cancel',
      });
    });
  });

  describe('US3 - replays and concurrent steps (AS-33, AS-34)', () => {
    it('S20 AS-33: accept three times at once answers the same 200 body and leaves one row, one event, one job and one courier change', async () => {
      const shop = await t.shopMembers();
      const city = t.uniqueCity();
      const courier = await t.onShiftCourier({ city });
      const id = await t.requested(city, {
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      await dispatch.dispatch(id);

      const results = await Promise.all([
        accept(courier, id),
        accept(courier, id),
        accept(courier, id),
      ]);
      const again = await accept(courier, id);

      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(again.status).toBe(200);
      for (const r of [...results, again])
        expect(r.body).toEqual(results[0].body);
      expect(
        (await t.historyRows(id)).filter((h) => h.to === 'ASSIGNED'),
      ).toHaveLength(1);
      expect(await milestones(id)).toEqual(['ASSIGNED']);
      expect(await jobsFor(id)).toHaveLength(1);
      expect((await t.deliveryRow(id)).version).toBe(3);
    });

    it('S20 AS-33: declined, picked-up and delivered repeat as 204 with no new row, event or job; beyond the target is 409', async () => {
      const shop = await t.shopMembers();
      const city = t.uniqueCity();
      const c1 = await t.onShiftCourier({ city, lat: BERLIN.pickup.lat });
      const c2 = await t.onShiftCourier({
        city,
        lat: BERLIN.pickup.lat + 0.01,
      });
      const id = await t.requested(city, {
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      await dispatch.dispatch(id);
      await t.as(c1.user).post(`/api/deliveries/${id}/decline`).expect(204);
      const afterDecline = await snapshot(id);
      await t.as(c1.user).post(`/api/deliveries/${id}/decline`).expect(204);
      expect(await snapshot(id)).toEqual(afterDecline);

      await accept(c2, id).expect(200);
      await pickedUp(c2, id).expect(204);
      const afterPickUp = await snapshot(id);
      await pickedUp(c2, id).expect(204);
      expect(await snapshot(id)).toEqual(afterPickUp);

      await delivered(c2, id).expect(204);
      const afterDelivery = await snapshot(id);
      const jobs = await jobsFor(id);
      await delivered(c2, id).expect(204);
      expect(await snapshot(id)).toEqual(afterDelivery);
      expect(await jobsFor(id)).toEqual(jobs);

      const beyond = await pickedUp(c2, id).expect(409);
      expect(beyond.body).toMatchObject({
        code: 'invalid_delivery_transition',
        currentStatus: 'DELIVERED',
        command: 'pickUp',
      });
      expect(await snapshot(id)).toEqual(afterDelivery);
    });

    it('S20 AS-34: picked-up twice at once answers 204 twice and writes one ASSIGNED to PICKED_UP row', async () => {
      const shop = await t.shopMembers();
      const { id, courier } = await assigned(shop);

      const [a, b] = await Promise.all([
        pickedUp(courier, id),
        pickedUp(courier, id),
      ]);

      expect([a.status, b.status]).toEqual([204, 204]);
      expect(
        (await t.historyRows(id)).filter((h) => h.to === 'PICKED_UP'),
      ).toHaveLength(1);
      expect(await milestones(id)).toEqual(['ASSIGNED', 'PICKED_UP']);
    });

    it('S20 AS-34: picked-up and a shop cancel at the same moment: exactly one wins and the loser answers 409', async () => {
      const shop = await t.shopMembers();
      const { id, courier } = await assigned(shop);

      const [pick, cancelled] = await Promise.all([
        pickedUp(courier, id),
        cancel(shop.owner, shop.shopId, id),
      ]);

      const wins = [pick.status === 204, cancelled.status === 200];
      expect(wins.filter(Boolean)).toHaveLength(1);
      expect(
        [pick.status, cancelled.status].filter((s) => s === 409),
      ).toHaveLength(1);
      // one move out of ASSIGNED, whichever it was
      expect(
        (await t.historyRows(id)).filter((h) => h.from === 'ASSIGNED'),
      ).toHaveLength(1);
    });
  });

  describe('US3 - order cancelled and shop deleted (AS-35)', () => {
    const orderCancelled = (orderId: string, orderVersion = 9) =>
      OrderCancelled.create(orderId, orderVersion, {
        orderId,
        userId: uuidv4(),
        orderVersion,
        reason: 'user_cancelled',
        previousStatus: 'PAID',
      });

    /** Four open deliveries of one order, one per shop: REQUESTED, OFFERED, ASSIGNED and PICKED_UP. */
    const openDeliveries = async () => {
      const orderId = uuidv4();
      const city = t.uniqueCity();
      const c1 = await t.onShiftCourier({ city });
      const c2 = await t.onShiftCourier({ city });
      const c3 = await t.onShiftCourier({ city });
      const shops = [
        await t.seller(),
        await t.seller(),
        await t.seller(),
        await t.seller(),
      ];
      const seed = (i: number) => ({
        orderId,
        shopId: shops[i].shopId,
        buyerId: shops[i].buyer.id,
      });
      const requested = await t.requested(city, seed(0));
      const offered = await t.giveOffer(c1, seed(1));
      const assignedId = await t.makeBusy(c2, {
        ...seed(2),
        status: 'ASSIGNED',
      });
      const inTransit = await t.makeBusy(c3, {
        ...seed(3),
        status: 'PICKED_UP',
      });
      return {
        orderId,
        city,
        c1,
        c2,
        c3,
        requested,
        offered,
        assignedId,
        inTransit,
        shops,
      };
    };

    it('S20 AS-35: order.cancelled cancels the open deliveries with the effects of a shop cancel and flags the one in transit; a duplicate has no further effect', async () => {
      const w = await openDeliveries();
      const projector = t.app.get(DeliveryOrderCancelledProjector);
      const envelope = orderCancelled(w.orderId);

      await projector.project([envelope]);

      for (const id of [w.requested, w.offered, w.assignedId])
        expect(await t.deliveryRow(id)).toMatchObject({
          status: 'CANCELLED',
          cancelReason: 'order_cancelled',
        });
      expect((await t.historyRows(w.offered)).at(-1)).toMatchObject({
        to: 'CANCELLED',
        actorKind: 'order',
        detail: 'order_cancelled',
      });
      expect((await t.offerRows(w.offered))[0].status).toBe('EXPIRED');
      expect(t.pushes(`user:${w.c1.user.id}`).at(-1)).toMatchObject({
        type: 'delivery_offer_withdrawn',
      });
      expect((await t.courierRow(w.c2.user.id))?.status).toBe('AVAILABLE');
      expect(t.pushes(`user:${w.c2.user.id}`).at(-1)).toMatchObject({
        type: 'delivery_cancelled',
        data: { deliveryId: w.assignedId },
      });
      expect(await milestones(w.assignedId)).toEqual(['CANCELLED']);

      expect(await t.deliveryRow(w.inTransit)).toMatchObject({
        status: 'PICKED_UP',
      });
      expect(
        (await t.historyRows(w.inTransit)).filter(
          (h) => h.detail === 'order_cancelled_in_transit',
        ),
      ).toHaveLength(1);

      const before = await Promise.all(
        [w.requested, w.offered, w.assignedId, w.inTransit].map(snapshot),
      );
      await projector.project([envelope]);
      expect(
        await Promise.all(
          [w.requested, w.offered, w.assignedId, w.inTransit].map(snapshot),
        ),
      ).toEqual(before);
    });

    it('S20 AS-35: tenancy.shop_deleted cancels every open delivery of the shop with reason shop_deleted; the rows stay readable to their buyers; a duplicate has no further effect', async () => {
      const city = t.uniqueCity();
      const shop = await t.seller();
      const c1 = await t.onShiftCourier({ city });
      const c2 = await t.onShiftCourier({ city });
      const c3 = await t.onShiftCourier({ city });
      const seed = () => ({ shopId: shop.shopId, buyerId: shop.buyer.id });
      const requested = await t.requested(city, seed());
      const offered = await t.giveOffer(c1, seed());
      const assignedId = await t.makeBusy(c2, seed());
      const inTransit = await t.makeBusy(c3, {
        ...seed(),
        status: 'PICKED_UP',
      });
      const done = await t.seedDelivery({
        city,
        status: 'DELIVERED',
        ...seed(),
      });
      const projector = t.app.get(DeliveryShopDeletedProjector);
      const envelope = ShopDeleted.create(shop.shopId, 3, {
        shopId: shop.shopId,
        shopVersion: 3,
      });

      await projector.project([envelope]);

      for (const id of [requested, offered, assignedId])
        expect(await t.deliveryRow(id)).toMatchObject({
          status: 'CANCELLED',
          cancelReason: 'shop_deleted',
        });
      expect((await t.offerRows(offered))[0].status).toBe('EXPIRED');
      expect((await t.courierRow(c2.user.id))?.status).toBe('AVAILABLE');
      expect((await t.deliveryRow(inTransit)).status).toBe('PICKED_UP');
      expect((await t.deliveryRow(done)).status).toBe('DELIVERED');
      const repo = t.app.get<DeliveryRepository>(DELIVERY_REPOSITORY);
      expect(await repo.findForBuyer(requested, shop.buyer.id)).toMatchObject({
        id: requested,
        status: 'CANCELLED',
      });

      const before = await Promise.all(
        [requested, offered, assignedId, inTransit, done].map(snapshot),
      );
      await projector.project([envelope]);
      expect(
        await Promise.all(
          [requested, offered, assignedId, inTransit, done].map(snapshot),
        ),
      ).toEqual(before);
    });

    it('S20 AS-35: an invalid order.cancelled and an invalid tenancy.shop_deleted payload are dead-lettered with a reason and cancel nothing', async () => {
      const city = t.uniqueCity();
      const shop = await t.seller();
      const orderId = uuidv4();
      const mine = await t.requested(city, {
        orderId,
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      const boot = async (
        Base: new (
          ...args: never[]
        ) => DeliveryOrderCancelledProjector | DeliveryShopDeletedProjector,
        prefix: string,
      ) => {
        const s = await kit.scenario();
        const name = `${prefix}-${s.id}`;
        @Injectable()
        class Sub extends (Base as new (
          ...args: never[]
        ) => DeliveryOrderCancelledProjector) {
          readonly name: string = name;
          readonly topics: string[] = [s.topic];
        }
        await s.boot([Sub as never], { imports: [DeliveryProjectorModule] });
        return {
          publish: (envelopes: unknown[]) =>
            s.publishRaw(
              envelopes.map((e) => ({
                key: (e as { aggregateId: string }).aggregateId,
                value: JSON.stringify(e),
              })),
            ),
          dlq: () => readTopic(`${name}.dlq`),
        };
      };

      const orders = await boot(
        DeliveryOrderCancelledProjector,
        'delivery-order-cancelled',
      );
      const badOrder = {
        ...orderCancelled(orderId),
        payload: {
          userId: uuidv4(),
          orderVersion: 9,
          reason: 'user_cancelled',
          previousStatus: 'PAID',
        },
      };
      await orders.publish([badOrder]);
      await waitFor(async () => (await orders.dlq()).length === 1, {
        description: 'order.cancelled dead letter',
      });
      expect((await orders.dlq())[0].headers['x-dlq-reason-code']).toBe(
        'INVALID_PAYLOAD',
      );

      const shops = await boot(
        DeliveryShopDeletedProjector,
        'delivery-shop-deleted',
      );
      const badShop = {
        ...ShopDeleted.create(shop.shopId, 3, {
          shopId: shop.shopId,
          shopVersion: 3,
        }),
        payload: { shopVersion: 3 },
      };
      await shops.publish([badShop]);
      await waitFor(async () => (await shops.dlq()).length === 1, {
        description: 'shop_deleted dead letter',
      });
      expect((await shops.dlq())[0].headers['x-dlq-reason']).toBeTruthy();
      expect((await t.deliveryRow(mine)).status).toBe('REQUESTED');
    }, 120_000);
  });

  describe('US3 - order write-back (AS-36)', () => {
    const singleShopOrder = async (
      shop: { shopId: string; buyer: { id: string } },
      shopIds = [shop.shopId],
    ) => {
      const orderId = uuidv4();
      await orders.applyPaid(
        {
          orderId,
          buyerId: shop.buyer.id,
          shopIds,
          currency: 'EUR',
          orderVersion: 4,
        },
        t.clock.now(),
      );
      fakeOrders.setOrder(orderId, 'PAID');
      return orderId;
    };
    const runJob = (
      deliveryId: string,
      status: 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED',
    ) =>
      handlers.applyOrderLifecycle({ deliveryId, status }, {
        isLastAttempt: false,
      } as never);

    it('S20 AS-36: startFulfilment, ship with the delivery id as tracking code and deliver reach the order in that order, after the commits', async () => {
      const shop = await t.shopMembers();
      const orderId = await singleShopOrder(shop);
      const city = t.uniqueCity();
      const courier = await t.onShiftCourier({ city });
      const id = await t.requested(city, {
        orderId,
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      await dispatch.dispatch(id);
      await accept(courier, id).expect(200);
      expect(fakeOrders.calls).toEqual([]); // nothing inside the transition: only a job was queued
      await pickedUp(courier, id).expect(204);
      await delivered(courier, id).expect(204);
      expect((await jobsFor(id)).map((j) => j.status)).toEqual([
        'ASSIGNED',
        'PICKED_UP',
        'DELIVERED',
      ]);

      await runJob(id, 'ASSIGNED');
      await runJob(id, 'PICKED_UP');
      await runJob(id, 'DELIVERED');

      expect(fakeOrders.applied.map((a) => a.command)).toEqual([
        { type: 'startFulfilment' },
        { type: 'ship', trackingCode: id },
        { type: 'deliver' },
      ]);
      expect(fakeOrders.statusOf(orderId)).toBe('DELIVERED');
      expect((await t.deliveryRow(id)).orderSyncedStatus).toBe('DELIVERED');
    });

    it('S20 AS-36: a command the order already reached counts as success; a replay applies nothing twice', async () => {
      const shop = await t.shopMembers();
      const orderId = await singleShopOrder(shop);
      fakeOrders.setOrder(orderId, 'FULFILLING'); // e.g. an earlier cancelled-and-re-requested delivery got that far
      const city = t.uniqueCity();
      const c = await t.newCourier({ city });
      const id = await t.makeBusy(c, {
        orderId,
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });

      await runJob(id, 'ASSIGNED');
      await runJob(id, 'ASSIGNED');

      expect(fakeOrders.applied).toEqual([]);
      expect(fakeOrders.statusOf(orderId)).toBe('FULFILLING');
      expect((await t.deliveryRow(id)).orderSyncedStatus).toBe('ASSIGNED');
    });

    it('S20 AS-36: when the order service fails three times the job is retried; the delivery is untouched and each command is applied once', async () => {
      const shop = await t.shopMembers();
      const orderId = await singleShopOrder(shop);
      const city = t.uniqueCity();
      const c = await t.newCourier({ city });
      const id = await t.makeBusy(c, {
        orderId,
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
        status: 'PICKED_UP',
      });
      const before = await snapshot(id);
      fakeOrders.failNext(3);

      for (let attempt = 1; attempt <= 3; attempt++)
        await expect(runJob(id, 'PICKED_UP')).rejects.toThrow(
          'order service unavailable',
        );
      await runJob(id, 'PICKED_UP');
      await runJob(id, 'PICKED_UP');

      expect(fakeOrders.applied.map((a) => a.command)).toEqual([
        { type: 'startFulfilment' },
        { type: 'ship', trackingCode: id },
      ]);
      expect(fakeOrders.statusOf(orderId)).toBe('SHIPPED');
      expect(await t.deliveryRow(id)).toMatchObject({
        status: 'PICKED_UP',
        version: before.row.version,
        orderSyncedStatus: 'PICKED_UP',
      });
      expect(await snapshot(id)).toMatchObject({
        history: before.history,
        outbox: before.outbox,
      });
    });

    it('S20 AS-36: a multi-shop order gets no command; an unknown order is dead-lettered with a reason', async () => {
      const shop = await t.shopMembers();
      const other = await t.seller();
      const multi = await singleShopOrder(shop, [shop.shopId, other.shopId]);
      const city = t.uniqueCity();
      const c1 = await t.newCourier({ city });
      const c2 = await t.newCourier({ city });
      const a = await t.makeBusy(c1, {
        orderId: multi,
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
      const unknown = await singleShopOrder(shop);
      fakeOrders.reset(); // the order service does not know this order
      const b = await t.makeBusy(c2, {
        orderId: unknown,
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });

      fakeOrders.setOrder(multi, 'PAID');
      await runJob(a, 'ASSIGNED');
      expect(fakeOrders.calls).toEqual([]);

      await expect(runJob(b, 'ASSIGNED')).rejects.toBeInstanceOf(
        NonRetryableJobError,
      );
      expect((await t.deliveryRow(b)).orderSyncedStatus).toBeNull();
    });

    it('S20 AS-36: the recovery job re-drives a write-back whose job was never queued, once per milestone', async () => {
      const shop = await t.shopMembers();
      const city = t.uniqueCity();
      const c = await t.newCourier({ city });
      const id = await t.makeBusy(c, {
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
        status: 'PICKED_UP',
      });
      expect(await jobsFor(id)).toEqual([]);

      await recovery.recoverOverdue(t.clock.now(), null);
      await recovery.recoverOverdue(t.clock.now(), null);

      expect((await jobsFor(id)).map((j) => j.status)).toEqual(['PICKED_UP']);
    });
  });
});
