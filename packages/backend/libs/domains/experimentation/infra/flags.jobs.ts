import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { RulesetRepairService } from '../application/ruleset-repair.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'flags.repair-ruleset': Record<string, never>;
  }
}

declareJobType({
  name: 'flags.repair-ruleset',
  contract: z.object({}).strict(),
});

/**
 * Background work of flags, registered only by `FlagsWorkerModule` (S38 R-8): the ruleset repair, every 30 seconds
 * (the scheduler's cron has a seconds field), one run at a time across the fleet.
 */
@Injectable()
export class FlagsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(FlagsJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly repair: RulesetRepairService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'flags.repair-ruleset',
        cron: '*/30 * * * * *',
        jobType: 'flags.repair-ruleset',
        payload: {},
        overlap: 'skip',
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(
        `schedule flags.repair-ruleset not registered: ${error.message}`,
      );
    }
  }

  @JobHandler('flags.repair-ruleset', { concurrency: 1, fleetConcurrency: 1 })
  async repairRuleset(): Promise<void> {
    await this.repair.run();
  }
}
