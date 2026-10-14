import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiConfigService } from '@app/common/config';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { IngestService } from '../application/ingest.service';
import { INGEST_QUEUE } from './task-publisher.adapter';

/** Strict: any other body (missing field, wrong type, extra nesting) goes to the dead-letter queue at once. */
export const ingestBodySchema = z
  .object({ documentId: z.string().uuid() })
  .strict();

/**
 * The consumer of `knowledge-ingest` (apps/worker). The queue validates the body first (`bodySchema` → DLQ with reason
 * `SCHEMA_INVALID`, the handler is never called); the handler parses again, so a change to one cannot silently weaken
 * the other (S47 G20). The visibility timeout equals the processing lease, and the queue extends it while a pass runs.
 */
@Injectable()
export class KnowledgeIngestConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly ingest: IngestService,
    private readonly config: ApiConfigService,
  ) {}

  onApplicationBootstrap(): void {
    // Concurrency is the embedding provider's rate limit in disguise: N documents × batches of embeddings.
    this.stop = this.queue.consume<unknown>(
      INGEST_QUEUE,
      async ({ body, receiveCount }) => {
        const { documentId } = ingestBodySchema.parse(body);
        await this.ingest.ingest(documentId, receiveCount);
      },
      {
        concurrency: this.config.get('knowledge_ingest_concurrency'),
        visibilityTimeoutSec: Math.ceil(
          this.config.get('knowledge_processing_lease_ms') / 1000,
        ),
        bodySchema: ingestBodySchema,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop?.();
  }
}
