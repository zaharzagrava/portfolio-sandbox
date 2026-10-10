import { Injectable, Logger } from '@nestjs/common';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import type { RealtimePort } from '../domain/ports';
import type { OrderStatus } from '../domain/order-state';
import { realtimeFailedCounter } from '../domain/order-metrics';

/** Pushes the new status to the buyer's topic after the commit. Best effort: a failure is logged and counted, never thrown. */
@Injectable()
export class RealtimeAdapter implements RealtimePort {
  private readonly logger = new Logger(RealtimeAdapter.name);

  constructor(private readonly publisher: RealtimePublisher) {}

  async pushOrderStatus(
    userId: string,
    orderId: string,
    status: OrderStatus,
  ): Promise<void> {
    try {
      await this.publisher.publish(`user:${userId}`, 'order.status', {
        orderId,
        status,
      });
    } catch (error) {
      realtimeFailedCounter.add();
      this.logger.warn(
        `realtime push failed for order ${orderId}: ${(error as Error).name}`,
      );
    }
  }
}
