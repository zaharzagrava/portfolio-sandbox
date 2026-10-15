import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { STATEMENTS_CONFIG, type StatementsConfig } from '../domain/config';
import { adjustmentsBookedCounter } from '../domain/metrics';
import { bookingMonth, monthOf, nextMonth } from '../domain/period';
import {
  ADJUSTMENT_REPOSITORY,
  PERIOD_REPOSITORY,
  RATE_REPOSITORY,
  SNAPSHOT_REPOSITORY,
  STATEMENT_READER,
  STOP_SIGNAL,
  type AdjustmentRepository,
  type PeriodRepository,
  type RateRepository,
  type SnapshotRepository,
  type StatementReader,
  type StopSignal,
} from '../domain/ports';
import { isZeroResidual, parseCause, residualOf } from '../domain/residual';
import { ZERO_FIGURES, type OwnFigures } from '../domain/statement-view';
import { AdjustmentBooked } from './events/statements-events';
import './statements.job-types';

export type ShopReconcileOutcome = 'booked' | 'none' | 'duplicate' | 'skipped';

/** Tests inject a failure for one shop (AS-43); production never sets it. */
export const RECONCILE_FAULT = Symbol('RECONCILE_FAULT');
export type ReconcileFault = (shopId: string, month: string) => void;

const RETRY_MS = 60_000;

/**
 * Adjustments (S16 FR-027..FR-032, research R-5). A change that alters what is known about a closed month never edits
 * it: the difference between a fresh recomputation and the frozen snapshot plus every earlier adjustment is booked once
 * per (shop, month, cause) in the earliest open month, with its `statements.adjustment_booked` event in the same
 * transaction. One shop's failure is isolated and retried; the others stay booked.
 */
@Injectable()
export class AdjustmentService {
  private readonly logger = new Logger(AdjustmentService.name);

  constructor(
    private readonly runner: TransactionRunner,
    @Inject(PERIOD_REPOSITORY) private readonly periods: PeriodRepository,
    @Inject(SNAPSHOT_REPOSITORY) private readonly snapshots: SnapshotRepository,
    @Inject(ADJUSTMENT_REPOSITORY) private readonly adjustments: AdjustmentRepository,
    @Inject(STATEMENT_READER) private readonly reader: StatementReader,
    @Inject(RATE_REPOSITORY) private readonly rates: RateRepository,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    @Inject(STATEMENTS_CONFIG) private readonly config: StatementsConfig,
    @Inject(STOP_SIGNAL) private readonly stop: StopSignal,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RECONCILE_FAULT) private readonly fault: { before?: ReconcileFault },
  ) {}

  /**
   * The job body: one shop when `shopId` is given, otherwise every shop with a snapshot for the month, in keyset batches.
   * A shop that fails is queued again for itself and the rest go on.
   */
  async reconcileMonth(
    month: string,
    cause: string,
    shopId: string | undefined,
    signalStop: () => boolean = () => false,
  ): Promise<{ booked: number; failed: number }> {
    if (shopId) {
      const outcome = await this.reconcileShop(shopId, month, cause);
      return { booked: outcome === 'booked' ? 1 : 0, failed: 0 };
    }
    let after: string | null = null;
    let booked = 0;
    let failed = 0;
    for (;;) {
      if (signalStop() || this.stop.isStopping()) break;
      const page = await this.snapshots.page(
        month,
        after,
        this.config.adjustmentShopBatch,
      );
      if (page.length === 0) break;
      for (const snapshot of page) {
        try {
          if ((await this.reconcileShop(snapshot.shopId, month, cause)) === 'booked')
            booked++;
        } catch (error) {
          failed++;
          this.logger.warn(
            `reconcile of ${month} for shop ${snapshot.shopId} failed (${(error as Error).name}); queued again`,
          );
          await this.retryShop(snapshot.shopId, month, cause);
        }
      }
      after = page[page.length - 1].shopId;
      if (page.length < this.config.adjustmentShopBatch) break;
    }
    return { booked, failed };
  }

  private async retryShop(shopId: string, month: string, cause: string) {
    const now = this.clock.now();
    await this.jobs.enqueue(
      'statements.reconcile-month',
      { month, cause, shopId },
      {
        runAt: new Date(now.getTime() + RETRY_MS),
        idempotencyKey: `${cause}:${month}:${shopId}:retry:${Math.floor(now.getTime() / RETRY_MS)}`,
        shopId,
      },
    );
  }

  async reconcileShop(
    shopId: string,
    month: string,
    cause: string,
  ): Promise<ShopReconcileOutcome> {
    const parsed = parseCause(cause);
    return this.runner.run(async () => {
      await this.adjustments.lockShopMonth(shopId, month);
      this.fault.before?.(shopId, month);
      // Only a closed month has something frozen to compare with; a month still closing is reconciled by the close.
      if ((await this.periods.statusOf(month)) !== 'CLOSED') return 'skipped';
      const now = this.clock.now();
      const [snapshot, earlier, fresh] = await Promise.all([
        this.snapshots.find(shopId, month, { primary: true }),
        this.adjustments.forShop(shopId, { refersToMonth: month, primary: true }),
        this.reader.aggregate({ shopId, month, knownAt: now }),
      ]);
      const frozen: OwnFigures = snapshot
        ? {
            grossMinor: snapshot.grossMinor,
            commissionMinor: snapshot.commissionMinor,
            lineCount: snapshot.lineCount,
            payoutsPaidMinor: snapshot.payoutsPaidMinor,
          }
        : ZERO_FIGURES;
      const residual = residualOf(fresh, frozen, earlier);
      if (isZeroResidual(residual)) return 'none';

      const states = await this.periods.statesBetween(
        monthOf(now),
        this.monthsAhead(monthOf(now), 36),
      );
      const booked = bookingMonth(now, states);
      const id = await this.adjustments.insert({
        shopId,
        refersToMonth: month,
        bookedMonth: booked,
        causeKind: parsed.kind,
        causeRef: parsed.ref,
        ...residual,
        reason: await this.reasonFor(cause, parsed),
        createdAt: now,
      });
      if (id === null) return 'duplicate';
      await this.outbox.append(
        AdjustmentBooked.create(id, 1, {
          adjustmentId: id,
          shopId,
          refersToMonth: month,
          bookedMonth: booked,
          causeKind: parsed.kind,
          causeRef: parsed.ref,
          ...residual,
        }),
      );
      adjustmentsBookedCounter.add(1, { cause: parsed.kind });
      return 'booked';
    });
  }

  private monthsAhead(from: string, count: number): string {
    let month = from;
    for (let i = 0; i < count; i++) month = nextMonth(month);
    return month;
  }

  private async reasonFor(cause: string, parsed: ReturnType<typeof parseCause>) {
    if (cause.startsWith('close:')) return 'found by the close of the month';
    if (parsed.kind === 'late_sale') return `late sale ${parsed.ref}`;
    if (parsed.kind === 'late_payout') return `late payout ${parsed.ref}`;
    if (parsed.ref.startsWith('legacy:')) return parsed.ref.slice('legacy:'.length);
    return (await this.rates.reasonOfChange(parsed.ref)) ?? `rate change ${parsed.ref}`;
  }
}
