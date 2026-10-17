import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BOARD_REPOSITORY,
  LIVE_COUNTER_REPOSITORY,
  PRODUCT_CATEGORY_DIRECTORY,
  SALES_HISTORY_REPOSITORY,
  SHOP_DIRECTORY,
  SNAPSHOT_REPOSITORY,
  type BoardRepository,
  type LiveCounterRepository,
  type ProductCategoryDirectory,
  type SalesHistoryRepository,
  type ShopDirectory,
  type SnapshotRepository,
} from '../domain/ports';
import { insightsLog } from './insights-log';

/**
 * Removes every trace of a deleted shop from every store of the capability (S40 FR-043): live boards, snapshot rows (the
 * rest of each board is renumbered), live counters, sales and refund facts, both read models. Every step is idempotent, so
 * a redelivery or a retry after a part-way failure completes the job.
 */
@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);

  constructor(
    @Inject(BOARD_REPOSITORY) private readonly boards: BoardRepository,
    @Inject(SNAPSHOT_REPOSITORY) private readonly snapshots: SnapshotRepository,
    @Inject(LIVE_COUNTER_REPOSITORY)
    private readonly live: LiveCounterRepository,
    @Inject(SALES_HISTORY_REPOSITORY)
    private readonly history: SalesHistoryRepository,
    @Inject(SHOP_DIRECTORY) private readonly shops: ShopDirectory,
    @Inject(PRODUCT_CATEGORY_DIRECTORY)
    private readonly products: ProductCategoryDirectory,
  ) {}

  async erase(shopId: string, traceId?: string): Promise<void> {
    await this.boards.removeShop(shopId);
    await this.snapshots.removeShop(shopId);
    await this.live.removeShop(shopId);
    await this.history.removeShop(shopId);
    await this.products.removeByShop(shopId);
    await this.shops.remove(shopId);
    insightsLog(this.logger, 'log', 'shop_erased', { traceId }, { shopId });
  }
}
