import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  StorageAbortedError,
  StorageStalledError,
} from '@app/infrastructure/storage/object-storage.port';
import { EXPORT_CONFIG, type ExportConfig } from '../domain/export-config';
import { CSV_BOM, EXPORT_HEADER, encodeRecord } from '../domain/export-csv';
import { classify, type ExportFailureCode } from '../domain/export-failure';
import {
  EXPORT_FILES,
  EXPORT_JOBS,
  EXPORT_LINES,
  EXPORT_LIVE,
  EXPORT_QUEUE,
  EXPORT_SKUS,
  type ExportFilesPort,
  type ExportJobRecord,
  type ExportJobsPort,
  type ExportLinesPort,
  type ExportLivePort,
  type ExportQueuePort,
  type ExportSink,
  type ExportSkuInfo,
  type ExportSkusPort,
} from '../domain/export-ports';
import {
  exportBytesCounter,
  exportDurationHistogram,
  exportFinishedCounter,
  exportLinesCounter,
  exportQueueWaitHistogram,
  exportRetriesCounter,
} from '../domain/export-metrics';
import { shouldPublishProgress } from '../domain/export-progress';
import {
  resolveLineTotalMinor,
  resolveTitle,
  type ExportRow,
  type RawExportRow,
} from '../domain/export-row';
import { exportSpan } from './export-tracing';
import {
  RunError,
  StopRun,
  catalogErrorClass,
  databaseErrorClass,
  type StopReason,
} from './order-export-errors';

/** What became of one queue message (the consumer acknowledges every one of them). */
export type RunOutcome =
  | 'done'
  | 'retry'
  | 'failed'
  | 'cancelled'
  | 'lost'
  | 'shutdown'
  | 'ignored'
  | 'unknown';

interface ActiveRun {
  exportId: string;
  holder: string;
  key: string;
  startedAt: Date;
  controller: AbortController;
  stop: StopReason | null;
  sink: ExportSink | null;
  rowsWritten: number;
  bytesWritten: number;
  totalRows: number;
  lastEventAtMs: number | null;
}

const RETRY_DELAY_SEC = 60;
const MAX_QUEUE_DELAY_SEC = 900;

/**
 * Runs one export (S12 FR-014 to FR-024): claim with a lease, count, stream keyset batches through one `pipeline`
 * into a per-attempt object, and finish in one fenced transaction. Every write carries the lease holder, so a worker
 * that lost its lease (cancel, recovery, another worker) changes nothing and deletes only its own attempt object.
 * Retries are queue redeliveries (a new message after the transient failure), never a loop inside the run.
 */
@Injectable()
export class OrderExportRunService implements OnModuleDestroy {
  private readonly logger = new Logger(OrderExportRunService.name);
  /** The runs of this process by lease holder (an export may be run, lost and run again by the same process). */
  private readonly active = new Map<string, ActiveRun>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    @Inject(EXPORT_JOBS) private readonly jobs: ExportJobsPort,
    @Inject(EXPORT_LINES) private readonly lines: ExportLinesPort,
    @Inject(EXPORT_FILES) private readonly files: ExportFilesPort,
    @Inject(EXPORT_SKUS) private readonly skus: ExportSkusPort,
    @Inject(EXPORT_LIVE) private readonly live: ExportLivePort,
    @Inject(EXPORT_QUEUE) private readonly queue: ExportQueuePort,
    @Inject(EXPORT_CONFIG) private readonly config: ExportConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Starts the lease heartbeat of this process (the worker's consumer calls it once). */
  startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(
      () => void this.heartbeatTick(),
      this.config.heartbeatSec * 1000,
    );
    this.heartbeat.unref();
  }

  /** Graceful shutdown: every running export is released to `QUEUED` without costing an attempt. */
  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.shutdown();
  }

  shutdown(): void {
    for (const run of this.active.values()) this.stop(run, 'shutdown');
  }

  /** Number of runs this process holds (a probe for tests and metrics). */
  activeRuns(): number {
    return this.active.size;
  }

  /**
   * One queue message. Unknown exports are acknowledged with one warning, finished and running ones are acknowledged
   * without effect (AS-44); only a failure to claim at all (the database is down) reaches the queue as an error.
   */
  async handle(exportId: string): Promise<RunOutcome> {
    const job = await this.jobs.findById(exportId);
    if (!job) {
      this.logger.warn(`order_export_message_for_unknown_export`);
      return 'unknown';
    }
    if (job.status !== 'QUEUED') return 'ignored';
    const now = this.clock.now();
    const holder = randomUUID();
    const claimed = await this.jobs.claim({
      exportId,
      leaseHolder: holder,
      leaseExpiresAt: this.leaseEnd(now),
      now,
    });
    if (!claimed) return 'ignored';
    exportQueueWaitHistogram.record(
      Math.max(0, (now.getTime() - job.updatedAt.getTime()) / 1000),
    );
    return exportSpan(
      'order_export.run',
      { exportId, shopId: claimed.shopId, attempt: claimed.attempt },
      () => this.execute(claimed, holder, now),
    );
  }

  /** Extends the lease of every run of this process and notices a cancel or a lost lease (also called by tests). */
  async heartbeatTick(): Promise<void> {
    for (const run of [...this.active.values()]) {
      try {
        const state = await this.jobs.readLease(run.exportId, run.holder);
        if (!state || state.status === 'CANCELLED') {
          this.stop(run, 'cancelled');
        } else if (!state.leaseValid) {
          this.stop(run, 'lost');
        } else if (
          !(await this.jobs.heartbeat(
            run.exportId,
            run.holder,
            this.leaseEnd(this.clock.now()),
          ))
        ) {
          this.stop(run, 'lost');
        }
      } catch (error) {
        // The next tick tries again; a lease that really lapses is noticed by the fenced writes.
        this.logger.warn(
          `order_export_heartbeat_failed: ${(error as Error).name}`,
        );
      }
    }
  }

  private leaseEnd(from: Date): Date {
    return new Date(from.getTime() + this.config.leaseSec * 1000);
  }

  private stop(run: ActiveRun, reason: StopReason): void {
    if (run.stop) return;
    run.stop = reason;
    run.controller.abort();
    void run.sink?.abort(reason).catch(() => undefined);
  }

  private async execute(
    job: ExportJobRecord,
    holder: string,
    startedAt: Date,
  ): Promise<RunOutcome> {
    const run: ActiveRun = {
      exportId: job.id,
      holder,
      key: `exports/${job.shopId}/${job.id}/attempt-${job.attempt}-${holder}.csv`,
      startedAt,
      controller: new AbortController(),
      stop: null,
      sink: null,
      rowsWritten: 0,
      bytesWritten: 0,
      totalRows: 0,
      lastEventAtMs: null,
    };
    this.active.set(holder, run);
    this.logger.log({
      event: 'order_export_started',
      exportId: job.id,
      shopId: job.shopId,
      attempt: job.attempt,
    });
    try {
      let bytes: number;
      try {
        const total = await this.tagged(
          () => this.lines.count(job.shopId, job.createdAt),
          databaseErrorClass,
        );
        run.totalRows = total;
        await this.persist(run, { totalRows: total });
        if (total > this.config.rowLimit)
          throw new RunError('row_limit_exceeded');
        run.sink = await this.files.open(run.key, {
          inactivityMs: this.config.storageInactivitySec * 1000,
        });
        await pipeline(this.chunks(job, run), run.sink.stream);
        bytes = (await run.sink.done).bytes;
      } catch (error) {
        return await this.failed(job, run, error);
      }
      return await this.complete(job, run, bytes);
    } finally {
      this.active.delete(holder);
    }
  }

  /**
   * The completing commit: status, history and the finished event in one fenced transaction. When the commit itself
   * fails the export stays `RUNNING` (nothing is written, our object is removed) and the error reaches the queue; the
   * lease lapses and recovery runs the export again.
   */
  private async complete(
    job: ExportJobRecord,
    run: ActiveRun,
    bytes: number,
  ): Promise<RunOutcome> {
    const finishedAt = this.clock.now();
    let finished: boolean;
    try {
      finished = await this.jobs.finish({
        exportId: job.id,
        leaseHolder: run.holder,
        to: 'DONE',
        fileKey: run.key,
        rowsWritten: run.rowsWritten,
        bytesWritten: bytes,
        now: finishedAt,
        expiresAt: new Date(
          finishedAt.getTime() + this.config.fileRetentionDays * 86_400_000,
        ),
      });
    } catch (error) {
      await this.discard(run);
      this.logger.error({
        event: 'order_export_commit_failed',
        exportId: job.id,
        shopId: job.shopId,
      });
      throw error;
    }
    if (!finished) {
      // Cancelled or fenced between the last byte and the commit: our attempt object belongs to nobody.
      await this.discard(run);
      const state = await this.jobs.readLease(job.id, run.holder);
      return state?.status === 'CANCELLED' ? 'cancelled' : 'lost';
    }
    exportFinishedCounter.add(1, { status: 'DONE' });
    exportLinesCounter.add(run.rowsWritten);
    exportBytesCounter.add(bytes);
    exportDurationHistogram.record(this.elapsedSeconds(run));
    this.logger.log({
      event: 'order_export_finished',
      exportId: job.id,
      shopId: job.shopId,
      attempt: job.attempt,
      status: 'DONE',
      rows: run.rowsWritten,
      bytes,
      durationMs: this.clock.now().getTime() - run.startedAt.getTime(),
    });
    this.live.publish(job.id, {
      type: 'done',
      rowsWritten: run.rowsWritten,
      bytesWritten: bytes,
    });
    return 'done';
  }

  private elapsedSeconds(run: ActiveRun): number {
    return Math.max(
      0,
      (this.clock.now().getTime() - run.startedAt.getTime()) / 1000,
    );
  }

  private async failed(
    job: ExportJobRecord,
    run: ActiveRun,
    error: unknown,
  ): Promise<RunOutcome> {
    await this.discard(run);
    const stopped =
      error instanceof StopRun ? error.reason : (run.stop ?? null);
    if (stopped) return this.stopped(job, run, stopped);
    const errorClass =
      error instanceof RunError ? error.errorClass : storageErrorClass(error);
    const decision = classify(errorClass, job.attempt);
    if (decision.retry) {
      const requeued = await this.jobs.requeue({
        exportId: job.id,
        leaseHolder: run.holder,
        reason: 'retry',
        restoreAttempt: false,
        now: this.clock.now(),
      });
      if (!requeued) return 'lost';
      exportRetriesCounter.add(1, { code: decision.code });
      this.logger.warn({
        event: 'order_export_retry',
        exportId: job.id,
        shopId: job.shopId,
        attempt: job.attempt,
        code: decision.code,
      });
      await this.sendLater(job.id, backoffSeconds());
      return 'retry';
    }
    const finished = await this.jobs.finish({
      exportId: job.id,
      leaseHolder: run.holder,
      to: 'FAILED',
      failureCode: decision.code,
      rowsWritten: run.rowsWritten,
      bytesWritten: run.bytesWritten,
      now: this.clock.now(),
    });
    if (!finished) return 'lost';
    exportFinishedCounter.add(1, { status: 'FAILED' });
    exportDurationHistogram.record(this.elapsedSeconds(run));
    this.logger.error({
      event: 'order_export_failed',
      exportId: job.id,
      shopId: job.shopId,
      attempt: job.attempt,
      code: decision.code,
      errorClass,
    });
    this.live.publish(job.id, { type: 'failed', code: decision.code });
    return 'failed';
  }

  private async stopped(
    job: ExportJobRecord,
    run: ActiveRun,
    reason: StopReason,
  ): Promise<RunOutcome> {
    if (reason === 'shutdown') {
      const released = await this.jobs.requeue({
        exportId: job.id,
        leaseHolder: run.holder,
        reason: 'shutdown',
        restoreAttempt: true,
        now: this.clock.now(),
      });
      if (released) await this.sendLater(job.id, 0);
      return 'shutdown';
    }
    return reason === 'cancelled' ? 'cancelled' : 'lost';
  }

  private async sendLater(
    exportId: string,
    delaySeconds: number,
  ): Promise<void> {
    try {
      await this.queue.enqueue(
        exportId,
        delaySeconds > 0 ? { delaySeconds } : undefined,
      );
    } catch (error) {
      // The export is QUEUED; the recovery job sends the message again after the unclaimed window.
      this.logger.error(
        `order_export_requeue_failed exportId=${exportId}: ${(error as Error).name}`,
      );
    }
  }

  /** Aborts the upload and removes this attempt's object; neither may fail the handling of the failure (L-016). */
  private async discard(run: ActiveRun): Promise<void> {
    try {
      await run.sink?.abort();
    } catch {
      /* the upload is already gone */
    }
    try {
      await this.files.delete(run.key);
    } catch (error) {
      this.logger.warn(
        `order_export_attempt_object_not_deleted: ${(error as Error).name}`,
      );
    }
  }

  /** Runs a collaborator call and tags its failure with the error class of the stage. */
  private async tagged<T>(
    call: () => Promise<T>,
    classOf: (error: unknown) => string,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof RunError || error instanceof StopRun) throw error;
      throw new RunError(classOf(error), error);
    }
  }

  /** Writes the counters if the lease still holds (the fence); `false` ends the run as lost. */
  private async persist(
    run: ActiveRun,
    extra: { totalRows?: number } = {},
  ): Promise<void> {
    const held = await this.tagged(
      () =>
        this.jobs.recordProgress(run.exportId, run.holder, {
          rowsWritten: run.rowsWritten,
          bytesWritten: run.bytesWritten,
          ...extra,
        }),
      databaseErrorClass,
    );
    if (held) return;
    // The fence refused the write: the export was cancelled, or another worker owns it now.
    const state = await this.jobs.readLease(run.exportId, run.holder);
    throw new StopRun(
      run.stop ?? (state?.status === 'CANCELLED' ? 'cancelled' : 'lost'),
    );
  }

  /** The CSV as the pipeline's source: pulled only when the sink took the previous chunk (backpressure). */
  private async *chunks(
    job: ExportJobRecord,
    run: ActiveRun,
  ): AsyncGenerator<string> {
    const head = CSV_BOM + EXPORT_HEADER;
    run.bytesWritten += Buffer.byteLength(head);
    yield head;
    const batches = this.lines
      .batches(job.shopId, job.createdAt, null, this.config.batchSize)
      [Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await this.tagged(
          () => batches.next(),
          databaseErrorClass,
        );
        if (next.done) return;
        const batch = next.value;
        await this.boundary(run);
        const info = await this.tagged(
          () =>
            this.skus.lookup(job.shopId, [
              ...new Set(batch.map((r) => r.productId)),
            ]),
          catalogErrorClass,
        );
        const text = batch
          .map((r) => encodeRecord(toExportRow(r, info)))
          .join('');
        run.rowsWritten += batch.length;
        run.bytesWritten += Buffer.byteLength(text);
        await this.progress(
          run,
          batch.length < this.config.batchSize ||
            run.rowsWritten >= run.totalRows,
        );
        yield text;
      }
    } catch (error) {
      if (error instanceof RunError || error instanceof StopRun) throw error;
      throw new RunError('internal_error', error);
    } finally {
      await batches.return?.();
    }
  }

  /** At every batch: cancel, lost lease, shutdown and the run deadline end the run here. */
  private async boundary(run: ActiveRun): Promise<void> {
    if (run.stop) throw new StopRun(run.stop);
    const state = await this.tagged(
      () => this.jobs.readLease(run.exportId, run.holder),
      databaseErrorClass,
    );
    if (!state || state.status === 'CANCELLED') throw new StopRun('cancelled');
    if (!state.leaseValid) throw new StopRun('lost');
    if (
      this.clock.now().getTime() - run.startedAt.getTime() >
      this.config.deadlineSec * 1000
    )
      throw new RunError('deadline_exceeded');
  }

  /** Counters are stored and published at the same cadence (at most once a second, first and last always). */
  private async progress(run: ActiveRun, isLast: boolean): Promise<void> {
    const nowMs = this.clock.now().getTime();
    if (!shouldPublishProgress(nowMs, run.lastEventAtMs, isLast)) return;
    run.lastEventAtMs = nowMs;
    await this.persist(run);
    this.live.publish(run.exportId, {
      type: 'progress',
      rowsWritten: run.rowsWritten,
      totalRows: run.totalRows,
      bytesWritten: run.bytesWritten,
    });
  }
}

function toExportRow(
  row: RawExportRow,
  info: Map<string, ExportSkuInfo>,
): ExportRow {
  const known = info.get(row.productId);
  return {
    ...row,
    sku: known?.sku ?? null,
    title: resolveTitle(row.title, known?.title),
    lineTotalMinor: resolveLineTotalMinor(
      row.lineTotalMinor,
      row.quantity,
      row.unitPriceMinor,
      row.discountMinor,
    ),
  };
}

/** A failure that is neither ours nor stopped came from the sink: the upload failed, stalled or was aborted. */
function storageErrorClass(error: unknown): string {
  if (error instanceof StorageStalledError) return 'storage_inactivity_timeout';
  if (error instanceof StorageAbortedError) return 'upload_aborted';
  return 'storage_error';
}

/** 60 s ± 20 %, an integer within the queue's 900 s limit. */
function backoffSeconds(): number {
  const jittered = Math.round(RETRY_DELAY_SEC * (0.8 + Math.random() * 0.4));
  return Math.min(jittered, MAX_QUEUE_DELAY_SEC);
}

export type { ExportFailureCode };
