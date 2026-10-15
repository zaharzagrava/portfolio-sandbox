import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { STATEMENTS_CONFIG, type StatementsConfig } from '../domain/config';
import {
  monthNotAvailable,
  periodClosed,
  periodClosing,
  periodNotEnded,
  periodNotReady,
  previousPeriodOpen,
} from '../domain/errors';
import {
  periodCloseCounter,
  periodCloseDuration,
  unpricedLinesCounter,
} from '../domain/metrics';
import {
  FIRST_MONTH,
  hasEnded,
  monthBounds,
  monthOf,
  nextMonth,
  previousMonth,
} from '../domain/period';
import {
  FACT_STREAMS,
  PERIOD_REPOSITORY,
  SNAPSHOT_REPOSITORY,
  STATEMENT_READER,
  STOP_SIGNAL,
  type PeriodRepository,
  type SnapshotRepository,
  type StatementReader,
  type StopSignal,
} from '../domain/ports';
import { PeriodClosed } from './events/statements-events';
import { WatermarkService } from './watermark.service';
import './statements.job-types';

export type CloseRunOutcome = 'completed' | 'stopped' | 'skipped' | 'failed';

/** Tests inject a fault after the Nth batch (a crash between batches, AS-36); production never sets it. */
export const CLOSE_FAULT = Symbol('CLOSE_FAULT');
export type CloseFault = (batchesWritten: number) => void;

const RETRY_NOT_READY_MS = 15 * 60_000;

/**
 * Period close (S16 FR-020..FR-026, research R-4): `OPEN -> CLOSING` when requested (cutoff fixed, run recorded, job
 * queued, all in one transaction), snapshots in bounded batches that stay invisible until the period is `CLOSED`, and
 * one final transaction that flips the state, records the history, writes `statements.period_closed` and queues the
 * follow-up work. A failed run leaves nothing visible and the period `OPEN`.
 */
@Injectable()
export class PeriodCloseService {
  private readonly logger = new Logger(PeriodCloseService.name);

  constructor(
    private readonly runner: TransactionRunner,
    @Inject(PERIOD_REPOSITORY) private readonly periods: PeriodRepository,
    @Inject(SNAPSHOT_REPOSITORY) private readonly snapshots: SnapshotRepository,
    @Inject(STATEMENT_READER) private readonly reader: StatementReader,
    private readonly watermarks: WatermarkService,
    private readonly jobs: JobsService,
    private readonly outbox: OutboxService,
    @Inject(STATEMENTS_CONFIG) private readonly config: StatementsConfig,
    @Inject(STOP_SIGNAL) private readonly stop: StopSignal,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CLOSE_FAULT) private readonly fault: { after?: CloseFault },
  ) {}

  /**
   * Asks for the close of `month`. Checks run in the order of the contract: state, ended, previous months, facts
   * complete. `enqueue: false` is for the scheduled run, which runs the close itself right after.
   */
  async request(
    month: string,
    actor: string,
    options: { enqueue?: boolean } = {},
  ): Promise<{ month: string; status: 'CLOSING'; runId: string }> {
    const now = this.clock.now();
    if (month < FIRST_MONTH) throw monthNotAvailable();
    const runId = uuidv7();
    return this.runner.run(async () => {
      await this.periods.ensureRow(month);
      const period = await this.periods.find(month);
      if (period?.status === 'CLOSED') throw periodClosed();
      if (period?.status === 'CLOSING') throw periodClosing();
      if (!hasEnded(month, now)) throw periodNotEnded();
      const blocking = await this.blockingMonth(month);
      if (blocking) throw previousPeriodOpen(blocking);
      await this.assertFactsComplete(month);

      const won = await this.periods.requestClose(month, now, runId);
      if (!won)
        throw (await this.periods.statusOf(month)) === 'CLOSED'
          ? periodClosed()
          : periodClosing();
      await this.periods.createRun({
        runId,
        month,
        knowledgeCutoff: now,
        startedAt: now,
      });
      await this.periods.recordHistory({
        month,
        from: 'OPEN',
        to: 'CLOSING',
        runId,
        actor,
        at: now,
      });
      if (options.enqueue !== false)
        await this.jobs.enqueue(
          'statements.close-month',
          { month, runId },
          { idempotencyKey: `close:${month}:${runId}` },
        );
      return { month, status: 'CLOSING' as const, runId };
    });
  }

  /** The oldest month, up to the previous UTC month, that still needs closing (`null` when nothing is due). */
  async oldestDueMonth(): Promise<string | null> {
    const earliest = await this.periods.earliestFactMonth();
    const last = previousMonth(monthOf(this.clock.now()));
    if (!earliest || earliest > last) return null;
    const states = await this.periods.statesBetween(earliest, last);
    for (let m = earliest; m <= last; m = nextMonth(m))
      if ((states.get(m) ?? 'OPEN') !== 'CLOSED') return m;
    return null;
  }

  /**
   * The scheduled close: without a month, the oldest due month, then the next, until none is due or one cannot be
   * closed yet (facts incomplete: tried again later with backoff, never closed early). A month already being closed
   * by another worker is skipped; a `CLOSING` month left by a crash is resumed.
   */
  async closeDue(
    month: string | undefined,
    signalStop: () => boolean,
  ): Promise<void> {
    const now = this.clock.now();
    if (month && !hasEnded(month, now)) throw periodNotEnded();
    for (let guard = 0; guard < 200; guard++) {
      if (signalStop()) return;
      const target = month ?? (await this.oldestDueMonth());
      if (!target) return;
      const period = await this.periods.find(target);
      let runId = period?.runId ?? null;
      if (period?.status === 'CLOSED') return;
      if (period?.status !== 'CLOSING') {
        try {
          runId = (
            await this.request(target, 'system:schedule', { enqueue: false })
          ).runId;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === 'period_closing' || code === 'period_closed') return;
          if (code === 'period_not_ready') {
            await this.retryLater(target);
            periodCloseCounter.add(1, { status: 'not_ready' });
            return;
          }
          throw error;
        }
      }
      const outcome = await this.run(target, runId!, signalStop);
      if (outcome !== 'completed' || month) return;
    }
  }

  private async retryLater(month: string): Promise<void> {
    const now = this.clock.now();
    const bucket = Math.floor(now.getTime() / RETRY_NOT_READY_MS);
    await this.jobs.enqueue(
      'statements.close-month',
      { month },
      {
        runAt: new Date(now.getTime() + RETRY_NOT_READY_MS),
        idempotencyKey: `close-retry:${month}:${bucket}`,
      },
    );
  }

  /** Writes the snapshots of a `CLOSING` month under its persisted cutoff and finalises it; safe to repeat. */
  async run(
    month: string,
    runId: string,
    signalStop: () => boolean = () => false,
  ): Promise<CloseRunOutcome> {
    const period = await this.periods.find(month);
    if (!period || period.status !== 'CLOSING' || period.runId !== runId)
      return 'skipped';
    const cutoff = period.knowledgeCutoff!;
    const startedAt = this.clock.nowMs();

    const unpriced = await this.reader.countUnpriced(month, cutoff);
    if (unpriced > 0) {
      await this.fail(month, runId, 'unpriced_lines', { count: unpriced });
      unpricedLinesCounter.add(unpriced);
      return 'failed';
    }

    let after: string | null = null;
    let batches = 0;
    let shops = 0;
    for (;;) {
      if (signalStop() || this.stop.isStopping()) {
        periodCloseCounter.add(1, { status: 'interrupted' });
        return 'stopped';
      }
      const rows = await this.reader.aggregateShops(
        month,
        cutoff,
        after,
        this.config.snapshotBatch,
      );
      if (rows.length === 0) break;
      await this.runner.run(async () => {
        await this.snapshots.writeBatch(
          month,
          rows,
          cutoff,
          runId,
          this.clock.now(),
        );
        await this.periods.progressRun(runId, batches + 1, shops + rows.length);
      });
      batches++;
      shops += rows.length;
      this.fault.after?.(batches);
      after = rows[rows.length - 1].shopId;
      if (rows.length < this.config.snapshotBatch) break;
    }

    const closed = await this.runner.run(async () => {
      const written = await this.snapshots.countForMonth(month);
      if (written !== shops) return { mismatch: written };
      const closedAt = this.clock.now();
      if (!(await this.periods.finish(month, runId, shops, closedAt)))
        return { skipped: true };
      await this.periods.recordHistory({
        month,
        from: 'CLOSING',
        to: 'CLOSED',
        runId,
        actor: 'system:close',
        at: closedAt,
      });
      await this.periods.finishRun(runId, 'COMPLETED', null, null, closedAt);
      await this.outbox.append(
        PeriodClosed.create(month, 1, {
          month,
          knowledgeCutoff: cutoff.toISOString(),
          shopCount: shops,
          runId,
          closedAt: closedAt.toISOString(),
        }),
      );
      await this.jobs.enqueue(
        'statements.reconcile-month',
        { month, cause: `close:${runId}` },
        { idempotencyKey: `close:${runId}:${month}` },
      );
      await this.jobs.enqueue(
        'statements.verify-period',
        { month },
        { idempotencyKey: `verify:${runId}` },
      );
      return { done: true };
    });
    if ('mismatch' in closed) {
      await this.fail(month, runId, 'snapshot_count_mismatch', {
        expected: shops,
        written: closed.mismatch,
      });
      return 'failed';
    }
    if ('skipped' in closed) return 'skipped';
    periodCloseCounter.add(1, { status: 'completed' });
    periodCloseDuration.record((this.clock.nowMs() - startedAt) / 1000);
    this.logger.log(
      `closed ${month} run ${runId}: ${shops} shops in ${batches} batches`,
    );
    return 'completed';
  }

  private async fail(
    month: string,
    runId: string,
    code: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.runner.run(async () => {
      const at = this.clock.now();
      await this.snapshots.deleteForMonth(month);
      if (await this.periods.reopen(month, runId))
        await this.periods.recordHistory({
          month,
          from: 'CLOSING',
          to: 'OPEN',
          runId,
          actor: 'system:close',
          at,
        });
      await this.periods.finishRun(runId, 'FAILED', code, details, at);
    });
    periodCloseCounter.add(1, { status: 'failed' });
    this.logger.warn(`close of ${month} run ${runId} failed: ${code}`);
  }

  /** The oldest month, from the first fact on, before `month` that is not closed. */
  private async blockingMonth(month: string): Promise<string | null> {
    const earliest = await this.periods.earliestFactMonth();
    if (!earliest || earliest >= month) return null;
    const states = await this.periods.statesBetween(
      earliest,
      previousMonth(month),
    );
    for (let m = earliest; m < month; m = nextMonth(m))
      if ((states.get(m) ?? 'OPEN') !== 'CLOSED') return m;
    return null;
  }

  private async assertFactsComplete(month: string): Promise<void> {
    const needed =
      monthBounds(month).end.getTime() + this.config.closeMarginMin * 60_000;
    const marks = await this.watermarks.read();
    for (const stream of FACT_STREAMS) {
      const mark = marks[stream];
      if (mark === null || mark.getTime() < needed)
        throw periodNotReady(stream, mark ? mark.toISOString() : null);
    }
  }
}
