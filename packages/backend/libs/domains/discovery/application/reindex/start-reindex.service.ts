import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs';
import { MAPPING_VERSION } from '../../domain/index-definition';
import {
  ActiveRunExistsError,
  EMBEDDING_PROVIDER,
  INDEX_MANAGER,
  REINDEX_RUN_REPOSITORY,
  type EmbeddingProvider,
  type IndexManagerPort,
  type ReindexRunKind,
  type ReindexRunRepository,
} from '../../domain/ports';
import {
  NoPreviousIndexError,
  ReindexInProgressError,
} from '../../domain/search-errors';
import '../../infra/search.jobs';
import { SearchAudit } from './reindex-audit';

export const reindexJobKey = (runId: string) => `search.reindex:${runId}`;

export interface AcceptedRun {
  runId: string;
  kind: ReindexRunKind;
  status: 'QUEUED';
}

/**
 * Starts a reindex or a rollback: one `QUEUED` run row and its job, together (the job is enqueued inside the same
 * transaction, so there is never a run without its job). A second active run is refused by the partial unique index,
 * not by a check that two requests could both pass (III.6).
 */
@Injectable()
export class StartReindexService {
  constructor(
    @Inject(REINDEX_RUN_REPOSITORY) private readonly runs: ReindexRunRepository,
    @Inject(INDEX_MANAGER) private readonly manager: IndexManagerPort,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly jobs: JobsService,
    private readonly transactions: TransactionRunner,
    private readonly audit: SearchAudit,
  ) {}

  startReindex(actorId: string): Promise<AcceptedRun> {
    return this.queue('REINDEX', actorId, {});
  }

  /** Points the live name back at the retained previous index (written to in parallel, so it holds every update). */
  async startRollback(actorId: string): Promise<AcceptedRun> {
    const active = await this.runs.findActive();
    if (active) throw new ReindexInProgressError(active.runId);
    const latest = await this.runs.latestCompleted();
    const live = await this.manager.liveIndex();
    if (
      !latest?.previousIndex ||
      !(await this.manager.info(latest.previousIndex))
    )
      throw new NoPreviousIndexError();
    return this.queue('ROLLBACK', actorId, {
      index: latest.previousIndex,
      previousIndex: live && !live.concrete ? live.name : null,
    });
  }

  private async queue(
    kind: ReindexRunKind,
    actorId: string,
    over: { index?: string | null; previousIndex?: string | null },
  ): Promise<AcceptedRun> {
    const active = await this.runs.findActive();
    if (active) throw new ReindexInProgressError(active.runId);
    const runId = randomUUID();
    try {
      await this.transactions.run(async () => {
        await this.runs.insertQueued({
          runId,
          kind,
          mappingVersion: MAPPING_VERSION,
          embeddingModelVersion: this.embeddings.modelVersion,
          requestedBy: actorId,
          now: this.clock.now(),
          ...over,
        });
        await this.jobs.enqueue(
          'search.reindex',
          { runId },
          { idempotencyKey: reindexJobKey(runId) },
        );
      });
    } catch (error) {
      if (error instanceof ActiveRunExistsError) {
        const active = await this.runs.findActive();
        throw new ReindexInProgressError(active?.runId ?? error.activeRunId);
      }
      throw error;
    }
    this.audit.record({
      actorId,
      action:
        kind === 'REINDEX' ? 'search.reindex.start' : 'search.rollback.start',
      runId,
    });
    return { runId, kind, status: 'QUEUED' };
  }
}
