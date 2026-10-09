import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { WriteBehindCounter } from '@app/infrastructure/cache/write-behind-counter';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { PRODUCT_VIEWS_COUNTER } from './product-cache';

import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'products.flush-view-counts': Record<string, never>;
  }
}

declareJobType({
  name: 'products.flush-view-counts',
  contract: z.object({}),
});

/**
 * Drains the write-behind view counter (SD-34, README #22) every 10 s into
 * Postgres with ONE statement per flush (`UPDATE ... FROM unnest(...)`),
 * however many products were viewed. Runs in apps/worker.
 */
@Injectable()
export class ProductViewsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProductViewsJobs.name);
  private readonly counter: WriteBehindCounter;

  constructor(
    redis: RedisService,
    private readonly jobs: JobsService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {
    this.counter = new WriteBehindCounter(redis, PRODUCT_VIEWS_COUNTER);
  }

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'products.flush-view-counts',
      cron: '*/10 * * * * *',
      jobType: 'products.flush-view-counts',
      payload: {},
    });
  }

  @JobHandler('products.flush-view-counts', { concurrency: 1, leaseMs: 30_000 })
  async flush(): Promise<void> {
    const deltas = await this.counter.drain();
    if (deltas.size === 0) return;

    try {
      await this.sequelize.query(
        `UPDATE "Product" p SET "viewCount" = p."viewCount" + d.delta
         FROM unnest(CAST(:ids AS uuid[]), CAST(:deltas AS bigint[])) AS d(id, delta)
         WHERE p.id = d.id`,
        {
          replacements: {
            ids: `{${[...deltas.keys()].join(',')}}`,
            deltas: `{${[...deltas.values()].join(',')}}`,
          },
        },
      );
    } catch (error) {
      await this.counter.restore(deltas);
      this.logger.error(
        `view flush failed, ${deltas.size} deltas restored: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}
