import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import {
  InvalidScheduleError,
  JobsService,
  declareJobType,
} from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { ProductViewsService } from '../application/product-views.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'products.flush-view-counts': Record<string, never>;
  }
}

declareJobType({
  name: 'products.flush-view-counts',
  contract: z.object({}).strict(),
});

/**
 * Applies the write-behind view counter (SD-34, README #22) every 10 s, in chunks of at most 1,000 products, one run
 * in the whole fleet. Runs in apps/worker.
 */
@Injectable()
export class ProductViewsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProductViewsJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly views: ProductViewsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'products.flush-view-counts',
        cron: '*/10 * * * * *',
        jobType: 'products.flush-view-counts',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule not registered: ${error.message}`);
    }
  }

  @JobHandler('products.flush-view-counts', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: 30_000,
  })
  async flush(): Promise<void> {
    await this.views.flush();
  }
}
