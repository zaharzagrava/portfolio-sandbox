import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { OrderCancelled, OrderPaid } from '@app/domains/orders';
import { waitFor } from '@app/test/utils/async-helpers';
import { readTopic } from '@app/test/utils/kafka-test';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import { DeliveryProjectorModule } from './delivery-projector.module';
import {
  DELIVERABLE_ORDER_STORE,
  type DeliverableOrderStore,
} from './domain/delivery-ports';
import {
  DeliveryOrderCancelledProjector,
  DeliveryOrderPaidProjector,
} from './infra/delivery-order.consumers';
import {
  createDeliveryApp,
  type DeliveryTestApp,
} from './testing/delivery-fixtures';

describe('Delivery order events: deliverable-order copy', () => {
  let t: DeliveryTestApp;
  let orders: DeliverableOrderStore;
  let paidProjector: DeliveryOrderPaidProjector;
  let cancelledProjector: DeliveryOrderCancelledProjector;
  const kit = new ConsumerKit();

  beforeAll(async () => {
    t = await createDeliveryApp();
    orders = t.app.get<DeliverableOrderStore>(DELIVERABLE_ORDER_STORE);
    paidProjector = t.app.get(DeliveryOrderPaidProjector);
    cancelledProjector = t.app.get(DeliveryOrderCancelledProjector);
    await kit.start();
  });
  afterAll(async () => {
    await kit.stopAll();
    await t.close();
  });
  beforeEach(() => t.reset());

  /** A contract-valid `order.paid` (S10 `orderEventSchemas['order.paid']`). */
  const paid = (input: {
    orderId: string;
    userId: string;
    shopIds: (string | null)[];
    orderVersion?: number;
    currency?: string;
  }) => {
    const orderVersion = input.orderVersion ?? 4;
    return OrderPaid.create(input.orderId, orderVersion, {
      orderId: input.orderId,
      userId: input.userId,
      orderVersion,
      totalMinor: 12_900,
      currency: input.currency ?? 'EUR',
      paymentRef: uuidv4(),
      paidAt: t.clock.now().toISOString(),
      lines: input.shopIds.map((shopId) => ({
        productId: uuidv4(),
        shopId,
        title: 'Item',
        quantity: 1,
        unitPriceMinor: 12_900,
        discountMinor: 0,
        lineTotalMinor: 12_900,
      })),
      shopOrders: input.shopIds.map((shopId) => ({
        shopOrderId: uuidv4(),
        shopId,
        subtotalMinor: 12_900,
      })),
    });
  };
  const cancelled = (orderId: string, userId: string, orderVersion: number) =>
    OrderCancelled.create(orderId, orderVersion, {
      orderId,
      userId,
      orderVersion,
      reason: 'user_cancelled',
      previousStatus: 'PAID',
    });
  const copyRows = (orderId: string) =>
    t.sql<{ orderId: string }>(
      `SELECT "orderId" FROM "DeliverableOrder" WHERE "orderId" = :orderId`,
      { orderId },
    );

  describe('US8 - order.paid consumer (AS-55)', () => {
    it('S20 AS-55: order.paid creates the copy {buyer, shops, currency, PAID, version 4}; delivering it twice changes nothing', async () => {
      const { shopId } = await t.seller();
      const orderId = uuidv4();
      const buyerId = uuidv4();
      const event = paid({ orderId, userId: buyerId, shopIds: [shopId] });

      await paidProjector.project([event]);

      const copy = await orders.find(orderId);
      expect(copy).toMatchObject({
        orderId,
        buyerId,
        shopIds: [shopId],
        currency: 'EUR',
        status: 'PAID',
        orderVersion: 4,
      });
      const [first] = await t.sql<{ updatedAt: Date }>(
        `SELECT "updatedAt" FROM "DeliverableOrder" WHERE "orderId" = :orderId`,
        { orderId },
      );

      t.clock.advance(5_000);
      await paidProjector.project([event]);

      expect(await copyRows(orderId)).toHaveLength(1);
      expect(await orders.find(orderId)).toEqual(copy);
      const [second] = await t.sql<{ updatedAt: Date }>(
        `SELECT "updatedAt" FROM "DeliverableOrder" WHERE "orderId" = :orderId`,
        { orderId },
      );
      expect(second.updatedAt).toEqual(first.updatedAt);
    });

    it('S20 AS-55: the copy lists the distinct shops of the order and leaves out lines without a shop', async () => {
      const a = await t.seller();
      const b = await t.seller();
      const orderId = uuidv4();

      await paidProjector.project([
        paid({
          orderId,
          userId: uuidv4(),
          shopIds: [a.shopId, null, b.shopId, a.shopId],
        }),
      ]);

      const copy = await orders.find(orderId);
      expect([...(copy?.shopIds ?? [])].sort()).toEqual(
        [a.shopId, b.shopId].sort(),
      );
    });

    it('S20 AS-55: missing orderId, shopOrders not an array and an unknown event version are dead-lettered with a reason and nothing is written', async () => {
      const { shopId } = await t.seller();
      const s = await kit.scenario();
      const name = `delivery-order-paid-${s.id}`;
      @Injectable()
      class Sub extends DeliveryOrderPaidProjector {
        override readonly name: string = name;
        override readonly topics: string[] = [s.topic];
      }
      await s.boot([Sub], { imports: [DeliveryProjectorModule] });

      const orderId = uuidv4();
      const good = paid({ orderId, userId: uuidv4(), shopIds: [shopId] });
      const noOrderId = {
        ...good,
        payload: { ...good.payload, orderId: undefined },
      };
      const notArray = {
        ...good,
        payload: { ...good.payload, shopOrders: 'S1' },
      };
      const unknownVersion = { ...good, version: 99 };
      const publish = (e: unknown) =>
        s.publishRaw([
          {
            key: (e as { aggregateId: string }).aggregateId,
            value: JSON.stringify(e),
          },
        ]);
      await publish(noOrderId);
      await publish(notArray);
      await publish(unknownVersion);

      await waitFor(async () => (await readTopic(`${name}.dlq`)).length === 3, {
        description: 'three dead letters',
      });
      const dead = await readTopic(`${name}.dlq`);
      for (const letter of dead)
        expect(letter.headers['x-dlq-reason']).toBeTruthy();
      expect(await copyRows(orderId)).toHaveLength(0);
      expect(await orders.find(orderId)).toBeNull();
    }, 120_000);
  });

  describe('US8 - out of order and version guard (AS-56)', () => {
    it('S20 AS-56: order.cancelled(6) before order.paid(4) leaves CANCELLED at 6, the older paid is ignored and a delivery request answers order_not_deliverable', async () => {
      const members = await t.shopMembers();
      const city = t.uniqueCity();
      await t.newCourier({ city });
      const orderId = uuidv4();

      await cancelledProjector.project([
        cancelled(orderId, members.buyer.id, 6),
      ]);
      await paidProjector.project([
        paid({
          orderId,
          userId: members.buyer.id,
          shopIds: [members.shopId],
          orderVersion: 4,
        }),
      ]);

      expect(await orders.find(orderId)).toMatchObject({
        status: 'CANCELLED',
        orderVersion: 6,
        buyerId: members.buyer.id,
      });
      const res = await t
        .as(members.owner)
        .post(`/api/shops/${members.shopId}/deliveries`)
        .set('Idempotency-Key', uuidv4())
        .send({
          orderId,
          city,
          pickup: { lat: 52.5219, lng: 13.4132 },
          dropoff: { lat: 52.5096, lng: 13.3759 },
        })
        .expect(409);
      expect(res.body.code).toBe('order_not_deliverable');
    });

    it('S20 AS-56: a higher order.paid version while PAID updates shops and version; an equal or lower one changes nothing', async () => {
      const a = await t.seller();
      const b = await t.seller();
      const orderId = uuidv4();
      const buyerId = uuidv4();

      await paidProjector.project([
        paid({ orderId, userId: buyerId, shopIds: [a.shopId] }),
      ]);
      await paidProjector.project([
        paid({
          orderId,
          userId: buyerId,
          shopIds: [a.shopId, b.shopId],
          orderVersion: 5,
        }),
      ]);
      expect([...((await orders.find(orderId))?.shopIds ?? [])].sort()).toEqual(
        [a.shopId, b.shopId].sort(),
      );
      expect((await orders.find(orderId))?.orderVersion).toBe(5);

      const before = await orders.find(orderId);
      await paidProjector.project([
        paid({
          orderId,
          userId: buyerId,
          shopIds: [b.shopId],
          orderVersion: 5,
        }),
        paid({
          orderId,
          userId: buyerId,
          shopIds: [b.shopId],
          orderVersion: 3,
        }),
      ]);
      expect(await orders.find(orderId)).toEqual(before);
    });

    it('S20 AS-56: order.cancelled updates the copy of a paid order with the event user as buyer; an older cancel is ignored', async () => {
      const { shopId } = await t.seller();
      const orderId = uuidv4();
      const buyerId = uuidv4();
      await paidProjector.project([
        paid({ orderId, userId: buyerId, shopIds: [shopId], orderVersion: 4 }),
      ]);

      await cancelledProjector.project([cancelled(orderId, buyerId, 3)]);
      expect((await orders.find(orderId))?.status).toBe('PAID');

      await cancelledProjector.project([cancelled(orderId, buyerId, 7)]);
      expect(await orders.find(orderId)).toMatchObject({
        status: 'CANCELLED',
        orderVersion: 7,
        buyerId,
      });
    });
  });
});
