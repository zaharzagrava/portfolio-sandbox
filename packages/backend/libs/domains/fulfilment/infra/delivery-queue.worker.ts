import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  offerTimeoutMessageSchema,
  type OfferTimeoutMessage,
} from '@marketplace-sandbox/contracts';
import { RequestContext } from '@app/infrastructure/context';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { errorText, logDelivery } from '../application/delivery-log';
import { DeliveryOwnership } from '../application/delivery-ownership.service';
import { DispatchService } from '../application/dispatch.service';
import { DISPATCH_TIMERS, type DispatchTimers } from '../domain/delivery-ports';
import {
  HAND_BACK_DELAY_SECONDS,
  MAX_HAND_BACKS,
} from '../domain/dispatch-rules';
import { cityLabel, DeliveryMetrics } from '../application/delivery-metrics';
import { OFFER_TIMEOUT_QUEUE } from './dispatch-timers';

/**
 * Consumer of `delivery-offer-timeouts` (apps/worker; S20 FR-018, FR-043, A9, A25): offer expiry and "retry dispatch"
 * messages. A body that does not match the contract goes to the queue's dead-letter queue before this runs; a stale or
 * duplicate message is a no-op inside `DispatchService.onTimer`. A message for a city another instance owns is handed
 * back (re-enqueued with `handBacks + 1` and a 1 s delay) up to three times and handled here after that, so ownership
 * is an optimisation and a lost owner never strands a timer. A failure is counted for its city and left to the queue's
 * redelivery (visibility timeout, max receive count 5) and, past that, to the recovery job, which works from the stored
 * due time.
 */
@Injectable()
export class DeliveryQueueWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DeliveryQueueWorker.name);
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly dispatch: DispatchService,
    private readonly ownership: DeliveryOwnership,
    @Inject(DISPATCH_TIMERS) private readonly timers: DispatchTimers,
    private readonly context: RequestContext,
  ) {}

  onApplicationBootstrap(): void {
    this.stop = this.queue.consume<OfferTimeoutMessage>(
      OFFER_TIMEOUT_QUEUE,
      ({ body }) => this.handle(body),
      { concurrency: 50, bodySchema: offerTimeoutMessageSchema },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop?.();
  }

  /**
   * The handler of one message; public so specs can call it. Each message runs in its own request context, so its log
   * lines carry a request id like the lines of an HTTP request do.
   */
  handle(body: unknown): Promise<void> {
    if (this.context.isActive()) return this.process(body);
    const { deliveryId, attempt } = (body ??
      {}) as Partial<OfferTimeoutMessage>;
    return this.context.run(
      {
        requestId: `timer:${deliveryId ?? 'unknown'}:${attempt ?? 0}`,
        principalType: 'service',
      },
      () => this.process(body),
    );
  }

  private async process(body: unknown): Promise<void> {
    const parsed = offerTimeoutMessageSchema.safeParse(body);
    if (!parsed.success) {
      logDelivery(this.logger, 'warn', 'delivery.timer_dropped', {
        error: 'not a valid body',
      });
      return;
    }
    const message = parsed.data;
    const handBacks = message.handBacks ?? 0;
    if (
      handBacks < MAX_HAND_BACKS &&
      !(await this.ownership.owns(message.city))
    ) {
      if (await this.handBack(message, handBacks)) return;
    }
    try {
      await this.dispatch.onTimer(message);
    } catch (error) {
      DeliveryMetrics.dispatchFailures.add(1, {
        city: cityLabel(message.city),
      });
      logDelivery(this.logger, 'error', 'delivery.timer_failed', {
        deliveryId: message.deliveryId,
        ...(message.courierId && { courierId: message.courierId }),
        city: message.city,
        attempt: message.attempt,
        error: errorText(error),
      });
      throw error;
    }
  }

  /** True when the message went back to the queue; false means "handle it here" (the hand-back itself failed). */
  private async handBack(
    message: OfferTimeoutMessage,
    handBacks: number,
  ): Promise<boolean> {
    try {
      await this.timers.enqueue(
        { ...message, handBacks: handBacks + 1 },
        HAND_BACK_DELAY_SECONDS,
      );
    } catch (error) {
      logDelivery(this.logger, 'warn', 'delivery.hand_back_failed', {
        deliveryId: message.deliveryId,
        city: message.city,
        error: errorText(error),
      });
      return false;
    }
    DeliveryMetrics.handBacks.add(1, { city: cityLabel(message.city) });
    return true;
  }
}
