import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ScannerUnavailableError } from '@app/infrastructure/antivirus';
import {
  ImportBatcher,
  type BatchRecord,
  type BatchWindow,
} from '../domain/import-batcher';
import {
  ImportFailureError,
  ImportInterruptedError,
  LeaseLostError,
  type ImportFailureCode,
} from '../domain/import-errors';
import { reportLines } from '../domain/error-report';
import {
  IMPORT_CONFIG,
  IMPORT_LIMITS,
  type ImportConfig,
} from '../domain/import-limits';
import {
  checkHeader,
  parseRecord,
  unknownKeys,
  type RowProblem,
} from '../domain/import-row';
import { SNIFF_WINDOW_BYTES, sniff } from '../domain/import-sniff';
import {
  IMPORT_CATALOG,
  IMPORT_PIPELINE,
  IMPORT_PUBLISHER,
  IMPORT_REPOSITORY,
  IMPORT_SCANNER,
  IMPORT_SHOP_STATUS,
  IMPORT_STORAGE,
  ImportSourceMissingError,
  type ImportCatalogGateway,
  type ImportJobRecord,
  type ImportPipelinePort,
  type ImportPublisherPort,
  type ImportRepository,
  type ImportScannerPort,
  type ImportShopStatusPort,
  type ImportStoragePort,
  type ParsedRecord,
} from '../domain/ports';
import { importMetrics } from './import-metrics';

/** What became of one queue message. Everything but `busy` is acknowledged; `busy` is handed back with a delay. */
export type ImportRunOutcome =
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'final'
  | 'held'
  | 'busy'
  | 'lost'
  | 'interrupted';

/** The cancel request was seen at a batch boundary: stop, keep what was written. */
class CancelRequested extends Error {
  constructor() {
    super('cancel requested');
    this.name = 'CancelRequested';
  }
}

interface ActiveRun {
  importId: string;
  controller: AbortController;
  done: Promise<unknown>;
}

const sourceHead = async (stream: Readable, bytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= bytes) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, bytes);
};

/**
 * The run of one import (S07 D-02, D-06, D-16, D-17, D-22). It claims a renewable lease, scans the file (fail closed),
 * sniffs it, then reads it as a stream from the stored byte offset in windows of 500 records: each window is written
 * through the catalog's import command, its error lines are stored under a batch-keyed object, and one fenced commit
 * stores the counters and the checkpoint together; progress is published after the commit. A runner that lost its lease
 * commits nothing. Failures are retried only by queue redelivery; a permanent one ends the import at once with a stable
 * code. Storage side effects of a final status (delete the source, join the report) are idempotent and follow it.
 */
@Injectable()
export class ImportRunnerService implements OnModuleDestroy {
  private readonly logger = new Logger(ImportRunnerService.name);
  private readonly active = new Map<string, ActiveRun>();
  private stopping = false;

  constructor(
    @Inject(IMPORT_REPOSITORY) private readonly repo: ImportRepository,
    @Inject(IMPORT_STORAGE) private readonly storage: ImportStoragePort,
    @Inject(IMPORT_SCANNER) private readonly scanner: ImportScannerPort,
    @Inject(IMPORT_CATALOG) private readonly catalog: ImportCatalogGateway,
    @Inject(IMPORT_PUBLISHER) private readonly live: ImportPublisherPort,
    @Inject(IMPORT_SHOP_STATUS) private readonly shops: ImportShopStatusPort,
    @Inject(IMPORT_PIPELINE) private readonly pipeline: ImportPipelinePort,
    @Inject(IMPORT_CONFIG) private readonly config: ImportConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Handles one delivery. `deliveries` is the queue's receive count. Returns what became of the message, or throws to
   * have the queue redeliver it (a retryable failure within the budget, or the delivery that spent it, after the
   * terminal failure was recorded).
   */
  async handle(
    importId: string,
    deliveries: number,
  ): Promise<ImportRunOutcome> {
    if (this.stopping) throw new ImportInterruptedError();
    const holder = randomUUID();
    const claim = await this.repo.claim({
      importId,
      leaseHolder: holder,
      now: this.clock.now(),
      leaseMs: IMPORT_LIMITS.leaseMs,
    });
    switch (claim.kind) {
      case 'missing':
        // an unknown job: retried, then dead-lettered (AS-41)
        throw new Error(`import ${importId} not found`);
      case 'final':
        importMetrics.deliveries.add(1, { result: 'final' });
        return 'final';
      case 'held':
        importMetrics.deliveries.add(1, { result: 'held' });
        return 'held';
      case 'busy':
        importMetrics.deliveries.add(1, { result: 'busy' });
        return 'busy';
      case 'claimed':
        break;
    }
    const controller = new AbortController();
    const run: ActiveRun = {
      importId,
      controller,
      done: Promise.resolve(),
    };
    const work = this.run(claim.job, holder, deliveries, controller);
    run.done = work.catch(() => undefined);
    this.active.set(importId, run);
    try {
      return await work;
    } finally {
      this.active.delete(importId);
    }
  }

  /** Tells every run to stop at a consistent point and waits for them (AS-39). */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const run of this.active.values())
      run.controller.abort(new ImportInterruptedError());
    await Promise.all([...this.active.values()].map((r) => r.done));
  }

  onModuleDestroy(): Promise<void> {
    return this.shutdown();
  }

  private async run(
    start: ImportJobRecord,
    holder: string,
    deliveries: number,
    controller: AbortController,
  ): Promise<ImportRunOutcome> {
    const state = { job: start, status: start.status };
    const heartbeat = setInterval(() => {
      void this.repo
        .renewLease(start.id, holder, this.clock.now(), IMPORT_LIMITS.leaseMs)
        .then((ok) => {
          if (!ok) controller.abort(new LeaseLostError(start.id));
        })
        .catch(() => undefined);
    }, IMPORT_LIMITS.leaseRenewMs);
    heartbeat.unref();
    try {
      importMetrics.queueToStartSeconds.record(
        Math.max(
          0,
          (this.clock.now().getTime() - start.createdAt.getTime()) / 1000,
        ),
      );
      this.logger.log({
        action: 'import.run_started',
        importId: start.id,
        shopId: start.shopId,
        status: start.status,
        resumeFromByte: start.nextByteOffset,
      });
      if (start.cancelRequestedAt) throw new CancelRequested();
      if (!(await this.shops.isActive(start.shopId)))
        throw new ImportFailureError('shop_not_active');
      if (state.status === 'SCANNING')
        await this.scan(state, holder, controller.signal);
      await this.process(state, holder, controller);
      return await this.finish(state, holder);
    } catch (error) {
      return await this.settle(state, holder, deliveries, controller, error);
    } finally {
      clearInterval(heartbeat);
      await this.repo.releaseLease(start.id, holder).catch(() => undefined);
    }
  }

  private async scan(
    state: { job: ImportJobRecord; status: ImportJobRecord['status'] },
    holder: string,
    signal: AbortSignal,
  ): Promise<void> {
    const job = state.job;
    const began = this.clock.now().getTime();
    const source = await this.storage.openSource(job.storageKey, 0, signal);
    const verdict = await this.scanner.scan(source, { signal });
    importMetrics.scanSeconds.record(
      Math.max(0, (this.clock.now().getTime() - began) / 1000),
    );
    if (verdict.kind === 'infected') {
      // the signature name belongs in the logs and nowhere else (AS-22)
      this.logger.warn({
        action: 'import.malware_detected',
        importId: job.id,
        shopId: job.shopId,
        signature: verdict.signature,
      });
      throw new ImportFailureError('malware_detected');
    }
    if (verdict.scan === 'skipped')
      this.logger.warn({
        action: 'import.scan_skipped',
        importId: job.id,
        shopId: job.shopId,
      });
    const moved = await this.repo.transition({
      importId: job.id,
      from: 'SCANNING',
      to: 'PROCESSING',
      scan: verdict.scan,
      leaseHolder: holder,
      now: this.clock.now(),
    });
    if (!moved) throw new LeaseLostError(job.id);
    state.job = moved;
    state.status = 'PROCESSING';
    // a cancel asked for while the file was being scanned is honoured before any row is read (AS-56)
    if (moved.cancelRequestedAt) throw new CancelRequested();
  }

  private async process(
    state: { job: ImportJobRecord; status: ImportJobRecord['status'] },
    holder: string,
    controller: AbortController,
  ): Promise<void> {
    const job = state.job;
    const signal = controller.signal;
    let format = job.format;
    let headerColumns = job.headerColumns;
    let pendingHeader:
      | {
          format: 'csv' | 'jsonl';
          headerColumns: string[] | null;
          ignoredColumns: string[];
        }
      | undefined;

    if (!format) {
      const head = await sourceHead(
        await this.storage.openSource(job.storageKey, 0, signal),
        SNIFF_WINDOW_BYTES,
      );
      const sniffed = sniff(head);
      if (!sniffed.ok) throw new ImportFailureError('unsupported_file_type');
      format = sniffed.format;
    }

    let bytes = job.nextByteOffset;
    const source = await this.storage.openSource(
      job.storageKey,
      job.nextByteOffset,
      signal,
    );
    const resume = job.format !== null;

    let latest = job;
    const batcher = new ImportBatcher(IMPORT_LIMITS.batchSize, job.lastRow);
    const writeWindow = async (window: BatchWindow): Promise<void> => {
      if (signal.aborted) throw signal.reason ?? new ImportInterruptedError();
      const began = process.hrtime.bigint();
      const committed = await this.writeWindow(
        latest,
        holder,
        window,
        pendingHeader,
        signal,
      );
      pendingHeader = undefined;
      latest = committed.job;
      state.job = committed.job;
      bytes = window.nextByteOffset;
      importMetrics.batchSeconds.record(
        Number(process.hrtime.bigint() - began) / 1e9,
      );
      this.live.publish(job.id, {
        type: 'progress',
        processed: latest.rowsProcessed,
        failed: latest.rowsFailed,
        bytesProcessed: latest.bytesProcessed,
        sizeBytes: latest.sizeBytes,
      });
      if (committed.cancelRequested) throw new CancelRequested();
      if (latest.rowsFailed > this.config.errorCap)
        throw new ImportFailureError('too_many_errors');
    };

    await this.pipeline.run({
      source,
      signal,
      format,
      startOffset: job.nextByteOffset,
      startRow: job.lastRow,
      header: resume ? headerColumns : null,
      onHeader: (columns) => {
        const check = checkHeader(columns);
        if (!check.ok) {
          const detail = [
            check.missing.length ? `missing: ${check.missing.join(', ')}` : '',
            check.repeated.length
              ? `repeated: ${check.repeated.join(', ')}`
              : '',
          ]
            .filter(Boolean)
            .join('; ');
          throw new ImportFailureError('invalid_header', detail);
        }
        headerColumns = columns;
        pendingHeader = {
          format: 'csv',
          headerColumns: columns,
          ignoredColumns: check.ignored,
        };
      },
      onKeys: (keys) => {
        pendingHeader = {
          format: 'jsonl',
          headerColumns: null,
          ignoredColumns: unknownKeys(
            Object.fromEntries(keys.map((k) => [k, true])),
          ),
        };
      },
      consume: async (records) => {
        for await (const record of records) {
          const window = batcher.add(this.toBatchRecord(record));
          if (window) await writeWindow(window);
        }
        const tail = batcher.flush();
        if (tail) await writeWindow(tail);
      },
    });
    // a file with no record at all still has a format: store it with the final status via the next commit-less path
    importMetrics.bytesRead.add(Math.max(0, bytes - job.nextByteOffset));
  }

  private toBatchRecord(record: ParsedRecord): BatchRecord {
    if ('oversize' in record)
      return {
        row: record.row,
        byteEnd: record.byteEnd,
        sku: '',
        result: {
          ok: false,
          problems: [{ field: '', code: 'row_too_large' }],
        },
      };
    if ('invalid' in record)
      return {
        row: record.row,
        byteEnd: record.byteEnd,
        sku: '',
        result: {
          ok: false,
          problems: [{ field: '', code: 'invalid_record' }],
        },
      };
    const skuCell = record.values.sku;
    return {
      row: record.row,
      byteEnd: record.byteEnd,
      sku: typeof skuCell === 'string' ? skuCell.trim() : '',
      result: parseRecord(record.values),
    };
  }

  /** One window: the catalog calls, the report part, then the fenced commit. */
  private async writeWindow(
    job: ImportJobRecord,
    holder: string,
    window: BatchWindow,
    header:
      | {
          format: 'csv' | 'jsonl';
          headerColumns: string[] | null;
          ignoredColumns: string[];
        }
      | undefined,
    signal: AbortSignal,
  ): Promise<{ job: ImportJobRecord; cancelRequested: boolean }> {
    const outcomes = new Map<number, 'created' | 'updated' | 'unchanged'>();
    const refused = new Map<number, RowProblem[]>();
    for (const call of window.calls) {
      const results = await this.catalog.upsert(
        job.shopId,
        call.map((c) => c.item),
        signal,
      );
      if (results.length !== call.length)
        throw new Error('catalog answered a different number of items');
      call.forEach((entry, i) => {
        const r = results[i];
        if (r.outcome === 'rejected')
          refused.set(
            entry.row,
            r.errors && r.errors.length > 0
              ? r.errors
              : [{ field: '', code: 'invalid' }],
          );
        else outcomes.set(entry.row, r.outcome);
      });
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    let lines = '';
    let lineCount = 0;
    for (const record of window.records) {
      const problems = record.result.ok
        ? refused.get(record.row)
        : record.result.problems;
      if (problems && problems.length > 0) {
        failed++;
        const out = reportLines({ row: record.row, sku: record.sku, problems });
        lineCount += out.length;
        lines += out.join('');
        continue;
      }
      switch (outcomes.get(record.row)) {
        case 'created':
          created++;
          break;
        case 'updated':
          updated++;
          break;
        default:
          unchanged++;
      }
    }
    // stored before the commit under a batch-keyed object: a committed counter always has its lines, a redone batch
    // replaces its part instead of repeating it
    if (lines !== '')
      await this.storage.putReportPart(
        job.shopId,
        job.id,
        window.batchNumber,
        lines,
        signal,
      );
    if (signal.aborted) throw signal.reason ?? new ImportInterruptedError();

    const committed = await this.repo.commitBatch({
      importId: job.id,
      leaseHolder: holder,
      now: this.clock.now(),
      leaseMs: IMPORT_LIMITS.leaseMs,
      delta: {
        rowsProcessed: window.records.length,
        rowsCreated: created,
        rowsUpdated: updated,
        rowsUnchanged: unchanged,
        rowsFailed: failed,
      },
      lastRow: window.lastRow,
      nextByteOffset: window.nextByteOffset,
      bytesProcessed: window.nextByteOffset,
      errorReportLines: lineCount,
      header,
    });
    if (!committed) throw new LeaseLostError(job.id);
    importMetrics.rows.add(created, { outcome: 'created' });
    importMetrics.rows.add(updated, { outcome: 'updated' });
    importMetrics.rows.add(unchanged, { outcome: 'unchanged' });
    importMetrics.rows.add(failed, { outcome: 'failed' });
    return committed;
  }

  /** The end of the file: join the report, then `PROCESSING -> DONE` with the event, then clean up. */
  private async finish(
    state: { job: ImportJobRecord; status: ImportJobRecord['status'] },
    holder: string,
  ): Promise<ImportRunOutcome> {
    const job = state.job;
    await this.sealReport(job);
    const done = await this.repo.transition({
      importId: job.id,
      from: 'PROCESSING',
      to: 'DONE',
      bytesProcessed: job.sizeBytes,
      leaseHolder: holder,
      now: this.clock.now(),
    });
    if (!done) throw new LeaseLostError(job.id);
    await this.cleanup(done);
    importMetrics.finished.add(1, { status: 'DONE' });
    this.live.publish(done.id, {
      type: 'done',
      rowsProcessed: done.rowsProcessed,
      rowsFailed: done.rowsFailed,
    });
    this.logger.log({
      action: 'import.done',
      importId: done.id,
      shopId: done.shopId,
      rowsProcessed: done.rowsProcessed,
      rowsFailed: done.rowsFailed,
    });
    return 'done';
  }

  /** Joins the batch parts into the one report object and records its key; a no-op when nothing was refused. */
  private async sealReport(job: ImportJobRecord): Promise<void> {
    if (job.errorReportRows === 0 && job.errorReportKey === null) return;
    const key = await this.storage.finaliseReport(job.shopId, job.id);
    if (key) await this.repo.setErrorReportKey(job.id, key);
  }

  private async cleanup(job: ImportJobRecord): Promise<void> {
    await this.storage.deleteObject(job.storageKey).catch((error: unknown) =>
      this.logger.warn({
        action: 'import.source_delete_failed',
        importId: job.id,
        error: (error as Error).name,
      }),
    );
  }

  /**
   * Turns whatever stopped the run into an outcome: a lost lease is silent, a shutdown is redelivered, a cancel and a
   * permanent failure end the import, and anything else is retried by the queue until the delivery budget is spent.
   */
  private async settle(
    state: { job: ImportJobRecord; status: ImportJobRecord['status'] },
    holder: string,
    deliveries: number,
    controller: AbortController,
    raw: unknown,
  ): Promise<ImportRunOutcome> {
    const error = this.cause(raw, controller);
    const job = state.job;
    if (error instanceof LeaseLostError) {
      this.logger.warn({ action: 'import.lease_lost', importId: job.id });
      return 'lost';
    }
    if (error instanceof ImportInterruptedError) {
      this.logger.log({ action: 'import.interrupted', importId: job.id });
      throw error;
    }
    if (error instanceof CancelRequested)
      return this.end(state, holder, 'CANCELLED');
    if (error instanceof ImportSourceMissingError)
      return this.end(state, holder, 'FAILED', 'source_missing');
    if (error instanceof ImportFailureError)
      return this.end(
        state,
        holder,
        'FAILED',
        error.code,
        error.detail,
        error.row,
      );
    // retryable: the queue redelivers; when this delivery spent the budget the terminal failure is recorded first
    const code: ImportFailureCode =
      error instanceof ScannerUnavailableError
        ? 'scan_unavailable'
        : 'internal_error';
    this.logger.error({
      action: 'import.delivery_failed',
      importId: job.id,
      shopId: job.shopId,
      delivery: deliveries,
      error: error instanceof Error ? error.name : 'unknown',
    });
    importMetrics.deliveries.add(1, { result: 'retry' });
    if (deliveries >= IMPORT_LIMITS.deliveryBudget)
      await this.end(state, holder, 'FAILED', code);
    throw error;
  }

  /**
   * An abort carries its reason; a pipeline rejects with an AbortError wrapping it, or with "Premature close" when the
   * abort destroyed a stream before the signal reached the pipeline.
   */
  private cause(raw: unknown, controller: AbortController): unknown {
    const e = raw as { name?: string; code?: string } | null;
    if (
      controller.signal.aborted &&
      (e?.name === 'AbortError' || e?.code === 'ERR_STREAM_PREMATURE_CLOSE')
    )
      return controller.signal.reason ?? raw;
    return raw;
  }

  /** The final status: join what report exists, `-> FAILED|CANCELLED` with the event, then clean up and tell the viewers. */
  private async end(
    state: { job: ImportJobRecord; status: ImportJobRecord['status'] },
    holder: string,
    to: 'FAILED' | 'CANCELLED',
    code?: ImportFailureCode,
    detail?: string,
    row?: number,
  ): Promise<ImportRunOutcome> {
    const job = state.job;
    try {
      await this.sealReport(job);
    } catch (error) {
      this.logger.warn({
        action: 'import.report_seal_failed',
        importId: job.id,
        error: (error as Error).name,
      });
    }
    const text =
      detail ??
      (code === 'malformed_file' && row ? `at record ${row}` : undefined);
    const ended = await this.repo.transition({
      importId: job.id,
      from: state.status as 'SCANNING' | 'PROCESSING',
      to,
      leaseHolder: holder,
      failure: code ? { code, detail: text } : undefined,
      bytesProcessed: to === 'CANCELLED' ? job.bytesProcessed : undefined,
      reason: to === 'CANCELLED' ? 'cancelled_by_user' : undefined,
      now: this.clock.now(),
    });
    if (!ended) return 'lost';
    await this.cleanup(ended);
    importMetrics.finished.add(1, { status: to });
    this.live.publish(
      ended.id,
      to === 'CANCELLED'
        ? { type: 'cancelled' }
        : { type: 'failed', code: code! },
    );
    this.logger.log({
      action: to === 'CANCELLED' ? 'import.cancelled' : 'import.failed',
      importId: ended.id,
      shopId: ended.shopId,
      code,
    });
    return to === 'CANCELLED' ? 'cancelled' : 'failed';
  }
}
