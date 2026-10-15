import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import {
  InvalidScheduleError,
  JobsService,
  declareJobType,
} from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { SyncLifecycleService } from '../application/sync-lifecycle.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'catalog-sync.redrive-stale-ops': Record<string, never>;
    'catalog-sync.compact-change-log': Record<string, never>;
    'catalog-sync.purge-sync-operations': Record<string, never>;
    'catalog-sync.backfill-change-log': { shopId: string };
  }
}

for (const name of [
  'catalog-sync.redrive-stale-ops',
  'catalog-sync.compact-change-log',
  'catalog-sync.purge-sync-operations',
] as const)
  declareJobType({ name, contract: z.object({}).strict() });
declareJobType({
  name: 'catalog-sync.backfill-change-log',
  contract: z.object({ shopId: z.string().uuid() }).strict(),
});

/**
 * Recurring jobs of offline sync (run in the worker app; single-run, idempotent, safe on two instances because every
 * step is a conditional statement). `JobsService.cancel` is never called. An invalid schedule is a programming error:
 * the worker fails to start instead of running without recovery, compaction or retention.
 */
@Injectable()
export class OfflineSyncJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(OfflineSyncJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly lifecycle: SyncLifecycleService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'catalog-sync.redrive-stale-ops',
        cron: '0 * * * * *',
        jobType: 'catalog-sync.redrive-stale-ops',
        payload: {},
      });
      await this.jobs.upsertSchedule({
        name: 'catalog-sync.compact-change-log',
        cron: '0 30 3 * * *',
        jobType: 'catalog-sync.compact-change-log',
        payload: {},
      });
      await this.jobs.upsertSchedule({
        name: 'catalog-sync.purge-sync-operations',
        cron: '0 50 3 * * *',
        jobType: 'catalog-sync.purge-sync-operations',
        payload: {},
      });
    } catch (error) {
      if (error instanceof InvalidScheduleError)
        throw new Error(
          `catalog-sync offline sync schedule is invalid: ${error.message}`,
          { cause: error },
        );
      throw error;
    }
  }

  /** Completes claims left unfinished for more than five minutes (FR-005, AS-14). */
  @JobHandler('catalog-sync.redrive-stale-ops', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async redriveStale(): Promise<{ completed: number }> {
    const result = await this.lifecycle.redriveStale();
    if (result.completed > 0)
      this.logger.log({ action: 'catalog-sync.offline_redrive', ...result });
    return result;
  }

  /** Superseded feed entries and old tombstones, shop by shop (FR-028, AS-55). */
  @JobHandler('catalog-sync.compact-change-log', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async compact(): Promise<{ shops: number; removed: number }> {
    const result = await this.lifecycle.compactFeeds();
    this.logger.log({ action: 'catalog-sync.offline_compact', ...result });
    return result;
  }

  /** Operation records past retention, open conflicts excepted (FR-037, AS-50). */
  @JobHandler('catalog-sync.purge-sync-operations', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async purge(): Promise<{ removed: number }> {
    const result = await this.lifecycle.purgeOperations();
    this.logger.log({ action: 'catalog-sync.offline_purge', ...result });
    return result;
  }

  /** Rebuilds one shop's feed with a new generation (R-07); enqueued on demand, never scheduled. */
  @JobHandler('catalog-sync.backfill-change-log', { concurrency: 2 })
  async backfill(payload: { shopId: string }): Promise<void> {
    await this.lifecycle.rebuildFeed(payload.shopId);
  }
}
