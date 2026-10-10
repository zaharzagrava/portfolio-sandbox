import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import type { JobContext } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { NonRetryableJobError } from '@app/infrastructure/jobs/job-types';
import {
  CoOccurrenceBuildService,
  type BuildOutcome,
} from '../application/co-occurrence-build.service';
import { buildPayloadContract, parseBuildParams } from '../domain/build-params';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'recommendations.build-bought-together': {
      days?: number;
      buckets?: number;
    };
  }
}

declareJobType({
  name: 'recommendations.build-bought-together',
  contract: buildPayloadContract,
});

/** One hour for a run on the 1-billion-line fixture; `maxRuntimeMs` may not be below the lease (S49). */
export const BUILD_LEASE_MS = 3_600_000;
export const BUILD_MAX_RUNTIME_MS = 3_600_000;

/**
 * Nightly "frequently bought together" build (S34): the cron schedule and the job handler. The work is the build
 * service's; this is the thin edge that registers the schedule, validates the payload and hands over the abort signal.
 * One run in the whole fleet (`fleetConcurrency: 1`); the build lock covers direct invocations.
 */
@Injectable()
export class CoOccurrenceJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(CoOccurrenceJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly builds: CoOccurrenceBuildService,
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.jobs.upsertSchedule({
        name: 'recommendations.build-bought-together',
        cron: '17 3 * * *',
        jobType: 'recommendations.build-bought-together',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule not registered: ${error.message}`);
    }
  }

  @JobHandler('recommendations.build-bought-together', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: BUILD_LEASE_MS,
    maxRuntimeMs: BUILD_MAX_RUNTIME_MS,
  })
  build(
    payload?: { days?: number; buckets?: number },
    context?: JobContext,
  ): Promise<BuildOutcome> {
    const params = parseBuildParams(payload, this.builds.defaults);
    if (!params.ok)
      throw new NonRetryableJobError(
        `invalid build parameters: ${params.fields.join(', ')}`,
      );
    return this.builds.build(params.value, context?.signal);
  }
}
