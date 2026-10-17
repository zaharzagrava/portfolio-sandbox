import { Inject, Injectable } from '@nestjs/common';
import type { LeaderboardPage } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { BoardStoreUnavailableError } from '../domain/errors';
import { insightsUnavailable } from '../domain/insights-errors';
import { isClosed } from '../domain/periods';
import {
  BOARD_REPOSITORY,
  SHOP_DIRECTORY,
  SNAPSHOT_REPOSITORY,
  type BoardRepository,
  type ShopDirectory,
  type SnapshotRepository,
} from '../domain/ports';
import type { BoardQuery } from '../domain/board-query';
import { boardOf, periodView, resolvePeriod } from './board-resolution';

/**
 * The public top list (S40 US2). A frozen period is read from its snapshot only; any other period from the live board.
 * Entries carry rank, shop, slug and name and nothing else: no revenue ever leaves through this route. Names come from
 * this capability's own read model in one batched read, the snapshot's from the name stored when it was frozen.
 */
@Injectable()
export class LeaderboardReadService {
  constructor(
    @Inject(BOARD_REPOSITORY) private readonly boards: BoardRepository,
    @Inject(SNAPSHOT_REPOSITORY) private readonly snapshots: SnapshotRepository,
    @Inject(SHOP_DIRECTORY) private readonly shops: ShopDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async top(query: BoardQuery): Promise<LeaderboardPage> {
    const now = this.clock.now();
    const period = resolvePeriod(query.kind, query.id, now);
    const board = boardOf(query.category);
    const frozen =
      isClosed(period, now) && (await this.snapshots.isFrozen(period.id));

    let entries: LeaderboardPage['entries'];
    if (frozen) {
      const page = await this.snapshots.top(period.id, board, query.limit);
      const names = await this.shops.namesOf(page.rows.map((r) => r.shopId));
      entries = page.rows.map((r) => ({
        rank: r.rank,
        shopId: r.shopId,
        slug: names.get(r.shopId)?.slug ?? null,
        name: r.shopName,
      }));
    } else {
      let ids: string[];
      try {
        ids = await this.boards.top(period, board, query.limit);
      } catch (error) {
        if (error instanceof BoardStoreUnavailableError)
          throw insightsUnavailable();
        throw error;
      }
      const names = await this.shops.namesOf(ids);
      entries = ids.map((shopId, i) => ({
        rank: i + 1,
        shopId,
        slug: names.get(shopId)?.slug ?? null,
        name: names.get(shopId)?.name ?? null,
      }));
    }
    return {
      period: periodView(period, now),
      category: query.category,
      source: frozen ? 'snapshot' : 'live',
      generatedAt: now.toISOString(),
      entries,
    };
  }
}
