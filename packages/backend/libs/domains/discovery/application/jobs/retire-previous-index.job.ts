import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { InvalidScheduleError, JobsService } from '@app/infrastructure/jobs';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import {
  INDEX_MANAGER,
  REINDEX_RUN_REPOSITORY,
  type IndexManagerPort,
  type ReindexRunRepository,
} from '../../domain/ports';
import { SearchIndexRegistry } from '../../infra/search-index-registry';
import { SearchSettings } from '../../infra/search-settings';
import '../../infra/search.jobs';

/**
 * Hourly: the previous index a completed run retained for rollback is deleted once its 24 hours are over, and parallel
 * writes to it stop (FR-037). Never the index the live name points to, never the target of an active run. Indices
 * older than the retention that no run knows (left behind by a crash during cleanup) go too.
 */
@Injectable()
export class RetirePreviousIndexJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetirePreviousIndexJob.name);

  constructor(
    private readonly jobs: JobsService,
    @Inject(REINDEX_RUN_REPOSITORY) private readonly runs: ReindexRunRepository,
    @Inject(INDEX_MANAGER) private readonly manager: IndexManagerPort,
    private readonly registry: SearchIndexRegistry,
    private readonly settings: SearchSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'search.retire-previous-index',
        cron: '0 5 * * * *',
        jobType: 'search.retire-previous-index',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`schedule not registered: ${error.message}`);
    }
  }

  @JobHandler('search.retire-previous-index', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async retire(): Promise<{ retired: string[]; swept: string[] }> {
    const now = this.clock.now();
    const retired: string[] = [];
    const latest = await this.runs.latestCompleted();
    if (
      latest?.previousIndex &&
      latest.previousRetiresAt &&
      latest.previousRetiresAt.getTime() <= now.getTime()
    ) {
      const active = await this.runs.findActive();
      if (active?.index !== latest.previousIndex) {
        const deleted = await this.manager.deleteUnlessLive(latest.previousIndex);
        if (deleted) retired.push(latest.previousIndex);
        await this.runs.clearPrevious(latest.runId);
        this.registry.invalidate();
      }
    }

    // indices nobody refers to any more, older than the retention window
    const swept: string[] = [];
    const known = new Set(await this.runs.retainedIndexes());
    const live = await this.manager.liveIndex();
    const maxAgeMs = this.settings.previousIndexRetentionHours * 3_600_000;
    for (const info of await this.manager.productIndices()) {
      if (info.name === live?.name || known.has(info.name)) continue;
      if (!info.createdAt || now.getTime() - info.createdAt.getTime() < maxAgeMs)
        continue;
      if (await this.manager.deleteUnlessLive(info.name)) swept.push(info.name);
    }
    if (retired.length > 0 || swept.length > 0)
      this.logger.log({ action: 'search.indices_retired', retired, swept });
    return { retired, swept };
  }
}
