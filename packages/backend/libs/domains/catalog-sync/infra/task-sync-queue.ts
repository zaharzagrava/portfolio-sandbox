import { Injectable } from '@nestjs/common';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  syncMessageSchema,
  type SyncMessage,
  type SyncQueue,
  type SyncQueueName,
} from '../domain/ports';

const MAX_DELAY_SECONDS = 900;

/**
 * Adapter over the task queue. The message is validated (strict) before anything is sent, and only `delaySeconds` is
 * passed on: the sync queues are standard queues, so a `groupId` or `dedupeId` would be refused (L-001).
 */
@Injectable()
export class TaskSyncQueue implements SyncQueue {
  constructor(private readonly queue: TaskQueue) {}

  async enqueue(
    queue: SyncQueueName,
    message: SyncMessage,
    options: { delaySeconds?: number } = {},
  ): Promise<void> {
    const body = syncMessageSchema.parse(message);
    const delay = options.delaySeconds;
    if (
      delay !== undefined &&
      (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_SECONDS)
    )
      throw new RangeError(
        `delaySeconds must be an integer in 0..${MAX_DELAY_SECONDS}`,
      );
    await this.queue.enqueue(
      queue,
      body,
      delay === undefined || delay === 0 ? undefined : { delaySeconds: delay },
    );
  }
}
