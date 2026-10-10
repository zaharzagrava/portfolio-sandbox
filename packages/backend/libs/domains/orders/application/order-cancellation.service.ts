import { Inject, Injectable } from '@nestjs/common';
import type { OrderDto } from '@marketplace-sandbox/contracts';
import { ORDER_REPOSITORY, type OrderRepository } from '../domain/ports';
import {
  OrderNotCancellableError,
  OrderNotFoundError,
} from '../domain/order-errors';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderQueryService } from './order-query.service';

/** The buyer cancels their own unpaid order (S10 FR-031, AS-40, AS-55). */
@Injectable()
export class OrderCancellationService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    private readonly lifecycle: OrderLifecycleService,
    private readonly query: OrderQueryService,
  ) {}

  /**
   * `404` for a missing or foreign order (the lookup is scoped to the buyer in the statement), `200` for an order that
   * is already cancelled (nothing changes), `409 order_not_cancellable` once it is paid or past.
   */
  async cancel(orderId: string, userId: string): Promise<OrderDto> {
    const order = await this.orders.findForUser(orderId, userId);
    if (!order) throw new OrderNotFoundError();
    const result = await this.lifecycle.transition(
      orderId,
      { type: 'cancel', reason: 'user_cancelled' },
      { actor: `user:${userId}` },
    );
    switch (result.kind) {
      case 'applied':
      case 'already_applied':
        return this.query.getOrderForUser(orderId, userId);
      case 'invalid':
        throw new OrderNotCancellableError(result.order.status);
      case 'not_found':
        throw new OrderNotFoundError();
    }
  }
}
