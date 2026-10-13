import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { expiredCounter } from '../domain/metrics';
import { scrub } from '../domain/scrub';
import {
  DELIVERY_LINE_PRODUCER,
  DELIVERY_TIMELINE_STORE,
  HELD_DELIVERY_STORE,
  type DeliveryLineProducer,
  type DeliveryTimelineStore,
  type HeldDeliveryStore,
} from '../domain/ports';
import './notification-delivery.job-types';

/**
 * The handler of job `notifications.wake-delivery` (S49): a delivery held for quiet hours beyond the queue delay comes
 * back at its wake instant. The maximum age is re-checked first (a stale notice is `expired`, the inbox item stays,
 * FR-006); otherwise the message joins its line, where the worker checks suppression and the user's current preference
 * at send time (FR-024). The handler is idempotent: a held record is removed only after the hand-off, and a repeated
 * hand-off is harmless because the worker claims each delivery id before it sends.
 */
@Injectable()
export class WakeDeliveryService {
  private readonly logger = new Logger(WakeDeliveryService.name);

  constructor(
    @Inject(HELD_DELIVERY_STORE) private readonly held: HeldDeliveryStore,
    @Inject(DELIVERY_LINE_PRODUCER)
    private readonly lines: DeliveryLineProducer,
    @Inject(DELIVERY_TIMELINE_STORE)
    private readonly timeline: DeliveryTimelineStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @JobHandler('notifications.wake-delivery', { concurrency: 20 })
  async wake({ deliveryId }: { deliveryId: string }): Promise<void> {
    const delivery = await this.held.get(deliveryId);
    if (!delivery) {
      // Already handed over by an earlier run of this job, or its record expired: nothing is left to do.
      this.logger.warn(
        `notifications.wake.nothing_held deliveryId=${deliveryId}`,
      );
      return;
    }
    const now = this.clock.now();
    if (now >= delivery.staleAt) {
      expiredCounter.add(1, { type: delivery.message.type });
      await this.recorded(deliveryId, () =>
        this.timeline.advance(deliveryId, { status: 'expired', at: now }),
      );
    } else {
      await this.lines.enqueue(
        delivery.line,
        delivery.message.channel,
        delivery.message,
        { dedupeId: deliveryId },
      );
    }
    await this.held.delete(deliveryId);
  }

  /** A timeline write never fails or repeats a send (FR-012). */
  private async recorded(
    deliveryId: string,
    write: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.warn(
        `delivery timeline write failed for ${deliveryId}: ${scrub((error as Error).message)}`,
      );
    }
  }
}
