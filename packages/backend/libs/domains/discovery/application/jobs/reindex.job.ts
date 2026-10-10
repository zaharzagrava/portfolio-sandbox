import { Injectable } from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import type { JobContext } from '@app/infrastructure/jobs/job-types';
import { RunExecutorService } from '../reindex/run-executor.service';
import '../../infra/search.jobs';

/**
 * `search.reindex {runId}`: the job of a reindex or rollback run. A long lease that the worker heartbeats; the executor
 * resumes from the run row, so a retried or re-claimed job continues instead of starting over.
 */
@Injectable()
export class ReindexJob {
  constructor(private readonly executor: RunExecutorService) {}

  @JobHandler('search.reindex', {
    concurrency: 1,
    fleetConcurrency: 1,
    leaseMs: 120_000,
    maxRuntimeMs: 4 * 3_600_000,
  })
  async run({ runId }: { runId: string }, ctx: JobContext): Promise<void> {
    await this.executor.execute(runId, {
      heartbeat: () => ctx.heartbeat(),
      isLastAttempt: ctx.isLastAttempt,
    });
  }
}
