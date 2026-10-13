import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { BackfillService } from '../application/backfill.service';
import { EventRelayService } from '../application/event-relay.service';
import { ReconcileService } from '../application/reconcile.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'discussions.flush-votes': Record<string, never>;
    'discussions.relay-events': Record<string, never>;
    'discussions.relay-sweep': Record<string, never>;
    'discussions.reconcile': Record<string, never>;
    'discussions.recount': { targetId: string };
    'discussions.backfill': {
      phase: 'boards' | 'threads';
      pageState: string | null;
    };
  }
}

for (const name of [
  'discussions.flush-votes',
  'discussions.relay-events',
  'discussions.relay-sweep',
  'discussions.reconcile',
] as const)
  declareJobType({ name, contract: z.object({}) });
declareJobType({
  name: 'discussions.recount',
  contract: z.object({ targetId: z.string() }),
});
declareJobType({
  name: 'discussions.backfill',
  contract: z.object({
    phase: z.enum(['boards', 'threads']),
    pageState: z.string().nullable(),
  }),
});

/** Hours of the relay queue a regular pass scans; the hourly sweep scans everything the queue keeps (48 h). */
const RELAY_HOURS = 3;
const SWEEP_HOURS = 48;

/**
 * Background work of discussions, registered only by `DiscussionsWorkerModule` (S25 G7, S49): the durable-aggregate
 * flush every 5 s, the event relay every 5 s and a full sweep hourly, the reconciliation every 5 minutes, exact
 * recounts of one target on demand, and the one-shot backfill of data written before S25. All are safe to repeat.
 */
@Injectable()
export class DiscussionsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(DiscussionsJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly reconcile: ReconcileService,
    private readonly relay: EventRelayService,
    private readonly backfill: BackfillService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const schedules = [
      ['discussions.flush-votes', '*/5 * * * * *'],
      ['discussions.relay-events', '*/5 * * * * *'],
      ['discussions.relay-sweep', '0 7 * * * *'],
      ['discussions.reconcile', '0 */5 * * * *'],
    ] as const;
    for (const [jobType, cron] of schedules)
      try {
        await this.jobs.upsertSchedule({
          name: jobType,
          cron,
          jobType,
          payload: {},
          overlap: 'skip',
        });
      } catch (error) {
        if (!(error instanceof InvalidScheduleError)) throw error;
        this.logger.error(
          `schedule ${jobType} not registered: ${error.message}`,
        );
      }
  }

  @JobHandler('discussions.flush-votes', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async flush(): Promise<void> {
    await this.reconcile.flushVotes();
  }

  @JobHandler('discussions.relay-events', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async relayEvents(): Promise<void> {
    await this.relay.relay(RELAY_HOURS);
  }

  @JobHandler('discussions.relay-sweep', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async relaySweep(): Promise<void> {
    await this.relay.relay(SWEEP_HOURS);
  }

  @JobHandler('discussions.reconcile', { concurrency: 1, fleetConcurrency: 1 })
  async reconciliation(): Promise<void> {
    const { targets, repaired } = await this.reconcile.reconcile();
    if (repaired > 0)
      this.logger.warn(
        `reconciliation repaired ${repaired} counters over ${targets} targets`,
      );
  }

  @JobHandler('discussions.recount', { concurrency: 4 })
  async recount({ targetId }: { targetId: string }): Promise<void> {
    await this.reconcile.recountTarget(targetId);
  }

  @JobHandler('discussions.backfill', { concurrency: 1, fleetConcurrency: 1 })
  async backfillStep(payload: {
    phase: 'boards' | 'threads';
    pageState: string | null;
  }): Promise<void> {
    const step = await this.backfill.step(payload.phase, payload.pageState);
    if (step.done) return;
    await this.jobs.enqueue('discussions.backfill', {
      phase: step.phase,
      pageState: step.next,
    });
  }
}
