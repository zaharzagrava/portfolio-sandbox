import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { WebhookDeliverer } from '../application/webhook-deliverer.service';
import { WEBHOOK_QUEUE } from '../domain/webhook-events';
import type { WebhookDelivery } from '../domain/webhook-events';

/**
 * apps/worker host for deliveries (the same `WebhookDeliverer` also runs as a
 * Lambda handler - apps/lambdas/src/handlers/webhook-delivery.ts - with the FIFO queue
 * as its event source). Per-endpoint concurrency = 1 comes from FIFO groups.
 */
@Injectable()
export class WebhookWorkers implements OnApplicationBootstrap, OnModuleDestroy {
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly deliverer: WebhookDeliverer,
  ) {}

  onApplicationBootstrap() {
    this.stop = this.queue.consume<WebhookDelivery>(
      WEBHOOK_QUEUE,
      async ({ body, receiveCount }) => {
        const outcome = await this.deliverer.deliver(body, receiveCount);
        if (outcome === 'retry-fifo') throw new Error(`delivery ${body.eventId} → ${body.endpointId} failed; redeliver`);
      },
      { concurrency: 50, visibilityTimeoutSec: 30 },
    );
  }

  async onModuleDestroy() {
    await this.stop?.();
  }

  @JobHandler('webhooks.retry', { concurrency: 50 })
  async retry(msg: WebhookDelivery) {
    await this.deliverer.requeue(msg, async (m, dedupe) => {
      await this.queue.enqueue(WEBHOOK_QUEUE, m, { groupId: m.endpointId, deduplicationId: createHash('sha256').update(dedupe).digest('hex').slice(0, 64) });
    });
  }
}
