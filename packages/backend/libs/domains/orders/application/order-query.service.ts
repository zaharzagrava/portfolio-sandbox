import { Inject, Injectable } from '@nestjs/common';
import {
  ORDER_PAGE_LIMITS,
  type OrderDto,
  type OrderPageDto,
  type ShopOrderPageDto,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  ORDER_HISTORY_REPOSITORY,
  ORDER_REPOSITORY,
  SHOP_ORDER_REPOSITORY,
  type OrderHistoryRepository,
  type OrderRepository,
  type ShopOrderRepository,
  type ShopOrderStatus,
} from '../domain/ports';
import {
  OrderNotFoundError,
  OrderNotPayableError,
  TooManyIdsError,
} from '../domain/order-errors';
import {
  MAX_ORDER_LINE_IDS,
  type OrderLineDto,
  type PayableOrderDto,
} from '../domain/order-views';
import { decodeOrderCursor, encodeOrderCursor } from '../domain/order-cursor';

/**
 * Order reads as plain DTOs (no model leaves the domain). Every read is scoped to the principal inside the statement:
 * a foreign order is indistinguishable from a missing one.
 */
@Injectable()
export class OrderQueryService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(SHOP_ORDER_REPOSITORY)
    private readonly shopOrders: ShopOrderRepository,
    @Inject(ORDER_HISTORY_REPOSITORY)
    private readonly history: OrderHistoryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** One keyset page of the buyer's own orders, newest first; `nextCursor` is bound to the buyer. */
  async getOrdersForUser(
    userId: string,
    limit: number,
    cursor: string | null,
  ): Promise<OrderPageDto> {
    const scope = `user:${userId}`;
    const after = cursor ? decodeOrderCursor(scope, cursor) : null;
    const rows = await this.orders.pageForUser(userId, limit + 1, after);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((o) => ({
        id: o.id,
        status: o.status,
        totalMinor: o.totalMinor,
        currency: o.currency,
        createdAt: o.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeOrderCursor(scope, {
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  /** One keyset page of a shop's slices of orders, newest first; only that shop's lines and subtotal leave the domain. */
  async getOrdersForShop(
    shopId: string,
    options: { status?: ShopOrderStatus; limit?: number; cursor?: string } = {},
  ): Promise<ShopOrderPageDto> {
    const limit = Math.min(
      Math.max(
        options.limit ?? ORDER_PAGE_LIMITS.default,
        ORDER_PAGE_LIMITS.min,
      ),
      ORDER_PAGE_LIMITS.max,
    );
    const scope = `shop:${shopId}`;
    const after = options.cursor
      ? decodeOrderCursor(scope, options.cursor)
      : null;
    const found = await this.shopOrders.pageForShop(
      shopId,
      options.status ?? null,
      limit + 1,
      after,
    );
    const page = found.slice(0, limit);
    const last = page[page.length - 1];
    const lines = await this.shopOrders.lines(
      page.map((p) => p.orderId),
      shopId,
    );
    return {
      items: page.map((p) => ({
        shopOrderId: p.id,
        orderId: p.orderId,
        status: p.status,
        subtotalMinor: p.subtotalMinor,
        currency: p.currency,
        buyerId: p.buyerId,
        createdAt: p.createdAt.toISOString(),
        items: lines
          .filter((l) => l.shopOrderId === p.id)
          .map((l) => ({
            productId: l.productId,
            shopId: l.shopId,
            title: l.title ?? '',
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            discountMinor: l.discountMinor,
            lineTotalMinor: l.lineTotalMinor ?? l.unitPriceMinor * l.quantity,
          })),
      })),
      nextCursor:
        found.length > limit && last
          ? encodeOrderCursor(scope, {
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  /** Item lines of up to 500 orders from one statement; unknown ids are absent from the map. */
  async getOrderLines(
    orderIds: string[],
  ): Promise<Map<string, OrderLineDto[]>> {
    if (orderIds.length > MAX_ORDER_LINE_IDS)
      throw new TooManyIdsError(MAX_ORDER_LINE_IDS);
    const result = new Map<string, OrderLineDto[]>();
    for (const l of await this.shopOrders.lines(orderIds, null)) {
      const list = result.get(l.orderId) ?? [];
      list.push({
        orderId: l.orderId,
        shopOrderId: l.shopOrderId,
        productId: l.productId,
        shopId: l.shopId,
        title: l.title ?? '',
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
        discountMinor: l.discountMinor,
        lineTotalMinor: l.lineTotalMinor ?? l.unitPriceMinor * l.quantity,
      });
      result.set(l.orderId, list);
    }
    return result;
  }

  /** What the payments capability needs to charge: only the buyer's own, `RESERVED`, unexpired order (FR-041). */
  async getPayableOrder(
    orderId: string,
    userId: string,
  ): Promise<PayableOrderDto> {
    const order = await this.orders.findForUser(orderId, userId);
    if (!order) throw new OrderNotFoundError();
    if (order.status !== 'RESERVED' || !order.reservedUntil)
      throw new OrderNotPayableError(
        order.id,
        order.status,
        'order_not_reserved',
      );
    if (order.reservedUntil.getTime() <= this.clock.now().getTime())
      throw new OrderNotPayableError(order.id, order.status, 'hold_expired');
    const slices = await this.shopOrders.forOrder(orderId);
    return {
      orderId: order.id,
      userId: order.userId,
      totalMinor: order.totalMinor,
      currency: order.currency,
      reservedUntil: order.reservedUntil.toISOString(),
      shopAllocations: slices.map((s) => ({
        shopId: s.shopId,
        subtotalMinor: s.subtotalMinor,
      })),
    };
  }

  /** The buyer's own order with its snapshots and timeline; `OrderNotFoundError` for a missing or foreign one. */
  async getOrderForUser(orderId: string, userId: string): Promise<OrderDto> {
    const order = await this.orders.findForUser(orderId, userId);
    if (!order) throw new OrderNotFoundError();
    const [items, shopOrders, timeline] = await Promise.all([
      this.orders.items(orderId),
      this.shopOrders.forOrder(orderId),
      this.history.timeline(orderId),
    ]);
    return {
      id: order.id,
      status: order.status,
      totalMinor: order.totalMinor,
      currency: order.currency,
      reservedUntil: order.reservedUntil?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      items: items.map((i) => ({
        productId: i.productId,
        shopId: i.shopId,
        title: i.title ?? '',
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
        discountMinor: i.discountMinor,
        lineTotalMinor: i.lineTotalMinor ?? i.unitPriceMinor * i.quantity,
      })),
      shopOrders: shopOrders.map((s) => ({
        id: s.id,
        shopId: s.shopId,
        subtotalMinor: s.subtotalMinor,
        status: s.status,
      })),
      timeline: timeline.map((h) => ({
        status: h.status,
        reason: h.reason,
        at: h.at.toISOString(),
      })),
    };
  }
}
