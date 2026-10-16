import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { HoldLifecycleService } from '../../application/hold-lifecycle.service';
import { LaunchEventService } from '../../application/launch-event.service';
import { ReconcileService } from '../../application/reconcile.service';
import {
  CLOSE_EVENT_JOB,
  EXPIRE_HOLD_JOB,
  OPEN_SALES_JOB,
  RECONCILE_SEATS_JOB,
} from '../../domain/constants';
import '../../application/launch-event.job-types';

/**
 * The four jobs of S22 (FR-024, FR-043, FR-036, FR-048). All are idempotent and safe to deliver late, twice or at once:
 * each does one conditional step and a repeat finds nothing to do. A payload that fails its contract is rejected by the
 * job runner before a handler runs.
 */
@Injectable()
export class LaunchEventJobs {
  constructor(
    private readonly holds: HoldLifecycleService,
    private readonly events: LaunchEventService,
    private readonly reconciler: ReconcileService,
  ) {}

  @JobHandler(EXPIRE_HOLD_JOB, { concurrency: 100 })
  async expireHold({ holdId }: { holdId: string }): Promise<void> {
    await this.holds.expire(holdId);
  }

  @JobHandler(OPEN_SALES_JOB, { concurrency: 10 })
  async openSales({ eventId }: { eventId: string }): Promise<void> {
    await this.events.openSales(eventId);
  }

  @JobHandler(CLOSE_EVENT_JOB, { concurrency: 10 })
  async closeEvent({
    eventId,
    reason,
  }: {
    eventId: string;
    reason: 'organizer' | 'started';
  }): Promise<void> {
    await this.events.runClose(eventId, reason);
  }

  @JobHandler(RECONCILE_SEATS_JOB, { concurrency: 1 })
  async reconcile(): Promise<void> {
    await this.reconciler.run();
  }
}

/** Upserts the every-minute reconcile (S49 keeps one run per schedule across replicas, `overlap: skip`). */
@Injectable()
export class LaunchEventSchedule implements OnApplicationBootstrap {
  constructor(private readonly jobs: JobsService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.jobs.upsertSchedule({
      name: RECONCILE_SEATS_JOB,
      cron: '* * * * *',
      jobType: RECONCILE_SEATS_JOB,
      payload: {},
      overlap: 'skip',
    });
  }
}
