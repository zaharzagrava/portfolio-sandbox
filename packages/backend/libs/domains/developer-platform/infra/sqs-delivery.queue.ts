import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import '../application/webhook-jobs';
import { DeliveryMessage, DeliveryQueue } from '../domain/webhook-ports';
import { WEBHOOK_QUEUE } from '../domain/webhook-events';

/**
 * The ordered lane `webhook-deliveries.fifo` (S43 R-05, R-06). Group = endpoint id, which gives one delivery in flight
 * per endpoint and isolates a hanging endpoint from every other (FR-030). Deduplication id = a digest of endpoint, event,
 * attempt kind and number: the event id alone is shared by every endpoint of a shop, and FIFO deduplication is queue-wide.
 * The message carries no body and no secret. Group and deduplication options are given only here, only for this FIFO
 * queue (L-001); the queue port validates them before any network call.
 */
@Injectable()
export class SqsDeliveryQueue extends DeliveryQueue {
  constructor(
    private readonly queue: TaskQueue,
    private readonly jobs: JobsService,
  ) {
    super();
  }

  private options(message: DeliveryMessage) {
    return {
      groupId: message.endpointId,
      dedupeId: createHash('sha256')
        .update(
          [
            message.endpointId,
            message.eventId,
            message.kind,
            message.attempt,
            // A replay re-sends an event id that was queued before; each replay and ping is its own delivery.
            ...(message.kind === 'event' ? [] : [message.deliveryId]),
            ...(message.scheduledFor ? [message.scheduledFor] : []),
          ].join(':'),
        )
        .digest('hex'),
    };
  }

  async enqueue(message: DeliveryMessage): Promise<void> {
    await this.queue.enqueue(WEBHOOK_QUEUE, message, this.options(message));
  }

  async enqueueMany(messages: DeliveryMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const result = await this.queue.enqueueBatch(
      WEBHOOK_QUEUE,
      messages.map((body) => ({ body, options: this.options(body) })),
    );
    if (result.failed.length > 0)
      // The caller does not acknowledge its source event: redelivery completes the rest, deterministic ids prevent duplicates.
      throw new Error(
        `webhook queue rejected ${result.failed.length} of ${messages.length} messages`,
      );
  }

  async scheduleRetry(message: DeliveryMessage, runAt: Date): Promise<void> {
    // The key carries the instant: a delivery put off again with an unchanged attempt number (breaker open) is a new job.
    await this.jobs.enqueue(
      'webhooks.retry',
      { ...message, scheduledFor: runAt.toISOString() },
      {
        runAt,
        idempotencyKey: `wh-retry:${message.endpointId}:${message.eventId}:${message.attempt}:${runAt.getTime()}`,
      },
    );
  }
}
