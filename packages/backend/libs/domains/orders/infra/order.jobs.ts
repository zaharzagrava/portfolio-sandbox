import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import type { JobContext } from '@app/infrastructure/jobs/job-types';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { CART_STORE, type CartStore } from '../domain/ports';
import { cartCleanupFailedCounter } from '../domain/order-metrics';
import type { ProcessWebhookPayload } from '../application/order.job-types';
import { ReservationRecoveryService } from '../application/reservation-recovery.service';
import { ReservationReleaseService } from '../application/reservation-release.service';
import { WebhookProcessorService } from '../application/webhook-processor.service';

import '../application/order.job-types';

/**
 * Job handlers of `orders` (S10 D-5). Each is idempotent by conditional state: a second run, or a run on another
 * instance, finds nothing left to do. The periodic ones are scheduled by `OrdersWorkerModule`.
 */
@Injectable()
export class OrderJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrderJobs.name);

  constructor(
    private readonly recovery: ReservationRecoveryService,
    private readonly release: ReservationReleaseService,
    private readonly webhooks: WebhookProcessorService,
    private readonly jobs: JobsService,
    @Inject(CART_STORE) private readonly cart: CartStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const schedules = [
      { name: 'orders.sweep-expired-reservations', cron: '0 * * * * *' },
      { name: 'orders.recover-pending', cron: '*/30 * * * * *' },
      { name: 'orders.release-stock', cron: '*/30 * * * * *' },
    ] as const;
    for (const s of schedules) {
      try {
        await this.jobs.upsertSchedule({
          name: s.name,
          cron: s.cron,
          jobType: s.name,
          payload: {},
        });
      } catch (error) {
        if (!(error instanceof InvalidScheduleError)) throw error;
        this.logger.error(
          `schedule ${s.name} not registered: ${error.message}`,
        );
      }
    }
  }

  /** The hold of one order ended: cancel it unless it was paid or cancelled meanwhile. */
  @JobHandler('orders.expire-reservation', { concurrency: 50 })
  async expireReservation({ orderId }: { orderId: string }): Promise<void> {
    await this.recovery.expire(orderId);
  }

  /** Backstop for a lost expiry job: at most 200 expired holds per run, one run in the fleet at a time. */
  @JobHandler('orders.sweep-expired-reservations', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async sweepExpired(): Promise<void> {
    await this.recovery.sweepExpired();
  }

  /** `PENDING` orders older than the recovery age: repeat the stock step with the same operation ids. */
  @JobHandler('orders.recover-pending', { concurrency: 1, fleetConcurrency: 1 })
  async recoverPending(): Promise<void> {
    await this.recovery.recoverPending();
  }

  /** Gives back stock of cancelled orders whose immediate release failed. */
  @JobHandler('orders.release-stock', { concurrency: 1, fleetConcurrency: 1 })
  async releaseStock(): Promise<void> {
    await this.release.processDue(100);
  }

  /**
   * Applies a stored provider event (S10 US4). A thrown error means "try again later": the worker retries with
   * exponential backoff and jitter and dead-letters the job after its last attempt (the event is `FAILED` by then).
   */
  @JobHandler('orders.process-webhook', { concurrency: 20 })
  async processWebhook(
    payload: ProcessWebhookPayload,
    ctx: Pick<JobContext, 'attempt' | 'maxAttempts' | 'isLastAttempt'>,
  ): Promise<void> {
    await this.webhooks.process(payload, ctx);
  }

  /** Removes the lines a finished checkout consumed when the cart store refused the first clean-up. */
  @JobHandler('orders.clear-cart', { concurrency: 20 })
  async clearCart(payload: {
    cartId: string;
    consumed: Array<{ productId: string; quantity: number }>;
  }): Promise<void> {
    try {
      await this.cart.removeConsumed(
        payload.cartId,
        payload.consumed,
        this.clock.now(),
      );
    } catch (error) {
      cartCleanupFailedCounter.add();
      this.logger.warn(`cart clean-up failed again: ${(error as Error).name}`);
      throw error;
    }
  }
}
