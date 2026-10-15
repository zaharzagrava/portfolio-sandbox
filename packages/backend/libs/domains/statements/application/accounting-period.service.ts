import { Inject, Injectable } from '@nestjs/common';
import type { AccountingPeriod } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config';
import { decodeCursor, encodeCursor } from '../domain/cursor';
import { monthNotAvailable } from '../domain/errors';
import { isMonthAvailable } from '../domain/period';
import {
  PERIOD_REPOSITORY,
  type PeriodRepository,
  type PeriodRow,
} from '../domain/ports';
import { WatermarkService } from './watermark.service';

/** The operator's view of accounting periods (S16 FR-026): state, cutoff, shop count, watermarks, last run, reconciliation. */
@Injectable()
export class AccountingPeriodService {
  constructor(
    @Inject(PERIOD_REPOSITORY) private readonly periods: PeriodRepository,
    private readonly watermarks: WatermarkService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(month: string): Promise<AccountingPeriod> {
    if (!isMonthAvailable(month, this.clock.now())) throw monthNotAvailable();
    const row = await this.periods.find(month);
    return this.view(
      row ?? {
        month,
        status: 'OPEN',
        knowledgeCutoff: null,
        closedAt: null,
        shopCount: null,
        runId: null,
      },
      await this.watermarks.read(),
    );
  }

  async list(query: {
    limit: number;
    cursor?: string;
  }): Promise<{ items: AccountingPeriod[]; nextCursor: string | null }> {
    const secret = this.cursorSecret();
    const before = query.cursor
      ? decodeCursor(query.cursor, 'periods', 'all', secret).k
      : null;
    const rows = await this.periods.list(before, query.limit + 1);
    const page = rows.slice(0, query.limit);
    const marks = await this.watermarks.read();
    const items: AccountingPeriod[] = [];
    for (const row of page) items.push(await this.view(row, marks));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ r: 'periods', s: 'all', k: last.month }, secret)
          : null,
    };
  }

  private async view(
    row: PeriodRow,
    marks: Awaited<ReturnType<WatermarkService['read']>>,
  ): Promise<AccountingPeriod> {
    const [run, reconciliation] = await Promise.all([
      this.periods.lastRun(row.month),
      this.periods.reconciliationState(row.month),
    ]);
    return {
      month: row.month,
      status: row.status,
      knowledgeCutoff: row.knowledgeCutoff?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      shopCount: row.shopCount,
      watermarks: {
        orders: marks.orders?.toISOString() ?? null,
        payouts: marks.payouts?.toISOString() ?? null,
        ledger: marks.ledger?.toISOString() ?? null,
      },
      lastRun: run
        ? {
            runId: run.runId,
            status: run.status,
            failureCode: run.failureCode,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
          }
        : null,
      reconciliation,
    };
  }

  private cursorSecret(): string {
    return `${this.config.get('jwt_secret')}`;
  }
}
