import { Inject, Injectable } from '@nestjs/common';
import type { Statement, StatementPage } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config';
import { STATEMENTS_CONFIG, type StatementsConfig } from '../domain/config';
import { decodeCursor, encodeCursor } from '../domain/cursor';
import { knownAtInFuture, monthNotAvailable } from '../domain/errors';
import { isMonthAvailable, monthOf } from '../domain/period';
import {
  ADJUSTMENT_REPOSITORY,
  PERIOD_REPOSITORY,
  SNAPSHOT_REPOSITORY,
  STATEMENT_READER,
  type AdjustmentRepository,
  type PeriodRepository,
  type SnapshotRepository,
  type StatementReader,
} from '../domain/ports';
import {
  compose,
  ZERO_FIGURES,
  type OwnFigures,
} from '../domain/statement-view';
import { WatermarkService } from './watermark.service';

/**
 * Seller statement reads (S16 FR-013..FR-018): an open (or closing) month is priced live, a closed month is read from
 * its snapshot without touching facts or rates, and any month can be answered as known at a past instant on both
 * axes. Reads write nothing. Validation that needs the clock (`month_not_available`, `known_at_in_future`) lives here.
 */
@Injectable()
export class StatementService {
  constructor(
    @Inject(STATEMENT_READER) private readonly reader: StatementReader,
    @Inject(SNAPSHOT_REPOSITORY) private readonly snapshots: SnapshotRepository,
    @Inject(ADJUSTMENT_REPOSITORY)
    private readonly adjustments: AdjustmentRepository,
    @Inject(PERIOD_REPOSITORY) private readonly periods: PeriodRepository,
    private readonly watermarks: WatermarkService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STATEMENTS_CONFIG) private readonly limits: StatementsConfig,
  ) {}

  async statement(
    shopId: string,
    month: string,
    knownAtText?: string,
  ): Promise<Statement> {
    const now = this.clock.now();
    if (!isMonthAvailable(month, now)) throw monthNotAvailable();
    const knownAt = knownAtText ? new Date(knownAtText) : undefined;
    if (knownAt && knownAt.getTime() > now.getTime()) throw knownAtInFuture();

    const period = await this.periods.find(month);
    const status = period?.status ?? 'OPEN';

    if (!knownAt && status === 'CLOSED') {
      const snapshot = await this.snapshots.find(shopId, month);
      const own: OwnFigures = snapshot
        ? {
            grossMinor: snapshot.grossMinor,
            commissionMinor: snapshot.commissionMinor,
            lineCount: snapshot.lineCount,
            payoutsPaidMinor: snapshot.payoutsPaidMinor,
          }
        : ZERO_FIGURES;
      const [booked, referencing] = await Promise.all([
        this.adjustments.forShop(shopId, { bookedMonth: month }),
        this.adjustments.forShop(shopId, { refersToMonth: month }),
      ]);
      const cutoff =
        snapshot?.knowledgeCutoff ?? period?.knowledgeCutoff ?? now;
      return {
        shopId,
        month,
        currency: 'EUR',
        status,
        source: 'snapshot',
        knownAt: cutoff.toISOString(),
        dataAsOf: null,
        ...compose(own, booked, referencing, false),
        adjustmentsBooked: booked,
        adjustmentsReferencing: referencing,
        unpricedLineCount: 0,
      };
    }

    const at = knownAt ?? now;
    const [aggregate, booked, referencing, dataAsOf] = await Promise.all([
      this.reader.aggregate({
        shopId,
        month,
        knownAt: at,
        timeoutMs: this.limits.readTimeoutMs,
      }),
      this.adjustments.forShop(shopId, {
        bookedMonth: month,
        createdAtOrBefore: knownAt,
      }),
      this.adjustments.forShop(shopId, {
        refersToMonth: month,
        createdAtOrBefore: knownAt,
      }),
      knownAt ? Promise.resolve(null) : this.watermarks.dataAsOf(),
    ]);
    return {
      shopId,
      month,
      currency: 'EUR',
      status,
      source: knownAt ? 'as_known_at' : 'live',
      knownAt: at.toISOString(),
      dataAsOf: dataAsOf ? dataAsOf.toISOString() : null,
      ...compose(aggregate, booked, referencing, knownAt !== undefined),
      adjustmentsBooked: booked,
      adjustmentsReferencing: referencing,
      unpricedLineCount: aggregate.unpricedLineCount,
    };
  }

  async list(
    shopId: string,
    query: { limit: number; cursor?: string },
  ): Promise<StatementPage> {
    const now = this.clock.now();
    const secret = this.cursorSecret();
    const before = query.cursor
      ? decodeCursor(query.cursor, 'statements', shopId, secret).k
      : null;
    const months = await this.reader.listMonths(
      shopId,
      monthOf(now),
      before,
      query.limit + 1,
    );
    const page = months.slice(0, query.limit);
    const items: StatementPage['items'] = [];
    for (const month of page) {
      const view = await this.statement(shopId, month);
      items.push({ month, status: view.status, total: view.total });
    }
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        months.length > query.limit && last
          ? encodeCursor({ r: 'statements', s: shopId, k: last }, secret)
          : null,
    };
  }

  private cursorSecret(): string {
    return `${this.config.get('jwt_secret')}`;
  }
}
