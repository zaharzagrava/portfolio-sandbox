import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { PeriodNotClosedError } from '../domain/errors';
import {
  isSnapshotDue,
  parsePeriod,
  periodOf,
  type Period,
  type PeriodKind,
} from '../domain/periods';
import {
  BOARD_REPOSITORY,
  SHOP_DIRECTORY,
  SNAPSHOT_REPOSITORY,
  type BoardRepository,
  type ShopDirectory,
  type SnapshotRepository,
} from '../domain/ports';
import { insightsLog } from './insights-log';

export const SNAPSHOT_TOP = 100;
/** Periods a run looks back over: boards live 35 days after their period, so 7 weeks / 3 months cover every one. */
const LOOKBACK: Record<PeriodKind, number> = { week: 7, month: 3 };

export interface SnapshotResult {
  periodId: string;
  boards: number;
  rows: number;
}

/**
 * Freezes the top 100 of every board of a closed period into PostgreSQL (S40 US4). A period is frozen one hour after it
 * ends; the period is sealed first (late events are no longer applied), then each board is replaced atomically, so a
 * re-run or a concurrent run leaves the same rows and readers never see an empty or partial list.
 */
@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  constructor(
    @Inject(BOARD_REPOSITORY) private readonly boards: BoardRepository,
    @Inject(SNAPSHOT_REPOSITORY) private readonly snapshots: SnapshotRepository,
    @Inject(SHOP_DIRECTORY) private readonly shops: ShopDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Freezes one named period; refused (`period_not_closed`, `invalid_period`) when it is not over, future or malformed. */
  async freeze(periodId: string): Promise<SnapshotResult> {
    const kind: PeriodKind = /^\d{4}-W\d{2}$/.test(periodId) ? 'week' : 'month';
    // a malformed id is an `InvalidPeriodError` (`invalid_period`)
    const period = parsePeriod(kind, periodId, this.clock.now());
    if (!isSnapshotDue(period, this.clock.now()))
      throw new PeriodNotClosedError(periodId);
    return this.freezePeriod(period);
  }

  /** Every closed, unfrozen period of the kind that still has boards, oldest first (catch-up). */
  async freezeDue(kind: PeriodKind): Promise<SnapshotResult[]> {
    const now = this.clock.now();
    const frozen = await this.snapshots.frozenPeriodIds(kind);
    const current = periodOf(kind, now);
    const candidates: Period[] = [];
    for (let back = LOOKBACK[kind]; back >= 1; back--) {
      const at = new Date(
        kind === 'week'
          ? current.start.getTime() - back * 7 * 86_400_000
          : Date.UTC(
              current.start.getUTCFullYear(),
              current.start.getUTCMonth() - back,
              1,
            ),
      );
      const period = periodOf(kind, at);
      if (isSnapshotDue(period, now) && !frozen.has(period.id))
        candidates.push(period);
    }
    const results: SnapshotResult[] = [];
    for (const period of candidates) {
      if ((await this.boards.boards(period)).length === 0) {
        insightsLog(
          this.logger,
          'warn',
          'snapshot_skipped_no_boards',
          { traceId: `snapshot-${period.id}` },
          { period: period.id },
        );
        continue;
      }
      results.push(await this.freezePeriod(period));
    }
    return results;
  }

  private async freezePeriod(period: Period): Promise<SnapshotResult> {
    const boards = (await this.boards.boards(period)).sort();
    // sealed first: from here on the boards of the period no longer move, so every board is frozen at the same state
    await this.boards.seal(period);
    let rows = 0;
    let frozenBoards = 0;
    for (const board of boards) {
      const top = await this.boards.topWithRevenue(period, board, SNAPSHOT_TOP);
      if (top.length === 0) continue;
      const participants = await this.boards.size(period, board);
      const names = await this.shops.namesOf(top.map((t) => t.shopId));
      await this.snapshots.replaceBoard(
        period.id,
        board,
        top.map((t, i) => ({
          rank: i + 1,
          shopId: t.shopId,
          shopName: names.get(t.shopId)?.name ?? null,
          revenueMinor: t.revenueMinor,
        })),
        participants,
      );
      rows += top.length;
      frozenBoards++;
    }
    insightsLog(
      this.logger,
      'log',
      'period_frozen',
      { traceId: `snapshot-${period.id}` },
      { period: period.id, boards: frozenBoards, rows },
    );
    return { periodId: period.id, boards: frozenBoards, rows };
  }
}
