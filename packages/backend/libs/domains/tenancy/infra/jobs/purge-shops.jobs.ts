import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { ShopLifecycleService } from '../../application/shop-lifecycle.service';
import { ShopSsoService } from '../../application/shop-sso.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'tenancy.purge-deleted-shops': Record<string, never>;
    'tenancy.purge-expired-invites': Record<string, never>;
    'tenancy.reseal-sso-secrets': Record<string, never>;
  }
}

for (const name of [
  'tenancy.purge-deleted-shops',
  'tenancy.purge-expired-invites',
  'tenancy.reseal-sso-secrets',
] as const)
  declareJobType({ name, contract: z.object({}) });

const RESEAL_BATCH = 200;

/**
 * Scheduled maintenance of the tenancy domain (S49): the purge of shops whose grace period is over (hourly), the
 * removal of old invites with their addresses (daily) and the one-off re-seal of SSO secrets sealed before they were
 * bound to their shop (idempotent, so it stays scheduled and finds nothing once done). All three are single-run
 * jobs; the work is safe to repeat.
 */
@Injectable()
export class PurgeShopsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurgeShopsJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly lifecycle: ShopLifecycleService,
    private readonly sso: ShopSsoService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const schedules = [
      ['tenancy.purge-deleted-shops', '0 5 * * * *'],
      ['tenancy.purge-expired-invites', '0 20 3 * * *'],
      ['tenancy.reseal-sso-secrets', '0 40 3 * * *'],
    ] as const;
    for (const [jobType, cron] of schedules)
      try {
        await this.jobs.upsertSchedule({
          name: jobType,
          cron,
          jobType,
          payload: {},
        });
      } catch (error) {
        if (!(error instanceof InvalidScheduleError)) throw error;
        this.logger.error(
          `schedule ${jobType} not registered: ${error.message}`,
        );
      }
  }

  @JobHandler('tenancy.purge-deleted-shops', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async purgeDeletedShops(): Promise<{ purged: number }> {
    const purged = await this.lifecycle.purgeDue();
    if (purged > 0) this.logger.log({ action: 'shops.purged', purged });
    return { purged };
  }

  @JobHandler('tenancy.purge-expired-invites', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async purgeExpiredInvites(): Promise<{ purged: number }> {
    const purged = await this.lifecycle.purgeSettledInvites();
    if (purged > 0) this.logger.log({ action: 'invites.purged', purged });
    return { purged };
  }

  @JobHandler('tenancy.reseal-sso-secrets', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async resealSsoSecrets(): Promise<{ resealed: number }> {
    let resealed = 0;
    for (;;) {
      const changed = await this.sso.resealLegacySecrets(RESEAL_BATCH);
      resealed += changed;
      if (changed < RESEAL_BATCH) break;
    }
    return { resealed };
  }
}
