import { Module, type Type } from '@nestjs/common';
import {
  InvalidOrderTransitionError,
  OrderFulfilmentService,
  OrderNotFoundError,
  type FulfilmentCommand,
  type OrderStatus,
} from '@app/domains/orders';
import { OrderLifecycleService } from '../application/order-lifecycle.service';
import { DeliveryCoreModule } from '../delivery-core.module';
import { ORDER_LIFECYCLE_PORT } from '../domain/delivery-ports';
import { DeliveryJobHandlers } from '../infra/delivery-job-handlers';
import { OrderLifecycleAdapter } from '../infra/order-lifecycle.adapter';

const TARGET: Record<FulfilmentCommand['type'], OrderStatus> = {
  startFulfilment: 'FULFILLING',
  ship: 'SHIPPED',
  deliver: 'DELIVERED',
};
const FROM: Record<FulfilmentCommand['type'], OrderStatus> = {
  startFulfilment: 'PAID',
  ship: 'FULFILLING',
  deliver: 'SHIPPED',
};

/**
 * Stands in for the orders capability in the delivery specs: the same three moves and the same errors as
 * `OrderFulfilmentService`, with a switch to make the next calls fail like an unreachable service.
 */
export class FakeOrderFulfilment {
  private readonly statuses = new Map<string, OrderStatus>();
  /** Commands that changed an order, in order. */
  readonly applied: { orderId: string; command: FulfilmentCommand }[] = [];
  /** Every call, including refused and failed ones. */
  readonly calls: { orderId: string; command: FulfilmentCommand }[] = [];
  private failures = 0;

  setOrder(orderId: string, status: OrderStatus = 'PAID'): void {
    this.statuses.set(orderId, status);
  }

  statusOf(orderId: string): OrderStatus | undefined {
    return this.statuses.get(orderId);
  }

  /** The next `times` calls throw a plain error (a transient fault). */
  failNext(times: number): void {
    this.failures = times;
  }

  reset(): void {
    this.statuses.clear();
    this.applied.length = 0;
    this.calls.length = 0;
    this.failures = 0;
  }

  apply(
    orderId: string,
    command: FulfilmentCommand,
  ): Promise<{ status: OrderStatus; orderVersion: number }> {
    this.calls.push({ orderId, command });
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new Error('order service unavailable'));
    }
    const status = this.statuses.get(orderId);
    if (!status) return Promise.reject(new OrderNotFoundError());
    if (status !== FROM[command.type])
      return Promise.reject(
        new InvalidOrderTransitionError(orderId, status, command.type),
      );
    this.statuses.set(orderId, TARGET[command.type]);
    this.applied.push({ orderId, command });
    return Promise.resolve({ status: TARGET[command.type], orderVersion: 1 });
  }
}

/**
 * The write-back side of the worker (order lifecycle service, adapter and job handlers) wired to a fake orders service,
 * for specs that boot `DeliveryModule` without the orders capability: pass it in `extraImports`.
 */
export function fakeOrdersModule(fake: FakeOrderFulfilment): Type<unknown> {
  @Module({
    imports: [DeliveryCoreModule],
    providers: [
      { provide: OrderFulfilmentService, useValue: fake },
      { provide: ORDER_LIFECYCLE_PORT, useClass: OrderLifecycleAdapter },
      OrderLifecycleService,
      DeliveryJobHandlers,
    ],
    exports: [OrderLifecycleService, DeliveryJobHandlers],
  })
  class FakeOrdersModule {}
  return FakeOrdersModule;
}
