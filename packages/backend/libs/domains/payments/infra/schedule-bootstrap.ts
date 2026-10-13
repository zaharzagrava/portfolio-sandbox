import type { Logger } from '@nestjs/common';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import type { JobsService } from '@app/infrastructure/jobs/jobs.service';
import type { JobType } from '@app/infrastructure/jobs/job-types';

/** Job attempts for every S14 schedule and enqueue (S49 follow-up); `ledger.settle-order` runs once by design. */
export const LEDGER_JOB_ATTEMPTS = 3;

/**
 * Registers a schedule at boot with `maxAttempts: 3`. A schedule the job layer refuses (`InvalidScheduleError`) is
 * logged with the job name and does not stop the application; any other failure propagates.
 */
export async function upsertLedgerSchedule<T extends JobType>(
  jobs: JobsService,
  logger: Logger,
  schedule: Omit<
    Parameters<JobsService['upsertSchedule']>[0],
    'maxAttempts'
  > & {
    jobType: T;
  },
): Promise<void> {
  try {
    await jobs.upsertSchedule({
      ...schedule,
      maxAttempts: LEDGER_JOB_ATTEMPTS,
    } as never);
  } catch (error) {
    if (!(error instanceof InvalidScheduleError)) throw error;
    logger.error(
      `schedule ${schedule.name} (${schedule.jobType}) refused: ${error.message}`,
    );
  }
}
