import { Injectable, Logger } from '@nestjs/common';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import type { PaymentRecord, RealtimePort } from '../domain/ports';
import { realtimeFailedCounter } from '../domain/payment-metrics';
import { withTimeout } from './with-timeout';

const PUSH_TIMEOUT_MS = 500;

/**
 * Pushes `payment.status` to the buyer's topic after the commit (S13 FR-049). Best effort: a failure or a slow hub is
 * logged and counted, never thrown. The data has no amount, no secret and no failure detail.
 */
@Injectable()
export class RealtimeAdapter implements RealtimePort {
  private readonly logger = new Logger(RealtimeAdapter.name);

  constructor(private readonly publisher: RealtimePublisher) {}

  async pushPaymentStatus(payment: PaymentRecord): Promise<void> {
    try {
      await withTimeout(
        this.publisher.publish(`user:${payment.userId}`, 'payment.status', {
          paymentId: payment.id,
          orderId: payment.orderId,
          status: payment.status,
          version: payment.version,
        }),
        PUSH_TIMEOUT_MS,
        () => new Error('realtime publish timed out'),
      );
    } catch (error) {
      realtimeFailedCounter.add();
      this.logger.warn(
        `realtime push failed for payment ${payment.id}: ${(error as Error).message}`,
      );
    }
  }
}
