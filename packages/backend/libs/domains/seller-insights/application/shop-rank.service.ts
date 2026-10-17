import { Inject, Injectable } from '@nestjs/common';
import type { ShopRank } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { BoardStoreUnavailableError } from '../domain/errors';
import { insightsUnavailable, notRanked } from '../domain/insights-errors';
import { isClosed } from '../domain/periods';
import {
  BOARD_REPOSITORY,
  SNAPSHOT_REPOSITORY,
  type BoardRepository,
  type ShopPosition,
  type SnapshotRepository,
} from '../domain/ports';
import { topPercent } from '../domain/rank-percent';
import type { BoardQuery } from '../domain/board-query';
import { boardOf, periodView, resolvePeriod } from './board-resolution';

/**
 * A shop's own place on a board (S40 US3): rank, shops ranked, percentile and the shop's revenue, read in one atomic step
 * from the live board or, once the period is frozen, from the snapshot (top 100 only). The rank is the position the
 * top list shows for the same board.
 */
@Injectable()
export class ShopRankService {
  constructor(
    @Inject(BOARD_REPOSITORY) private readonly boards: BoardRepository,
    @Inject(SNAPSHOT_REPOSITORY) private readonly snapshots: SnapshotRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async rank(
    shopId: string,
    query: Omit<BoardQuery, 'limit'>,
  ): Promise<ShopRank> {
    const now = this.clock.now();
    const period = resolvePeriod(query.kind, query.id, now);
    const board = boardOf(query.category);
    const frozen =
      isClosed(period, now) && (await this.snapshots.isFrozen(period.id));

    let position: ShopPosition | null;
    if (frozen)
      position = await this.snapshots.position(period.id, board, shopId);
    else {
      try {
        position = await this.boards.position(period, board, shopId);
      } catch (error) {
        if (error instanceof BoardStoreUnavailableError)
          throw insightsUnavailable();
        throw error;
      }
    }
    if (!position) throw notRanked();
    return {
      period: periodView(period, now),
      category: query.category,
      rank: position.rank,
      of: position.of,
      topPercent: topPercent(position.rank, position.of),
      revenueMinor: position.revenueMinor,
    };
  }
}
