import { Injectable } from '@nestjs/common';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import type { TaskPublisher } from '../domain/ports';

export const INGEST_QUEUE = 'knowledge-ingest';

/**
 * Publishes ingestion tasks to the standard queue `knowledge-ingest`. The body is `{documentId}` only and no FIFO-only
 * option (`groupId`, `dedupeId`) is ever passed: the queue is standard and duplicates are harmless because the claim is
 * conditional (L-001).
 */
@Injectable()
export class TaskPublisherAdapter implements TaskPublisher {
  constructor(private readonly queue: TaskQueue) {}

  async enqueueIngest(documentId: string): Promise<void> {
    await this.queue.enqueue(INGEST_QUEUE, { documentId });
  }
}
