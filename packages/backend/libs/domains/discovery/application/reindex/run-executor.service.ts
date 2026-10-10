import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  EngineRejectedError,
  EngineUnavailableError,
} from '@app/infrastructure/elasticsearch/search-engine.errors';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { SearchReindexCompleted } from '../events/search-reindex-events';
import {
  EMBEDDING_PROVIDER,
  INDEX_MANAGER,
  PROJECTION_LAG,
  REINDEX_PROBE,
  REINDEX_RUN_REPOSITORY,
  SimulatedCrash,
  type EmbeddingProvider,
  type IndexManagerPort,
  type ProjectionLagPort,
  type ReindexProbe,
  type ReindexRunRecord,
  type ReindexRunRepository,
} from '../../domain/ports';
import { SearchIndexRegistry } from '../../infra/search-index-registry';
import { SearchSettings } from '../../infra/search-settings';
import {
  searchReindexDuration,
  searchReindexFailedCounter,
} from '../../infra/search-metrics';
import {
  HistoryReplayService,
  type ReplayPosition,
} from './history-replay.service';
import type { ReplayLedger } from '../projection/product-projection.service';

const LAG_LIMIT_SECONDS = 10;
const RETRY_MS = 250;

/** The verification gate found the new index does not match what the history requires. */
export class VerificationFailedError extends Error {
  constructor(detail: string) {
    super(`reindex verification failed: ${detail}`);
    this.name = 'VerificationFailedError';
  }
}

/** The run was cancelled (or taken over) while a step was running: stop quietly. */
class RunStopped extends Error {}

export interface ExecuteContext {
  heartbeat?: () => Promise<void>;
  isLastAttempt?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EMPTY_LEDGER: ReplayLedger = {
  read: 0,
  applied: 0,
  duplicate: 0,
  stale: 0,
  ignored: 0,
};

/**
 * Runs one reindex or rollback run to its end, from whatever status the run row is in, so a worker that takes the job
 * over after a crash simply continues (S32 FR-032 to FR-037, research R-05 to R-07):
 *
 * - `QUEUED`: create the target index (deterministic name), move to `BUILDING`, let every instance learn about the new
 *   write target (the projectors now write to both indices);
 * - `BUILDING`: replay the retained history up to the watermark into the target, then `CATCHING_UP`;
 * - `CATCHING_UP`: wait for the live projector to be close to the log, verify the target against the history and the
 *   live index, claim the switch, move the live name in one atomic call, record `COMPLETED` and the event in one
 *   transaction.
 *
 * Failure of the engine or of the gate marks the run `FAILED`, deletes the half-built index and leaves search alone.
 */
@Injectable()
export class RunExecutorService {
  private readonly logger = new Logger(RunExecutorService.name);

  constructor(
    @Inject(REINDEX_RUN_REPOSITORY) private readonly runs: ReindexRunRepository,
    @Inject(INDEX_MANAGER) private readonly manager: IndexManagerPort,
    @Inject(PROJECTION_LAG) private readonly lag: ProjectionLagPort,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(REINDEX_PROBE) private readonly probe: ReindexProbe,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: SearchIndexRegistry,
    private readonly replay: HistoryReplayService,
    private readonly settings: SearchSettings,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  async execute(runId: string, ctx: ExecuteContext = {}): Promise<void> {
    for (let guard = 0; guard < 10; guard++) {
      const run = await this.runs.get(runId);
      if (!run) return;
      try {
        switch (run.status) {
          case 'QUEUED':
            await this.begin(run);
            break;
          case 'BUILDING':
            await this.build(run, ctx);
            break;
          case 'CATCHING_UP':
            await this.finish(run);
            return;
          case 'CANCELLED':
            await this.cleanup(run);
            return;
          case 'COMPLETED':
          case 'FAILED':
            return;
        }
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        if (error instanceof RunStopped) continue;
        const reason = this.failureReason(error);
        if (reason) {
          await this.fail(runId, reason, error as Error);
          return;
        }
        if (ctx.isLastAttempt) {
          await this.fail(runId, 'error', error as Error);
          return;
        }
        throw error;
      }
    }
  }

  private failureReason(error: unknown): string | null {
    if (error instanceof EngineUnavailableError) return 'engine_unavailable';
    if (error instanceof EngineRejectedError) return 'verification_failed';
    if (error instanceof VerificationFailedError) return 'verification_failed';
    return null;
  }

  /** QUEUED: the target index exists, the run is BUILDING. */
  private async begin(run: ReindexRunRecord): Promise<void> {
    const index =
      run.kind === 'REINDEX' ? await this.manager.createFor(run.runId) : run.index;
    const moved = await this.runs.transition(
      run.runId,
      'QUEUED',
      'BUILDING',
      { index, startedAt: this.clock.now() },
      this.clock.now(),
    );
    if (moved) this.registry.invalidate();
    // a cancelled run (moved === null) is picked up by the next pass of `execute`
    if (!moved && run.kind === 'REINDEX' && index)
      await this.manager.deleteUnlessLive(index).catch(() => undefined);
  }

  /** BUILDING: replay (REINDEX) or nothing to do (ROLLBACK), then CATCHING_UP. */
  private async build(run: ReindexRunRecord, ctx: ExecuteContext): Promise<void> {
    // every instance must have the new index in its write set before the replay starts
    this.registry.invalidate();
    await sleep(2 * this.registry.ttlMs);
    await this.probe.afterBuildingStarted?.(run);
    if (await this.stopped(run.runId, 'BUILDING')) throw new RunStopped();

    let patch: Parameters<ReindexRunRepository['transition']>[3] = {};
    if (run.kind === 'REINDEX') {
      const previous = run.replayPosition as Partial<ReplayPosition>;
      const watermark =
        previous.watermark ?? (await this.replay.captureWatermark());
      if (!previous.watermark)
        await this.runs.progress(run.runId, {
          replayPosition: { watermark, next: {} },
        });
      const info = await this.manager.liveIndex();
      const liveInfo = info ? await this.manager.info(info.name) : null;
      const reuseVectors =
        liveInfo?.embeddingModelVersion === run.embeddingModelVersion;
      const result = await this.replay.replay(
        run.runId,
        { index: run.index!, reuseVectors },
        watermark,
        {
          afterChunk: async (step, position) => {
            await this.runs.progress(run.runId, {
              replayPosition: position as unknown as Record<string, unknown>,
            });
            await ctx.heartbeat?.();
            await this.probe.afterBatch?.(run, step);
            return !(await this.stopped(run.runId, 'BUILDING'));
          },
        },
        { ...EMPTY_LEDGER, ...(run.ledger as Partial<ReplayLedger>) },
      );
      if (result.stopped) throw new RunStopped();
      await this.manager.refresh(run.index!);
      patch = {
        ledger: result.ledger as unknown as Record<string, number>,
        documents: await this.manager.countProducts(run.index!),
        replayPosition: result.position as unknown as Record<string, unknown>,
      };
      await this.probe.afterReplay?.(run);
    }
    const moved = await this.runs.transition(
      run.runId,
      'BUILDING',
      'CATCHING_UP',
      patch,
      this.clock.now(),
    );
    if (!moved) throw new RunStopped();
  }

  private async stopped(runId: string, expect: ReindexRunRecord['status']) {
    const current = await this.runs.get(runId);
    return !current || current.status !== expect;
  }

  /** CATCHING_UP: verify, switch once, complete. */
  private async finish(run: ReindexRunRecord): Promise<void> {
    const live = await this.manager.liveIndex();
    const alreadySwitched = run.switchingAt !== null && live?.name === run.index;
    if (!alreadySwitched) {
      if (run.kind === 'REINDEX') await this.verify(run);
      await this.probe.beforeSwitch?.(run);
      const claimed = await this.runs.claimSwitch(run.runId, this.clock.now());
      if (!claimed) {
        // cancelled, or another worker holds the switch: look again
        const now = await this.runs.get(run.runId);
        if (now?.status === 'CANCELLED') await this.cleanup(now);
        else if (now?.status === 'CATCHING_UP' && now.switchingAt !== null)
          return this.finish(now);
        return;
      }
      // remember what is being replaced before replacing it: a worker that dies after the switch still knows
      const previous = live && !live.concrete ? live.name : null;
      await this.runs.progress(run.runId, { previousIndex: previous });
      await this.manager.switchLive(run.index!);
      this.registry.invalidate();
      await this.probe.afterSwitch?.(run);
    }
    await this.complete(await this.runs.get(run.runId) ?? run);
  }

  /** (a) every event read is accounted for and none was rejected; (b) the new index holds at least what the live one holds. */
  private async verify(run: ReindexRunRecord): Promise<void> {
    const l = run.ledger as Partial<ReplayLedger> & { rejected?: number };
    const accounted =
      (l.applied ?? 0) + (l.duplicate ?? 0) + (l.stale ?? 0) + (l.ignored ?? 0);
    if ((l.rejected ?? 0) > 0 || (l.read ?? 0) !== accounted)
      throw new VerificationFailedError(
        `${l.read ?? 0} events read, ${accounted} accounted for`,
      );

    const deadline = Date.now() + this.settings.reindexVerifyWaitMs;
    let counts = { fresh: -1, live: -1 };
    for (;;) {
      const lagSeconds = await this.lag.seconds();
      const live = await this.manager.liveIndex();
      await this.manager.refresh(run.index!);
      if (live) await this.manager.refresh(live.name);
      counts = {
        fresh: await this.manager.countProducts(run.index!),
        live: live ? await this.manager.countProducts(live.name) : 0,
      };
      // the new index must hold at least what the live one holds; more is a live index that missed history
      if (counts.fresh >= counts.live && lagSeconds < LAG_LIMIT_SECONDS) return;
      if (Date.now() >= deadline)
        throw new VerificationFailedError(
          `new index holds ${counts.fresh} products, live index ${counts.live}`,
        );
      if ((await this.runs.get(run.runId))?.status !== 'CATCHING_UP')
        throw new RunStopped();
      await sleep(RETRY_MS);
    }
  }

  /** CATCHING_UP -> COMPLETED and the event, in one transaction (nothing else happens inside it). */
  private async complete(run: ReindexRunRecord): Promise<void> {
    const now = this.clock.now();
    const retiresAt = new Date(
      now.getTime() + this.settings.previousIndexRetentionHours * 3_600_000,
    );
    const documents = await this.manager.countProducts(run.index!);
    const done = await this.transactions.run(async () => {
      const moved = await this.runs.transition(
        run.runId,
        'CATCHING_UP',
        'COMPLETED',
        {
          documents,
          previousRetiresAt: run.previousIndex ? retiresAt : null,
          finishedAt: now,
        },
        now,
      );
      if (!moved) return null;
      await this.outbox.append(
        SearchReindexCompleted.create(
          run.runId,
          0,
          {
            runId: run.runId,
            kind: run.kind,
            index: run.index!,
            previousIndex: moved.previousIndex,
            documents,
            mappingVersion: run.mappingVersion,
            finishedAt: now.toISOString(),
          },
          now,
        ),
      );
      return moved;
    });
    if (!done) return;
    this.registry.invalidate();
    if (done.startedAt)
      searchReindexDuration.record(
        Math.max(0, (now.getTime() - done.startedAt.getTime()) / 1000),
        { kind: run.kind },
      );
    await this.removeSuperseded(done);
    this.logger.log({ action: 'search.reindex.completed', runId: run.runId, documents });
  }

  /** Only the new live index and its one retained predecessor stay; older ones from earlier runs go. */
  private async removeSuperseded(done: ReindexRunRecord): Promise<void> {
    const active = await this.runs.findActive();
    const keep = new Set(
      [done.index, done.previousIndex, active?.index].filter(
        (x): x is string => !!x,
      ),
    );
    for (const info of await this.manager.productIndices())
      if (!keep.has(info.name))
        await this.manager.deleteUnlessLive(info.name).catch(() => undefined);
  }

  /** FAILED: the half-built index is deleted, the failure is counted, search was never touched. */
  private async fail(runId: string, reason: string, cause: Error): Promise<void> {
    this.logger.error({ action: 'search.reindex.failed', runId, reason, cause: cause.message });
    const run = await this.runs.get(runId);
    if (!run) return;
    if (run.status === 'QUEUED' || run.status === 'BUILDING' || run.status === 'CATCHING_UP') {
      const moved = await this.runs.transition(
        runId,
        run.status,
        'FAILED',
        { failureReason: reason, finishedAt: this.clock.now() },
        this.clock.now(),
        { reason },
      );
      if (moved) searchReindexFailedCounter.add(1, { reason });
    }
    this.registry.invalidate();
    await this.cleanup(run);
  }

  /** A failed or cancelled REINDEX run leaves nothing behind; a rollback's target is the retained index and stays. */
  async cleanup(run: ReindexRunRecord): Promise<void> {
    if (run.kind === 'REINDEX' && run.index)
      await this.manager.deleteUnlessLive(run.index).catch((error: Error) =>
        this.logger.warn(`could not delete ${run.index}: ${error.message}`),
      );
    this.registry.invalidate();
  }
}
