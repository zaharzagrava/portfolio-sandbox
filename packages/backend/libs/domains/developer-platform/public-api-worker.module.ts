import {
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { z } from 'zod';
import { bulkChunkMessageSchema } from '@marketplace-sandbox/contracts';
import { ProductModule } from '@app/domains/catalog';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { BulkChunkWorker } from './application/bulk-chunk.worker';
import { BulkPurger } from './application/bulk.purger';
import { BulkStockService } from './application/bulk-stock.service';
import { KeyUsageFlusher } from './application/key-usage.flusher';
import { UsageCloser } from './application/usage.closer';
import { PublicCatalogService } from './application/public-catalog.service';
import { DeveloperPlatformCoreModule } from './developer-platform-core.module';
import { BULK_CHUNK_QUEUE } from './infra/sequelize-bulk-job.repository';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'public-api.flush-key-usage': Record<string, never>;
    'public-api.purge-bulk-jobs': Record<string, never>;
    'public-api.close-usage-minutes': Record<string, never>;
  }
}

declareJobType({
  name: 'public-api.flush-key-usage',
  contract: z.object({}).strict(),
});
declareJobType({
  name: 'public-api.close-usage-minutes',
  contract: z.object({}).strict(),
});
declareJobType({
  name: 'public-api.purge-bulk-jobs',
  contract: z.object({}).strict(),
});

/**
 * The background side of the public API (apps/worker): the consumer of the bulk-stock chunk queue and the scheduled
 * jobs (`lastUsedAt` write-behind every minute, bulk job purge daily).
 */
@Injectable()
export class PublicApiWorkers
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly chunks: BulkChunkWorker,
    private readonly flusher: KeyUsageFlusher,
    private readonly purger: BulkPurger,
    private readonly usage: UsageCloser,
    private readonly jobs: JobsService,
    @Optional() readiness?: ReadinessService,
  ) {
    // a consumed queue that is not defined means chunks wait forever: the pod is not ready until it exists (L-002)
    readiness?.register({
      name: `queue:${BULK_CHUNK_QUEUE}`,
      scope: 'pod',
      timeoutMs: 2_000,
      check: async () => {
        for (const name of [BULK_CHUNK_QUEUE, `${BULK_CHUNK_QUEUE}-dlq`])
          if (!(await this.queue.queueExists(name)))
            throw new Error(`queue ${name} is not defined`);
      },
    });
  }

  async onApplicationBootstrap() {
    this.stop = this.queue.consume(
      BULK_CHUNK_QUEUE,
      async ({ body }) => {
        await this.chunks.handle(body as never);
      },
      { concurrency: 5, bodySchema: bulkChunkMessageSchema },
    );
    await this.jobs.upsertSchedule({
      name: 'public-api.flush-key-usage',
      cron: '* * * * *',
      jobType: 'public-api.flush-key-usage',
      payload: {},
    });
    await this.jobs.upsertSchedule({
      name: 'public-api.close-usage-minutes',
      cron: '* * * * *',
      jobType: 'public-api.close-usage-minutes',
      payload: {},
    });
    await this.jobs.upsertSchedule({
      name: 'public-api.purge-bulk-jobs',
      cron: '17 3 * * *',
      jobType: 'public-api.purge-bulk-jobs',
      payload: {},
    });
  }

  async onModuleDestroy() {
    await this.stop?.();
  }

  @JobHandler('public-api.flush-key-usage', { concurrency: 1 })
  flushKeyUsage() {
    return this.flusher.flush();
  }

  @JobHandler('public-api.close-usage-minutes', { concurrency: 1 })
  closeUsageMinutes() {
    return this.usage.close();
  }

  @JobHandler('public-api.purge-bulk-jobs', { concurrency: 1 })
  purgeBulkJobs() {
    return this.purger.purge();
  }
}

/** apps/worker: bulk stock chunks, `lastUsedAt` write-behind, bulk job purge. */
@Module({
  imports: [DeveloperPlatformCoreModule, ProductModule, SqsModule, JobsModule],
  providers: [
    PublicApiWorkers,
    PublicCatalogService,
    BulkStockService,
    BulkChunkWorker,
    BulkPurger,
  ],
  exports: [BulkChunkWorker, BulkPurger],
})
export class PublicApiWorkerModule {}
