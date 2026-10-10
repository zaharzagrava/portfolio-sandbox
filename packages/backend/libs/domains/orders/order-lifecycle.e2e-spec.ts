import { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { OrderLifecycleService } from './application/order-lifecycle.service';
import { OrderFulfilmentService } from './application/order-fulfilment.service';
import {
  InvalidOrderTransitionError,
  OrderNotFoundError,
} from './domain/order-errors';
import {
  createOrdersApp,
  historyOf,
  orderRow,
  reservationsOf,
  seedPendingOrder,
  seedShopWithProducts,
  type OrdersTestApp,
} from './testing/orders-app';

describe('Orders: state machine, cancel and fulfilment commands', () => {
  let t: OrdersTestApp;
  let lifecycle: OrderLifecycleService;
  let fulfilment: OrderFulfilmentService;

  beforeAll(async () => {
    t = await createOrdersApp();
    lifecycle = t.app.get(OrderLifecycleService);
    fulfilment = t.app.get(OrderFulfilmentService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const pendingOrder = async () => {
    const buyer = await t.newUser();
    const { shop, products } = await seedShopWithProducts(t.app, [
      { priceMinor: 1_000, quantity: 10 },
    ]);
    const order = await seedPendingOrder(t.app, {
      userId: buyer.id,
      lines: [
        {
          productId: products[0].id,
          shopId: shop.id,
          quantity: 2,
          unitPriceMinor: 1_000,
        },
      ],
    });
    return { buyer, shop, product: products[0], order };
  };
  const hold = () => new Date(t.clock.now().getTime() + 15 * 60_000);

  it('S10 AS-56: one history row, one version step and one event per move from PENDING through DELIVERED', async () => {
    const { buyer, order } = await pendingOrder();
    expect(order.version).toBe(1);

    const moves = [
      {
        command: { type: 'reserve' } as const,
        to: 'RESERVED',
        event: 'order.reserved',
      },
      {
        command: { type: 'markPaid', paymentRef: 'pi_test_1' } as const,
        to: 'PAID',
        event: 'order.paid',
      },
      {
        command: { type: 'startFulfilment' } as const,
        to: 'FULFILLING',
        event: 'order.fulfilment_changed',
      },
      {
        command: { type: 'ship', trackingCode: 'TRK-1' } as const,
        to: 'SHIPPED',
        event: 'order.fulfilment_changed',
      },
      {
        command: { type: 'deliver' } as const,
        to: 'DELIVERED',
        event: 'order.fulfilment_changed',
      },
    ];
    let previous = 'PENDING';
    for (const [i, move] of moves.entries()) {
      const result = await lifecycle.transition(order.id, move.command, {
        actor: 'user:test',
        reservedUntil: hold(),
      });
      expect(result.kind).toBe('applied');

      const row = await orderRow(t.app, order.id);
      expect(row.status).toBe(move.to);
      expect(row.version).toBe(order.version + i + 1);

      const history = await historyOf(t.app, order.id);
      expect(history).toHaveLength(i + 2); // the creation row plus one per move
      expect(history[i + 1]).toMatchObject({
        fromStatus: previous,
        toStatus: move.to,
        actor: 'user:test',
      });
      previous = move.to;

      const events = (await outboxRowsFor(t.app, order.id)).filter(
        (r) => r.kind === 'event',
      );
      expect(events).toHaveLength(i + 1);
      const envelope = events[i].payload as {
        type: string;
        aggregateVersion: number;
        payload: unknown;
      };
      expect(envelope.type).toBe(move.event);
      expect(envelope.aggregateVersion).toBe(row.version);
      const parsed = orderEventSchemas[
        move.event as keyof typeof orderEventSchemas
      ].parse(envelope.payload) as {
        orderVersion: number;
        userId: string;
      };
      expect(parsed.orderVersion).toBe(row.version);
      expect(parsed.userId).toBe(buyer.id);
    }
  });

  it('S10 AS-56: the shop order and the reservations follow the order (reserve holds, pay converts)', async () => {
    const { order } = await pendingOrder();
    expect(
      (await reservationsOf(t.app, order.id)).map((r) => r.status),
    ).toEqual(['REQUESTED']);
    await lifecycle.transition(
      order.id,
      { type: 'reserve' },
      { actor: 'system:test', reservedUntil: hold() },
    );
    expect(
      (await reservationsOf(t.app, order.id)).map((r) => r.status),
    ).toEqual(['HELD']);
    await lifecycle.transition(
      order.id,
      { type: 'markPaid', paymentRef: 'pi_1' },
      { actor: 'system:test' },
    );
    expect(
      (await reservationsOf(t.app, order.id)).map((r) => r.status),
    ).toEqual(['CONVERTED']);
    expect((await orderRow(t.app, order.id)).paymentRef).toBe('pi_1');
  });

  it('S10 AS-56: 20 concurrent copies of one move apply once; the others see it already applied', async () => {
    const { order } = await pendingOrder();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        lifecycle.transition(
          order.id,
          { type: 'reserve' },
          { actor: 'system:test', reservedUntil: hold() },
        ),
      ),
    );
    expect(results.filter((r) => r.kind === 'applied')).toHaveLength(1);
    expect(
      results.filter(
        (r) => r.kind === 'already_applied' || r.kind === 'invalid',
      ),
    ).toHaveLength(19);
    expect((await orderRow(t.app, order.id)).version).toBe(2);
    expect(await historyOf(t.app, order.id)).toHaveLength(2);
    expect(
      (await outboxRowsFor(t.app, order.id)).filter((r) => r.kind === 'event'),
    ).toHaveLength(1);
  });

  it('S10 AS-56: a repeated move that already happened is a no-op, an impossible one is refused, neither writes', async () => {
    const { order } = await pendingOrder();
    await lifecycle.transition(
      order.id,
      { type: 'reserve' },
      { actor: 'a', reservedUntil: hold() },
    );
    await lifecycle.transition(
      order.id,
      { type: 'cancel', reason: 'user_cancelled' },
      { actor: 'a' },
    );

    const again = await lifecycle.transition(
      order.id,
      { type: 'cancel', reason: 'hold_expired' },
      { actor: 'b' },
    );
    expect(again.kind).toBe('already_applied');
    const late = await lifecycle.transition(
      order.id,
      { type: 'markPaid', paymentRef: 'pi_9' },
      { actor: 'b' },
    );
    expect(late.kind).toBe('invalid');
    const unknown = await lifecycle.transition(
      '0194f3a0-0000-7000-8000-00000000dead',
      { type: 'reserve' },
      { actor: 'b' },
    );
    expect(unknown.kind).toBe('not_found');

    expect(await historyOf(t.app, order.id)).toHaveLength(3);
    expect((await orderRow(t.app, order.id)).version).toBe(3);
    expect(
      (await outboxRowsFor(t.app, order.id)).filter((r) => r.kind === 'event'),
    ).toHaveLength(2);
  });

  it('S10 AS-57: OrderFulfilmentService.apply moves PAID → FULFILLING → SHIPPED → DELIVERED with order.fulfilment_changed', async () => {
    const { order } = await pendingOrder();
    await lifecycle.transition(
      order.id,
      { type: 'reserve' },
      { actor: 'a', reservedUntil: hold() },
    );
    await lifecycle.transition(
      order.id,
      { type: 'markPaid', paymentRef: 'pi_2' },
      { actor: 'a' },
    );

    const started = await fulfilment.apply(order.id, {
      type: 'startFulfilment',
    });
    expect(started).toEqual({ status: 'FULFILLING', orderVersion: 4 });
    const shipped = await fulfilment.apply(order.id, {
      type: 'ship',
      trackingCode: 'TRK-77',
    });
    expect(shipped).toEqual({ status: 'SHIPPED', orderVersion: 5 });
    const delivered = await fulfilment.apply(order.id, { type: 'deliver' });
    expect(delivered).toEqual({ status: 'DELIVERED', orderVersion: 6 });

    const events = (await outboxRowsFor(t.app, order.id))
      .filter((r) => r.type === 'order.fulfilment_changed')
      .map((r) =>
        orderEventSchemas['order.fulfilment_changed'].parse(
          (r.payload as { payload: unknown }).payload,
        ),
      );
    expect(events.map((e) => e.status)).toEqual([
      'FULFILLING',
      'SHIPPED',
      'DELIVERED',
    ]);
    expect(events[1].trackingCode).toBe('TRK-77');
    expect((await historyOf(t.app, order.id)).at(-1)?.actor).toBe(
      'system:fulfilment',
    );
  });

  it('S10 AS-57: an illegal fulfilment move throws InvalidOrderTransitionError and an unknown order OrderNotFoundError, writing nothing', async () => {
    const { order } = await pendingOrder();
    await expect(
      fulfilment.apply(order.id, { type: 'ship', trackingCode: 'x' }),
    ).rejects.toBeInstanceOf(InvalidOrderTransitionError);
    await expect(
      fulfilment.apply(order.id, { type: 'deliver' }),
    ).rejects.toMatchObject({
      orderId: order.id,
      currentStatus: 'PENDING',
      command: 'deliver',
    });
    await expect(
      fulfilment.apply('0194f3a0-0000-7000-8000-00000000dead', {
        type: 'startFulfilment',
      }),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(await historyOf(t.app, order.id)).toHaveLength(1);
    expect((await orderRow(t.app, order.id)).version).toBe(1);
    // (the single history row is the creation row)
  });
});
