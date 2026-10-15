import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { STATEMENTS_CONFIG, type StatementsConfig } from '../domain/config';
import { CSV_HEADER, csvInteger, csvRow, csvText } from '../domain/csv';
import { knownAtInFuture, monthNotAvailable } from '../domain/errors';
import { isMonthAvailable } from '../domain/period';
import {
  ADJUSTMENT_REPOSITORY,
  EXPORT_SOURCE,
  PERIOD_REPOSITORY,
  STOP_SIGNAL,
  type AdjustmentRepository,
  type ExportSource,
  type PeriodRepository,
  type StopSignal,
} from '../domain/ports';
import { trimMicros } from '../domain/recorded-instant';

export interface ExportPlan {
  filename: string;
  /** The CSV, a chunk per database batch (at most `STATEMENTS_EXPORT_BATCH` lines each); the first carries the header. */
  chunks: AsyncGenerator<string>;
}

export class ExportStopped extends Error {
  constructor() {
    super('statement export stopped');
    this.name = 'ExportStopped';
  }
}

/**
 * The statement as a CSV (S16 FR-038..FR-041): the month's own sale lines in `paidAt, orderId, lineId` order, then the
 * adjustments booked in the month. A closed month is priced as of its snapshot cutoff, so the file never changes after
 * a later rate change; `knownAt` prices the lines as known then. Validation happens here, before any byte is sent.
 */
@Injectable()
export class StatementExportService {
  constructor(
    @Inject(EXPORT_SOURCE) private readonly source: ExportSource,
    @Inject(ADJUSTMENT_REPOSITORY) private readonly adjustments: AdjustmentRepository,
    @Inject(PERIOD_REPOSITORY) private readonly periods: PeriodRepository,
    @Inject(STATEMENTS_CONFIG) private readonly config: StatementsConfig,
    @Inject(STOP_SIGNAL) private readonly stop: StopSignal,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async prepare(
    shopId: string,
    month: string,
    knownAtText?: string,
  ): Promise<ExportPlan> {
    const now = this.clock.now();
    if (!isMonthAvailable(month, now)) throw monthNotAvailable();
    const knownAt = knownAtText ? new Date(knownAtText) : undefined;
    if (knownAt && knownAt.getTime() > now.getTime()) throw knownAtInFuture();

    const period = await this.periods.find(month);
    const frozen = !knownAt && period?.status === 'CLOSED';
    const pricedAt = knownAt ?? (frozen ? period!.knowledgeCutoff! : now);
    return {
      filename: `statement-${shopId}-${month}.csv`,
      chunks: this.lines(shopId, month, pricedAt, frozen, knownAt),
    };
  }

  private async *lines(
    shopId: string,
    month: string,
    pricedAt: Date,
    appliedBy: boolean,
    knownAt: Date | undefined,
  ): AsyncGenerator<string> {
    let after: { paidAt: string; orderId: string; lineId: string } | null = null;
    let header = true;
    for (;;) {
      if (this.stop.isStopping()) throw new ExportStopped();
      const rows = await this.source.saleBatch({
        shopId,
        month,
        knownAt: pricedAt,
        appliedBy,
        after,
        limit: this.config.exportBatch,
        timeoutMs: this.config.exportTimeoutMs,
      });
      let chunk = header ? CSV_HEADER : '';
      header = false;
      for (const row of rows)
        chunk += csvRow([
          csvText('sale'),
          csvText(row.orderId),
          csvText(row.lineId),
          csvText(trimMicros(row.paidAt)),
          csvText(row.productId),
          csvText(row.category),
          csvInteger(row.quantity),
          csvInteger(row.unitPriceMinor),
          csvInteger(row.lineTotalMinor),
          csvInteger(row.rateBps),
          csvInteger(row.commissionMinor),
          '',
          '',
          '',
        ]);
      if (chunk) yield chunk;
      if (rows.length < this.config.exportBatch) break;
      const last = rows[rows.length - 1];
      after = { paidAt: last.paidAt, orderId: last.orderId, lineId: last.lineId };
    }

    const booked = await this.adjustments.forShop(shopId, {
      bookedMonth: month,
      createdAtOrBefore: knownAt,
    });
    if (booked.length === 0) return;
    let chunk = '';
    for (const a of booked)
      chunk += csvRow([
        csvText('adjustment'),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        csvInteger(a.grossDeltaMinor),
        '',
        csvInteger(a.commissionDeltaMinor),
        csvText(a.refersToMonth),
        csvText(a.bookedMonth),
        csvText(`${a.causeKind}:${a.causeRef}`),
      ]);
    yield chunk;
  }
}
