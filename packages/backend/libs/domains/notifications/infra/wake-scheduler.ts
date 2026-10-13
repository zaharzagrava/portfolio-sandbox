import { Injectable } from '@nestjs/common';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import type { WakeScheduler } from '../domain/ports';
import '../application/notification-delivery.job-types';

/**
 * `WAKE_SCHEDULER` over S49: one job `notifications.wake-delivery` per delayed delivery, keyed by the delivery id, so a
 * replayed event schedules nothing twice.
 */
@Injectable()
export class JobsWakeScheduler implements WakeScheduler {
  constructor(private readonly jobs: JobsService) {}

  async schedule(deliveryId: string, runAt: Date): Promise<void> {
    await this.jobs.enqueue(
      'notifications.wake-delivery',
      { deliveryId },
      { runAt, idempotencyKey: deliveryId },
    );
  }

  async cancel(deliveryId: string): Promise<void> {
    await this.jobs.cancelByKey(deliveryId);
  }
}
