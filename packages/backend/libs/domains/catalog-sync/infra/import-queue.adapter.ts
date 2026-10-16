import { Injectable } from '@nestjs/common';
import { importMessageSchema } from '@marketplace-sandbox/contracts';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import type { ImportQueuePort } from '../domain/ports';

/** The import queue: standard, not FIFO (L-001), so no `groupId` or `dedupeId` is ever passed. */
export const CATALOG_IMPORTS_QUEUE = 'catalog-imports';

/**
 * The queue carries `{ importId }` and nothing else (no `kind`): validated here, where the message is created, so a
 * wrong shape never reaches the relay (L-001). `delaySeconds` is the only option.
 */
@Injectable()
export class ImportQueueAdapter implements ImportQueuePort {
  constructor(private readonly queue: TaskQueue) {}

  async enqueue(
    importId: string,
    options: { delaySeconds?: number } = {},
  ): Promise<void> {
    const body = importMessageSchema.parse({ importId });
    await this.queue.enqueue(
      CATALOG_IMPORTS_QUEUE,
      body,
      options.delaySeconds === undefined
        ? undefined
        : { delaySeconds: options.delaySeconds },
    );
  }
}
