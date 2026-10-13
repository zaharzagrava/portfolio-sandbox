import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { CallbackWorkerService } from '../application/callback-worker.service';
import {
  CALLBACK_ATTEMPT_ATTRIBUTE,
  type CallbackMessage,
} from '../domain/callbacks';
import type { CallbackQueue } from '../domain/ports';
import { CALLBACK_QUEUE_NAME } from './notifications.topics';

/**
 * `CALLBACK_QUEUE` over the task queue: an accepted provider callback is a durable message on
 * `notifications-callbacks` (standard queue; the worker deduplicates on the provider event id).
 */
@Injectable()
export class SqsCallbackQueue implements CallbackQueue {
  constructor(private readonly queue: TaskQueue) {}

  async accept(
    callback: CallbackMessage,
    options: { delaySeconds?: number; attempt?: number } = {},
  ): Promise<void> {
    await this.queue.enqueue(CALLBACK_QUEUE_NAME, callback, {
      ...(options.delaySeconds !== undefined && {
        delaySeconds: options.delaySeconds,
      }),
      ...(options.attempt !== undefined && {
        attributes: { [CALLBACK_ATTEMPT_ATTRIBUTE]: String(options.attempt) },
      }),
    });
  }
}

/** The consumer of `notifications-callbacks`: applies each accepted callback (worker app). */
@Injectable()
export class CallbackWorkers
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private stop: (() => Promise<void>) | null = null;

  constructor(
    private readonly queue: TaskQueue,
    private readonly worker: CallbackWorkerService,
  ) {}

  onApplicationBootstrap(): void {
    this.stop = this.queue.consume<unknown>(
      CALLBACK_QUEUE_NAME,
      (message) =>
        this.worker.process({
          id: message.id,
          body: message.body,
          attributes: message.attributes,
        }),
      { concurrency: 5, visibilityTimeoutSec: 5 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop?.();
  }
}
