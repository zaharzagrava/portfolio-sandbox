import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { ChatPartitionService } from '../application/chat-partition.service';
import { ChatShopBackfillService } from '../application/chat-shop-backfill.service';
import '../application/chat.job-types';

/**
 * Job handlers of chat (S24 contracts/events.md "Jobs"). Thin: one application call each; redelivery is harmless
 * (every step is conditional or idempotent).
 */
@Injectable()
export class ChatJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChatJobs.name);

  constructor(
    private readonly partitions: ChatPartitionService,
    private readonly backfill: ChatShopBackfillService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const schedules = [
      // daily at 03:27 UTC, off the hour and off the other nightly jobs
      { name: 'chat.partition-maintenance', cron: '0 27 3 * * *' },
      { name: 'chat.backfill-shops', cron: '0 */10 * * * *' },
    ] as const;
    for (const s of schedules) {
      try {
        await this.jobs.upsertSchedule({
          name: s.name,
          cron: s.cron,
          jobType: s.name,
          payload: {},
          overlap: 'skip',
        });
      } catch (error) {
        if (!(error instanceof InvalidScheduleError)) throw error;
        this.logger.error(
          `schedule ${s.name} not registered: ${error.message}`,
        );
      }
    }
  }

  /**
   * Every 10 minutes, and on demand: channels created before shops existed get their shop, 200 at a time; once none
   * is left the store makes the shop required, and the runs are no-ops.
   */
  @JobHandler('chat.backfill-shops', {
    leaseMs: 120_000,
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async backfillShops(): Promise<void> {
    const run = await this.backfill.run();
    this.logger.log({ event: 'chat.job', job: 'backfill-shops', ...run });
  }

  /** Daily: the current month and the next 3 exist; rows parked in the default partition are moved and reported. */
  @JobHandler('chat.partition-maintenance', {
    leaseMs: 60_000,
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async partitionMaintenance(): Promise<void> {
    const run = await this.partitions.ensure();
    this.logger.log({
      event: 'chat.job',
      job: 'partition-maintenance',
      created: run.created,
      moved: run.moved,
      defaultRows: run.defaultRows,
    });
  }
}
