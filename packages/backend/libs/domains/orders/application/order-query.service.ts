import { Inject, Injectable } from '@nestjs/common';
import type { OrderDto } from '@marketplace-sandbox/contracts';
import {
  ORDER_HISTORY_REPOSITORY,
  ORDER_REPOSITORY,
  SHOP_ORDER_REPOSITORY,
  type OrderHistoryRepository,
  type OrderRepository,
  type ShopOrderRepository,
} from '../domain/ports';
import { OrderNotFoundError } from '../domain/order-errors';

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
  ) {}

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
