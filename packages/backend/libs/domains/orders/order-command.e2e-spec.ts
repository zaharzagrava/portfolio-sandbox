import { randomUUID } from 'node:crypto';
import { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  OrderCommandService,
  type FixedPriceOrderCommand,
} from './application/order-command.service';
import { OrderQueryService } from './application/order-query.service';
import { OrderLifecycleService } from './application/order-lifecycle.service';
import { OrderCommandRejectedError } from './domain/order-command';
import { OrderJobs } from './infra/order.jobs';
import {
  createOrdersApp,
  historyOf,
  orderRow,
  rows,
  seedShopWithProducts,
  stockOf,
  type OrdersTestApp,
} from './testing/orders-app';

const MIN = 60_000;

describe('Orders: externally held fixed-price order command', () => {
  let t: OrdersTestApp;
  let commands: OrderCommandService;
  let jobs: OrderJobs;

  beforeAll(async () => {
    t = await createOrdersApp();
    commands = t.app.get(OrderCommandService);
    jobs = t.app.get(OrderJobs);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const setup = async (shopOptions: { status?: 'SUSPENDED' } = {}) => {
    const buyer = await t.newUser();
    const { shop, products } = await seedShopWithProducts(
      t.app,
      [{ priceMinor: 9_999, quantity: 5 }],
      shopOptions,
    );
    const command = (
      overrides: Partial<FixedPriceOrderCommand> = {},
    ): FixedPriceOrderCommand => ({
      idempotencyKey: `auction:${randomUUID()}:winner`,
      buyerId: buyer.id,
      shopId: shop.id,
      productId: products[0].id,
      quantity: 1,
      unitPriceMinor: 4_250,
      currency: 'USD',
      titleSnapshot: 'Auction lot',
      reservedUntil: new Date(t.clock.now().getTime() + 30 * MIN).toISOString(),
      origin: { kind: 'AUCTION', ref: randomUUID(), step: 'winner' },
      stockHandling: 'EXTERNALLY_HELD',
      ...overrides,
    });
    return { buyer, shop, product: products[0], command };
  };
  const reservationRows = (orderId: string) =>
    rows<{
      source: string;
      sourceRef: string | null;
      status: string;
      quantity: number;
    }>(
      t.app,
      `SELECT "source", "sourceRef", "status", "quantity" FROM "StockReservation" WHERE "bisOrderId" = :orderId`,
      { orderId },
    );
  const stockOperations = (productId: string) =>
    rows<{ operationId: string }>(
      t.app,
      `SELECT "operationId" FROM "ProductStockOperation" WHERE "productId" = :productId`,
      { productId },
    );
  const eventTypes = async (orderId: string) =>
    (await outboxRowsFor(t.app, orderId))
      .filter((r) => r.kind === 'event')
      .map((r) => (r.payload as { type: string }).type);

  it('S21 AS-27: creates a RESERVED order at the given price with an EXTERNAL reservation and order.reserved', async () => {
    const { buyer, shop, product, command } = await setup();
    const cmd = command();
    const answer = await commands.createFixedPriceOrder(cmd);

    expect(answer).toEqual({
      orderId: expect.any(String),
      status: 'RESERVED',
      reservedUntil: cmd.reservedUntil,
      replayed: false,
    });
    const row = await orderRow(t.app, answer.orderId);
    expect(row.status).toBe('RESERVED');
    expect(Number(row.total)).toBe(4_250);
    expect(row.reservedUntil?.toISOString()).toBe(cmd.reservedUntil);

    const items = await rows<{
      productId: string;
      quantity: number;
      priceAtPurchase: string;
      discountMinor: string;
      title: string;
      shopId: string;
    }>(
      t.app,
      `SELECT "productId", "quantity", "priceAtPurchase", "discountMinor", "title", "shopId" FROM "BisOrderItem" WHERE "bisOrderId" = :id`,
      { id: answer.orderId },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      productId: product.id,
      quantity: 1,
      title: 'Auction lot',
      shopId: shop.id,
    });
    expect(Number(items[0].priceAtPurchase)).toBe(4_250);
    expect(Number(items[0].discountMinor)).toBe(0);

    const shopOrders = await rows<{ shopId: string; subtotal: string }>(
      t.app,
      `SELECT "shopId", "subtotal" FROM "ShopOrder" WHERE "bisOrderId" = :id`,
      { id: answer.orderId },
    );
    expect(shopOrders).toHaveLength(1);
    expect(Number(shopOrders[0].subtotal)).toBe(4_250);

    expect(await reservationRows(answer.orderId)).toEqual([
      {
        source: 'EXTERNAL',
        sourceRef: cmd.origin.ref,
        status: 'HELD',
        quantity: 1,
      },
    ]);

    const history = await historyOf(t.app, answer.orderId);
    expect(history.at(-1)).toMatchObject({
      toStatus: 'RESERVED',
      actor: 'system:auction',
    });

    const events = (await outboxRowsFor(t.app, answer.orderId)).filter(
      (r) => r.kind === 'event',
    );
    expect(events).toHaveLength(1);
    const envelope = events[0].payload as { type: string; payload: unknown };
    expect(envelope.type).toBe('order.reserved');
    expect(
      orderEventSchemas['order.reserved'].parse(envelope.payload),
    ).toMatchObject({ userId: buyer.id, totalMinor: 4_250 });

    // no stock operation, the catalog stock is untouched
    expect(await stockOperations(product.id)).toHaveLength(0);
    expect((await stockOf(t.app, [product.id]))[product.id]).toBe(5);
  });

  it('S21 AS-27: the order is payable through getPayableOrder', async () => {
    const { buyer, command } = await setup();
    const answer = await commands.createFixedPriceOrder(command());
    const payable = await t.app
      .get(OrderQueryService)
      .getPayableOrder(answer.orderId, buyer.id);
    expect(payable).toMatchObject({
      orderId: answer.orderId,
      userId: buyer.id,
      totalMinor: 4_250,
      currency: 'USD',
    });
  });

  it('S21 AS-39: the same idempotencyKey replays the stored order (replayed: true, one order)', async () => {
    const { buyer, command } = await setup();
    const cmd = command();
    const first = await commands.createFixedPriceOrder(cmd);
    const second = await commands.createFixedPriceOrder(cmd);
    expect(second).toEqual({ ...first, replayed: true });

    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => commands.createFixedPriceOrder(cmd)),
    );
    for (const a of concurrent) expect(a.orderId).toBe(first.orderId);

    const orders = await rows<{ id: string }>(
      t.app,
      `SELECT "id" FROM "BisOrder" WHERE "userId" = :u`,
      { u: buyer.id },
    );
    expect(orders).toHaveLength(1);
    expect(await reservationRows(first.orderId)).toHaveLength(1);
    expect(await eventTypes(first.orderId)).toEqual(['order.reserved']);
  });

  it('S21 AS-27: concurrent first calls with one key create one order', async () => {
    const { command } = await setup();
    const cmd = command();
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => commands.createFixedPriceOrder(cmd)),
    );
    expect(new Set(answers.map((a) => a.orderId)).size).toBe(1);
    expect(answers.filter((a) => !a.replayed)).toHaveLength(1);
  });

  describe('permanent rejections', () => {
    const rejection = async (
      p: Promise<unknown>,
    ): Promise<OrderCommandRejectedError> => {
      const error = await p.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(OrderCommandRejectedError);
      return error as OrderCommandRejectedError;
    };

    it('S21 AS-27: an unknown buyer is buyer_not_eligible', async () => {
      const { command } = await setup();
      const error = await rejection(
        commands.createFixedPriceOrder(command({ buyerId: randomUUID() })),
      );
      expect(error.code).toBe('buyer_not_eligible');
    });

    it('S21 AS-27: a suspended shop is shop_not_eligible', async () => {
      const { command } = await setup({ status: 'SUSPENDED' });
      const error = await rejection(commands.createFixedPriceOrder(command()));
      expect(error.code).toBe('shop_not_eligible');
    });

    it('S21 AS-27: an unknown shop is shop_not_eligible', async () => {
      const { command } = await setup();
      const error = await rejection(
        commands.createFixedPriceOrder(command({ shopId: randomUUID() })),
      );
      expect(error.code).toBe('shop_not_eligible');
    });

    it.each([0, -5, 12.5])(
      'S21 AS-27: unitPriceMinor %p is invalid_price',
      async (price) => {
        const { buyer, command } = await setup();
        const error = await rejection(
          commands.createFixedPriceOrder(command({ unitPriceMinor: price })),
        );
        expect(error.code).toBe('invalid_price');
        const orders = await rows<{ id: string }>(
          t.app,
          `SELECT "id" FROM "BisOrder" WHERE "userId" = :u`,
          { u: buyer.id },
        );
        expect(orders).toHaveLength(0);
      },
    );
  });

  describe('release of EXTERNAL holds', () => {
    it('S21 AS-27: a cancel emits order.cancelled and makes no stock operation', async () => {
      const { product, command } = await setup();
      const { orderId } = await t.app
        .get(OrderCommandService)
        .createFixedPriceOrder(command());

      const result = await t.app
        .get(OrderLifecycleService)
        .transition(
          orderId,
          { type: 'cancel', reason: 'user_cancelled' },
          { actor: 'user:test' },
        );
      expect(result.kind).toBe('applied');

      expect((await orderRow(t.app, orderId)).status).toBe('CANCELLED');
      expect(await eventTypes(orderId)).toEqual([
        'order.reserved',
        'order.cancelled',
      ]);
      expect((await reservationRows(orderId))[0]).toMatchObject({
        source: 'EXTERNAL',
        status: 'RELEASED',
      });
      expect(await stockOperations(product.id)).toHaveLength(0);
      expect((await stockOf(t.app, [product.id]))[product.id]).toBe(5);
    });

    it('S21 AS-27: expiry emits order.cancelled and makes no stock operation', async () => {
      const { product, command } = await setup();
      const { orderId } = await commands.createFixedPriceOrder(command());

      t.clock.advance(31 * MIN);
      await jobs.expireReservation({ orderId });

      const row = await orderRow(t.app, orderId);
      expect(row.status).toBe('CANCELLED');
      expect(row.cancelReason).toBe('hold_expired');
      expect(await eventTypes(orderId)).toEqual([
        'order.reserved',
        'order.cancelled',
      ]);
      expect((await reservationRows(orderId))[0]).toMatchObject({
        source: 'EXTERNAL',
        status: 'RELEASED',
      });
      expect(await stockOperations(product.id)).toHaveLength(0);
    });

    it('S10 amendment: the source CHECK accepts EXTERNAL next to CATALOG and FLASH (their releases are covered by the S10 and S11 specs)', async () => {
      const [{ def }] = await rows<{ def: string }>(
        t.app,
        `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conname = 'StockReservation_source_check'`,
        {},
      );
      for (const source of ['CATALOG', 'FLASH', 'EXTERNAL'])
        expect(def).toContain(source);
    });
  });
});
