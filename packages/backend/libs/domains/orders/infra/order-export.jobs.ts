import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  OrderExportMaintenanceService,
  type RecoveryResult,
} from '../application/order-export-maintenance.service';

import '../application/order-export.job-types';

/**
 * Recurring jobs of the order export (S12 FR-022, FR-026; S49): recovery every minute, expiry every 15 minutes, purge
 * once a day. Single-run with a lease, and safe on two instances anyway because every step is a conditional statement.
 * An invalid schedule is a programming error: the worker fails to start instead of running without recovery or
 * retention. `JobsService.cancel` is never called.
 */
@Injectable()
export class OrderExportJobs implements OnApplicationBootstrap {
  constructor(
    private readonly jobs: JobsService,
    private readonly maintenance: OrderExportMaintenanceService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const schedules = [
      { name: 'orders.recover-stalled-exports', cron: '0 * * * * *' },
      { name: 'orders.expire-exports', cron: '0 */15 * * * *' },
      { name: 'orders.purge-exports', cron: '0 40 3 * * *' },
    ] as const;
    try {
      for (const s of schedules)
        await this.jobs.upsertSchedule({
          name: s.name,
          cron: s.cron,
          jobType: s.name,
          payload: {},
        });
    } catch (error) {
      if (error instanceof InvalidScheduleError)
        throw new Error(`order export schedule is invalid: ${error.message}`, {
          cause: error,
        });
      throw error;
    }
  }

  /** Expired leases back to the queue (or failed at the last attempt), unclaimed queued exports sent again. */
  @JobHandler('orders.recover-stalled-exports', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  recover(): Promise<RecoveryResult> {
    return this.maintenance.recoverStalled();
  }

  /** Files older than the retention are deleted, then the export expires. */
  @JobHandler('orders.expire-exports', { concurrency: 1, fleetConcurrency: 1 })
  expire(): Promise<{ expired: number }> {
    return this.maintenance.expireExports();
  }

  /** Records older than the record retention go with their history. */
  @JobHandler('orders.purge-exports', { concurrency: 1, fleetConcurrency: 1 })
  purge(): Promise<{ purged: number }> {
    return this.maintenance.purgeExports();
  }
}
