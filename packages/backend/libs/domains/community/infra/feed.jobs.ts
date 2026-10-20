import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { AnnouncementRelayService } from '../application/announcement-relay.service';
import {
  FeedReconcileService,
  type ReconcilePhase,
} from '../application/feed-reconcile.service';

/** Where a reconciliation run stopped; `phase: null` starts from the beginning. */
export interface FeedReconcilePayload {
  phase: ReconcilePhase | null;
  after: string | null;
}

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'feed.relay-announcements': Record<string, never>;
    'feed.relay-sweep': Record<string, never>;
    'feed.reconcile': FeedReconcilePayload;
  }
}

declareJobType({
  name: 'feed.relay-announcements',
  contract: z.object({}),
});
declareJobType({ name: 'feed.relay-sweep', contract: z.object({}) });
declareJobType({
  name: 'feed.reconcile',
  contract: z.object({
    phase: z.enum(['users', 'indexed', 'accounts', 'counters']).nullable(),
    after: z.string().nullable(),
  }),
});

/** Hours of the relay queue a regular pass scans; the hourly sweep scans everything the queue keeps (48 h). */
const RELAY_HOURS = 3;
const SWEEP_HOURS = 48;
/** Pages of a reconciliation run before it re-enqueues itself with the cursor (keeps one job short). */
const RECONCILE_PAGES = 20;

/**
 * Background work of the feed, registered only by `FeedWorkerModule` (S26 E5, S49): the announcement relay every 2 s and
 * a full sweep hourly, and the daily reconciliation of the follow graph (paged: a run hands the next page's cursor to a
 * follow-up job). All are safe to repeat.
 */
@Injectable()
export class FeedJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(FeedJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly relay: AnnouncementRelayService,
    private readonly reconcile: FeedReconcileService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const schedules = [
      ['feed.relay-announcements', '*/2 * * * * *', {}],
      ['feed.relay-sweep', '0 11 * * * *', {}],
      ['feed.reconcile', '0 30 3 * * *', { phase: null, after: null }],
    ] as const;
    for (const [jobType, cron, payload] of schedules)
      try {
        await this.jobs.upsertSchedule({
          name: jobType,
          cron,
          jobType,
          payload: payload as never,
          overlap: 'skip',
        });
      } catch (error) {
        if (!(error instanceof InvalidScheduleError)) throw error;
        this.logger.error(
          `schedule ${jobType} not registered: ${error.message}`,
        );
      }
  }

  @JobHandler('feed.relay-announcements', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async relayAnnouncements(): Promise<void> {
    await this.relay.relay(RELAY_HOURS);
  }

  @JobHandler('feed.relay-sweep', { concurrency: 1, fleetConcurrency: 1 })
  async relaySweep(): Promise<void> {
    await this.relay.relay(SWEEP_HOURS);
  }

  @JobHandler('feed.reconcile', { concurrency: 1, fleetConcurrency: 1 })
  async reconciliation(payload: FeedReconcilePayload): Promise<void> {
    const result = await this.reconcile.run({
      maxPages: RECONCILE_PAGES,
      resume: payload.phase
        ? { phase: payload.phase, after: payload.after }
        : null,
    });
    if (result.repaired > 0)
      this.logger.warn(
        `reconciliation repaired ${result.repaired} records over ${result.users} buyers and ${result.accounts} accounts`,
      );
    if (!result.finished && result.cursor)
      await this.jobs.enqueue('feed.reconcile', {
        phase: result.cursor.phase,
        after: result.cursor.after,
      });
  }
}
