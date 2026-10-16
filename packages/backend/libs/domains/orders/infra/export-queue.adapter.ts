import { Injectable } from '@nestjs/common';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import type { ExportQueuePort } from '../domain/export-ports';

/** The export queue: standard, not FIFO (L-001), so no `groupId` or `dedupeId` is ever passed. */
export const ORDER_EXPORTS_QUEUE = 'order-exports';

@Injectable()
export class ExportQueueAdapter implements ExportQueuePort {
  constructor(private readonly queue: TaskQueue) {}

  async enqueue(
    exportId: string,
    options: { delaySeconds?: number } = {},
  ): Promise<void> {
    await this.queue.enqueue(
      ORDER_EXPORTS_QUEUE,
      { exportId },
      options.delaySeconds === undefined
        ? undefined
        : { delaySeconds: options.delaySeconds },
    );
  }
}
