import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import type { JobContext } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import {
  AutocompleteBuildService,
  type BuildOutcome,
} from '../application/autocomplete-build.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'search.build-autocomplete': Record<string, never>;
  }
}

declareJobType({
  name: 'search.build-autocomplete',
  contract: z.object({}).strict(),
});

/** The lease stays 10 minutes (FR-030); the run is stopped at the lease boundary, so a second replica never overlaps the first. */
export const BUILD_LEASE_MS = 600_000;
export const BUILD_MAX_RUNTIME_MS = 600_000;

/**
 * Offline half (S33 FR-020): the hourly schedule and the job handler. The work is the build service's; this is the thin
 * edge that registers the schedule and passes the run's abort signal on.
 */
@Injectable()
export class AutocompleteBuilderJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(AutocompleteBuilderJobs.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly builds: AutocompleteBuildService,
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.jobs.upsertSchedule({
        name: 'search.build-autocomplete',
        cron: '7 * * * *',
        jobType: 'search.build-autocomplete',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule not registered: ${error.message}`);
    }
  }

  @JobHandler('search.build-autocomplete', {
    concurrency: 1,
    leaseMs: BUILD_LEASE_MS,
    maxRuntimeMs: BUILD_MAX_RUNTIME_MS,
  })
  build(
    _payload?: Record<string, never>,
    context?: JobContext,
  ): Promise<BuildOutcome> {
    return this.builds.build(context?.signal);
  }
}
