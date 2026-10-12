import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { JobsService, declareJobType } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { ProductBackfillService } from '../application/product-backfill.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'products.backfill-shop-ids': Record<string, never>;
  }
}

declareJobType({
  name: 'products.backfill-shop-ids',
  contract: z.object({}).strict(),
});

/** Shop-id backfill of legacy products (runs in apps/worker): enqueued once per deploy, continues itself in rounds. */
@Injectable()
export class ProductBackfillJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProductBackfillJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly backfill: ProductBackfillService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.enqueue(
        'products.backfill-shop-ids',
        {},
        { idempotencyKey: 'catalog-backfill' },
      );
    } catch (error) {
      this.logger.error(`backfill not enqueued: ${(error as Error).message}`);
    }
  }

  @JobHandler('products.backfill-shop-ids', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: 300_000,
  })
  async run(): Promise<{ sellers: number; products: number }> {
    const result = await this.backfill.runOnce();
    if (result.sellers > 0)
      await this.jobs.enqueue(
        'products.backfill-shop-ids',
        {},
        { idempotencyKey: `catalog-backfill:${randomUUID()}` },
      );
    return result;
  }
}
