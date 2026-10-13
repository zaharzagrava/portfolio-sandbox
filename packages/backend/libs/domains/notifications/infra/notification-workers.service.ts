import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { DeliveryWorkerService } from '../application/delivery-worker.service';
import { readNotificationsSettings } from '../application/notifications-settings';
import { concurrencyOf, DELIVERY_LINES } from './delivery-lines';

/**
 * How long a received message stays hidden. The consumer extends it while the handler runs, so a short value only
 * bounds how long a message waits when its worker disappears (or a receive is abandoned at shutdown).
 */
export const LINE_VISIBILITY_S = 5;

/**
 * One consumer per delivery line (the six queues of `delivery-lines.ts`), each with its own concurrency: transactional
 * 10, marketing 3 by default, so a campaign never starves "your order shipped". Scale signal: queue depth. What happens
 * to a message is `DeliveryWorkerService`'s; the wake-up of a message held for quiet hours is `WakeDeliveryService`'s
 * (job `notifications.wake-delivery`), which hands it back to its line.
 */
@Injectable()
export class NotificationWorkers
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly txConcurrency: number;
  private readonly marketingConcurrency: number;
  private stops: (() => Promise<void>)[] = [];

  constructor(
    private readonly queue: TaskQueue,
    private readonly delivery: DeliveryWorkerService,
    config: ApiConfigService,
  ) {
    const settings = readNotificationsSettings(config);
    this.txConcurrency = settings.txConcurrency;
    this.marketingConcurrency = settings.marketingConcurrency;
  }

  onApplicationBootstrap() {
    this.stops = DELIVERY_LINES.map((spec) =>
      this.queue.consume<unknown>(
        spec.queue,
        (msg) => this.delivery.process(spec.queue, msg),
        {
          concurrency: concurrencyOf(spec, {
            txConcurrency: this.txConcurrency,
            marketingConcurrency: this.marketingConcurrency,
          }),
          visibilityTimeoutSec: LINE_VISIBILITY_S,
        },
      ),
    );
  }

  async onModuleDestroy() {
    await Promise.all(this.stops.map((stop) => stop()));
  }
}
