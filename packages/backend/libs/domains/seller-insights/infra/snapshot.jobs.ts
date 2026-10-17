import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import {
  SnapshotService,
  type SnapshotResult,
} from '../application/snapshot.service';
import type { PeriodKind } from '../domain/periods';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'leaderboards.snapshot': { kind?: PeriodKind; periodId?: string };
  }
}

declareJobType({
  name: 'leaderboards.snapshot',
  contract: z.object({
    kind: z.enum(['week', 'month']).optional(),
    periodId: z.string().optional(),
  }),
});

export const SNAPSHOT_WEEKLY = 'seller-insights.snapshot.weekly';
export const SNAPSHOT_MONTHLY = 'seller-insights.snapshot.monthly';
/** Schedules of the first version of this job; removed at boot so they stop firing next to the new ones. */
const SUPERSEDED = [
  'leaderboards.snapshot-week',
  'leaderboards.snapshot-month',
];

/**
 * Registers the two period-freeze schedules (Monday 01:00 UTC, day 1 01:00 UTC; idempotent at every boot, run once per
 * schedule across replicas by S49) and runs them: a run freezes every closed, unfrozen period of its kind that still
 * has boards, oldest first (S40 FR-022..FR-027).
 */
@Injectable()
export class SnapshotJobs implements OnApplicationBootstrap {
  constructor(
    private readonly jobs: JobsService,
    private readonly snapshots: SnapshotService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const name of SUPERSEDED) await this.jobs.removeSchedule(name);
    await this.jobs.upsertSchedule({
      name: SNAPSHOT_WEEKLY,
      cron: '0 1 * * 1',
      jobType: 'leaderboards.snapshot',
      payload: { kind: 'week' },
    });
    await this.jobs.upsertSchedule({
      name: SNAPSHOT_MONTHLY,
      cron: '0 1 1 * *',
      jobType: 'leaderboards.snapshot',
      payload: { kind: 'month' },
    });
  }

  @JobHandler('leaderboards.snapshot', { concurrency: 1 })
  async snapshot(payload: {
    kind?: PeriodKind;
    periodId?: string;
  }): Promise<SnapshotResult[]> {
    if (payload.periodId)
      return [await this.snapshots.freeze(payload.periodId)];
    return this.snapshots.freezeDue(payload.kind ?? 'week');
  }
}
