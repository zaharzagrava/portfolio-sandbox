import { Injectable } from '@nestjs/common';
import {
  InvalidOrderTransitionError,
  OrderFulfilmentService,
  OrderNotFoundError,
  type OrderStatus,
} from '@app/domains/orders';
import type {
  OrderCommand,
  OrderLifecycleOutcome,
  OrderLifecyclePort,
} from '../domain/delivery-ports';

/** The order status each command leads to, and the statuses at or past it on the fulfilment path. */
const TARGETS: Record<OrderCommand['type'], OrderStatus[]> = {
  startFulfilment: ['FULFILLING', 'SHIPPED', 'DELIVERED'],
  ship: ['SHIPPED', 'DELIVERED'],
  deliver: ['DELIVERED'],
};

/**
 * `OrderLifecyclePort` over the orders capability's exported command service (S20 FR-046, R1): one call per milestone.
 * `InvalidOrderTransitionError` is success when the order is already at or past the target (a replay, or an earlier
 * cancelled-and-re-requested delivery got there first) and a final refusal otherwise; an unknown order is final too.
 * Anything else is transient and propagates so the job is retried.
 */
@Injectable()
export class OrderLifecycleAdapter implements OrderLifecyclePort {
  constructor(private readonly orders: OrderFulfilmentService) {}

  async apply(
    orderId: string,
    command: OrderCommand,
  ): Promise<OrderLifecycleOutcome> {
    try {
      await this.orders.apply(orderId, command);
      return 'applied';
    } catch (error) {
      if (error instanceof OrderNotFoundError) return 'order_not_found';
      if (error instanceof InvalidOrderTransitionError)
        return TARGETS[command.type].includes(error.currentStatus)
          ? 'already_reached'
          : 'invalid_transition';
      throw error;
    }
  }
}
