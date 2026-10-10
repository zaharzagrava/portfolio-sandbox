import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { JobsService } from '@app/infrastructure/jobs';
import {
  INDEX_MANAGER,
  REINDEX_RUN_REPOSITORY,
  type IndexManagerPort,
  type ReindexRunRecord,
  type ReindexRunRepository,
} from '../../domain/ports';
import {
  InvalidRunTransitionError,
  RunNotFoundError,
} from '../../domain/search-errors';
import { SearchIndexRegistry } from '../../infra/search-index-registry';
import { SearchAudit } from './reindex-audit';
import { reindexJobKey } from './start-reindex.service';

/**
 * Cancels an active run. The status move is a conditional update that loses against a run which has claimed the final
 * switch (III.6): exactly one of "cancel" and "switch" wins. The half-built index is deleted here too, so a cancel does
 * not depend on a worker being alive; a worker that is mid-step notices the status and stops.
 */
@Injectable()
export class CancelReindexService {
  constructor(
    @Inject(REINDEX_RUN_REPOSITORY) private readonly runs: ReindexRunRepository,
    @Inject(INDEX_MANAGER) private readonly manager: IndexManagerPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly jobs: JobsService,
    private readonly registry: SearchIndexRegistry,
    private readonly audit: SearchAudit,
  ) {}

  async cancel(runId: string, actorId: string): Promise<ReindexRunRecord> {
    const existing = await this.runs.get(runId);
    if (!existing) throw new RunNotFoundError();
    const cancelled = await this.runs.cancel(runId, this.clock.now());
    if (!cancelled) {
      const now = await this.runs.get(runId);
      throw new InvalidRunTransitionError(now?.status ?? existing.status);
    }
    await this.jobs.cancelByKey(reindexJobKey(runId)).catch(() => undefined);
    this.registry.invalidate();
    if (cancelled.kind === 'REINDEX' && cancelled.index)
      await this.manager
        .deleteUnlessLive(cancelled.index)
        .catch(() => undefined);
    this.audit.record({ actorId, action: 'search.reindex.cancel', runId });
    return cancelled;
  }
}
