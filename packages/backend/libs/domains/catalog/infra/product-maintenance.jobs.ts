import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  InvalidScheduleError,
  JobsService,
  declareJobType,
} from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import {
  STOCK_OPERATION_REPOSITORY,
  VIEW_BATCH_REPOSITORY,
  type StockOperationRepository,
  type ViewBatchRepository,
} from '../domain/ports';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'products.purge-stock-operations': Record<string, never>;
  }
}

declareJobType({
  name: 'products.purge-stock-operations',
  contract: z.object({}).strict(),
});

const DAY_MS = 86_400_000;
/** Stock operation ids are remembered for 30 days: longer than any caller's retry window. */
export const STOCK_OPERATION_RETENTION_MS = 30 * DAY_MS;
/** Applied-chunk markers of the view flush are only needed while a batch can still be replayed. */
export const VIEW_BATCH_RETENTION_MS = 7 * DAY_MS;
export const PURGE_BATCH = 5_000;

/**
 * Daily housekeeping of the catalog's bookkeeping tables (runs in apps/worker). One run in the whole fleet; at most
 * 5,000 stock-operation records per run, oldest first, so a backlog is worked off over several runs and no statement
 * is unbounded.
 */
@Injectable()
export class ProductMaintenanceJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProductMaintenanceJobs.name);

  constructor(
    private readonly jobs: JobsService,
    @Inject(STOCK_OPERATION_REPOSITORY)
    private readonly operations: StockOperationRepository,
    @Inject(VIEW_BATCH_REPOSITORY)
    private readonly viewBatches: ViewBatchRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'products.purge-stock-operations',
        cron: '0 0 3 * * *',
        jobType: 'products.purge-stock-operations',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule not registered: ${error.message}`);
    }
  }

  @JobHandler('products.purge-stock-operations', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async purgeStockOperations(): Promise<{
    operations: number;
    viewBatches: number;
  }> {
    const now = this.clock.now().getTime();
    const operations = await this.operations.purgeOlderThan(
      new Date(now - STOCK_OPERATION_RETENTION_MS),
      PURGE_BATCH,
    );
    const viewBatches = await this.viewBatches.purgeOlderThan(
      new Date(now - VIEW_BATCH_RETENTION_MS),
    );
    this.logger.log({ action: 'products.purged', operations, viewBatches });
    return { operations, viewBatches };
  }
}
