import { Injectable } from '@nestjs/common';
import type { OrderStatus } from '../domain/order-state';
import {
  InvalidOrderTransitionError,
  OrderNotFoundError,
} from '../domain/order-errors';
import { OrderLifecycleService } from './order-lifecycle.service';

export type FulfilmentCommand =
  | { type: 'startFulfilment' }
  | { type: 'ship'; trackingCode: string }
  | { type: 'deliver' };

/**
 * R1 command for the fulfilment capabilities (S19, S20): the same guarded move as every other trigger, with
 * `order.fulfilment_changed` on the outbox. An illegal move throws `InvalidOrderTransitionError`, an unknown order
 * `OrderNotFoundError`.
 */
@Injectable()
export class OrderFulfilmentService {
  constructor(private readonly lifecycle: OrderLifecycleService) {}

  async apply(
    orderId: string,
    command: FulfilmentCommand,
    actor = 'system:fulfilment',
  ): Promise<{ status: OrderStatus; orderVersion: number }> {
    const result = await this.lifecycle.transition(orderId, command, { actor });
    switch (result.kind) {
      case 'applied':
      case 'already_applied':
        return {
          status: result.order.status,
          orderVersion: result.order.version,
        };
      case 'invalid':
        throw new InvalidOrderTransitionError(
          orderId,
          result.order.status,
          command.type,
        );
      case 'not_found':
        throw new OrderNotFoundError();
    }
  }
}
