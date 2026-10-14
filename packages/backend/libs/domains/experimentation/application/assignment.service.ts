import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AssignmentsResponse } from '@marketplace-sandbox/contracts';
import { assignAll } from '../domain/experiments';
import {
  EXPERIMENT_REPOSITORY,
  RUNNING_SET_CACHE,
  type ExperimentRepository,
  type RunningSetCache,
} from '../domain/ports';
import { withTimeout } from '../domain/with-timeout';
import { experimentAssignmentsTotal } from './analytics-metrics';

/** The database read of the running set must answer within this long, else everybody sees control (S39 FR-031). */
export const RUNNING_SET_DB_TIMEOUT_MS = 500;

/**
 * The variants of the caller (S39 FR-030, FR-031). The running set comes from the cache layers, else from the database
 * within 500 ms; if neither answers the caller is told `degraded` and assigned nothing, which every client reads as
 * "control": a store outage is a missed experiment, never an error on a product page.
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    @Inject(EXPERIMENT_REPOSITORY)
    private readonly experiments: ExperimentRepository,
    @Inject(RUNNING_SET_CACHE) private readonly runningSet: RunningSetCache,
  ) {}

  async assignments(ids: {
    userId?: string;
    anonymousId?: string;
  }): Promise<AssignmentsResponse> {
    let running;
    try {
      running = await this.runningSet.get(() =>
        withTimeout(
          this.experiments.listRunning(),
          RUNNING_SET_DB_TIMEOUT_MS,
          'running experiments',
        ),
      );
    } catch (error) {
      experimentAssignmentsTotal.add(1, { outcome: 'degraded' });
      this.logger.warn({
        event: 'experiments.assignment_degraded',
        reason: (error as Error)?.name,
      });
      return { assignments: {}, degraded: true };
    }
    const assignments = assignAll(running, ids);
    experimentAssignmentsTotal.add(1, {
      outcome: Object.keys(assignments).length ? 'assigned' : 'none',
    });
    return { assignments, degraded: false };
  }
}
