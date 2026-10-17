import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InvalidScheduleError } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { JudgeRecoveryService } from '../application/judge-recovery.service';
import {
  RECOVER_STUCK_JOB,
  RECOVER_STUCK_SCHEDULE,
} from '../application/shop-functions.job-types';

/**
 * The recovery schedule (every minute, idempotent at every boot; S45 FR-020). `fleetConcurrency: 1` keeps one run in
 * the fleet; an invalid schedule is logged and fails the start rather than leaving stuck versions unrecovered.
 */
@Injectable()
export class JudgeJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(JudgeJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly recovery: JudgeRecoveryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: RECOVER_STUCK_SCHEDULE,
        cron: '* * * * *',
        jobType: RECOVER_STUCK_JOB,
        payload: {},
      });
    } catch (error) {
      if (error instanceof InvalidScheduleError)
        this.logger.error(`schedule not registered: ${error.message}`);
      throw error;
    }
  }

  @JobHandler(RECOVER_STUCK_JOB, { concurrency: 1, fleetConcurrency: 1 })
  async recoverStuckVersions() {
    return this.recovery.run();
  }
}
