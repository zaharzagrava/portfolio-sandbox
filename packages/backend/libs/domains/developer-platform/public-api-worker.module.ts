import {
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ProductModule, PRODUCTS_AGGREGATE } from '@app/domains/catalog';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { ApiKeysService } from './application/api-keys.service';
import {
  BULK_STOCK_QUEUE,
  PublicCatalogService,
} from './application/public-catalog.service';

import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'public-api.flush-key-usage': Record<string, never>;
  }
}

declareJobType({
  name: 'public-api.flush-key-usage',
  contract: z.object({}),
});

@Injectable()
export class PublicApiWorkers
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly catalog: PublicCatalogService,
    private readonly keys: ApiKeysService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    this.stop = this.queue.consume<{
      jobId: string;
      shopId: string;
      items: { productId: string; stock: number }[];
    }>(BULK_STOCK_QUEUE, ({ body }) => this.catalog.applyChunk(body), {
      concurrency: 5,
    });
    await this.jobs.upsertSchedule({
      name: 'public-api.flush-key-usage',
      cron: '* * * * *',
      jobType: 'public-api.flush-key-usage',
      payload: {},
    });
  }

  async onModuleDestroy() {
    await this.stop?.();
  }

  @JobHandler('public-api.flush-key-usage', { concurrency: 1 })
  flushKeyUsage() {
    return this.keys.flushLastUsed();
  }
}

/** SD-07 (apps/worker): async bulk stock chunks + API key lastUsedAt write-behind. */
@Module({
  imports: [
    ProductModule,
    EventsModule.forAggregates([PRODUCTS_AGGREGATE]),
    SqsModule,
    JobsModule,
  ],
  providers: [PublicApiWorkers, PublicCatalogService, ApiKeysService],
})
export class PublicApiWorkerModule {}
