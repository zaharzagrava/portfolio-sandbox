import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { MfaMaintenanceService } from '../../application/mfa-maintenance.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'identity.reseal-mfa-secrets': { batchSize?: number };
    'identity.purge-mfa-challenges': { batchSize?: number };
    'identity.purge-expired-pending-mfa': { batchSize?: number };
  }
}

const payload = z.object({
  batchSize: z.number().int().min(1).max(1000).optional(),
});
for (const name of [
  'identity.reseal-mfa-secrets',
  'identity.purge-mfa-challenges',
  'identity.purge-expired-pending-mfa',
] as const)
  declareJobType({ name, contract: payload });

const BATCH = 200;
const MAX_BATCHES = 50;

/** Repeats a bounded batch until nothing is left or the per-run cap is reached (the next run continues). */
async function drain(batch: () => Promise<number>): Promise<void> {
  for (let i = 0; i < MAX_BATCHES; i++) if ((await batch()) === 0) return;
}

/**
 * S02 housekeeping (apps/worker): the one-off re-seal of migrated TOTP secrets (enqueue it once per environment; it
 * is idempotent and resumable), and the daily purges of expired pending enrolments and spent challenge state.
 */
@Injectable()
export class MfaStateJobs implements OnApplicationBootstrap {
  constructor(
    private readonly maintenance: MfaMaintenanceService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'identity.purge-mfa-challenges',
      cron: '15 4 * * *',
      jobType: 'identity.purge-mfa-challenges',
      payload: {},
    });
    await this.jobs.upsertSchedule({
      name: 'identity.purge-expired-pending-mfa',
      cron: '20 4 * * *',
      jobType: 'identity.purge-expired-pending-mfa',
      payload: {},
    });
  }

  @JobHandler('identity.reseal-mfa-secrets', { concurrency: 1 })
  async reseal({ batchSize = BATCH }: { batchSize?: number }): Promise<void> {
    await drain(() => this.maintenance.resealSecrets({ batchSize }));
  }

  @JobHandler('identity.purge-mfa-challenges', { concurrency: 1 })
  async purgeChallenges({
    batchSize = BATCH,
  }: {
    batchSize?: number;
  }): Promise<void> {
    await drain(() => this.maintenance.purgeChallenges({ batchSize }));
  }

  @JobHandler('identity.purge-expired-pending-mfa', { concurrency: 1 })
  async purgePending({
    batchSize = BATCH,
  }: {
    batchSize?: number;
  }): Promise<void> {
    await drain(() => this.maintenance.purgeExpiredPending({ batchSize }));
  }
}
