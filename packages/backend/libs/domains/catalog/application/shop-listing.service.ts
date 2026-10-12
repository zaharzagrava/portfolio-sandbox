import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { CacheService } from '@app/infrastructure/cache';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { productCacheKey } from '../infra/product-cache';
import {
  SHOP_STATE_REPOSITORY,
  SHOP_SWEEP_REPOSITORY,
  type ShopStateRepository,
  type ShopSweepRepository,
} from '../domain/ports';
import { shopSweepCounter } from '../domain/product-metrics';
import type { ShopStateStatus } from '../domain/visibility';
import { deletedEvent } from './events/product-events';
import { ProductCacheInvalidation } from './product-cache-invalidation.service';

export const DROP_BATCH = 1_000;
export const PURGE_BATCH = 500;

/**
 * What the catalog does when a shop's life changes (FR-038, FR-039): keeps the shop's status (version-guarded),
 * drops the cached entries of its products in bounded batches, and deletes its products in bounded transactions.
 * Every step can be repeated: a retried job finds the work already done.
 */
@Injectable()
export class ShopListingService {
  private readonly logger = new Logger(ShopListingService.name);

  constructor(
    @Inject(SHOP_STATE_REPOSITORY) private readonly state: ShopStateRepository,
    @Inject(SHOP_SWEEP_REPOSITORY) private readonly sweep: ShopSweepRepository,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly cache: CacheService,
    private readonly invalidation: ProductCacheInvalidation,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `true` when the status was stored, `false` when the event was not newer than what is stored. */
  applyStatus(
    shopId: string,
    status: ShopStateStatus,
    shopVersion: number,
  ): Promise<boolean> {
    return this.state.apply(shopId, status, shopVersion, this.clock.now());
  }

  /** Drops the cache entry of every product of the shop, 1,000 at a time. Returns how many products it visited. */
  async dropEntries(shopId: string): Promise<number> {
    let after: string | null = null;
    let visited = 0;
    for (;;) {
      const ids = await this.sweep.idsAfter(shopId, after, DROP_BATCH);
      if (ids.length === 0) return visited;
      await this.cache.invalidate(ids.map(productCacheKey));
      shopSweepCounter.add(1, { kind: 'drop_entries' });
      visited += ids.length;
      after = ids[ids.length - 1];
      if (ids.length < DROP_BATCH) return visited;
    }
  }

  /**
   * Deletes the shop's products 500 per transaction (rows, history, stock operations, one `catalog.product_deleted`
   * each with `productVersion` one above the last), then the status copy. Returns how many products it deleted.
   */
  async purgeShop(shopId: string): Promise<number> {
    let deleted = 0;
    for (;;) {
      const batch = await this.runner.run(async () => {
        const rows = await this.sweep.lockBatch(shopId, PURGE_BATCH);
        if (rows.length === 0) return rows;
        await this.sweep.deleteBatch(
          shopId,
          rows.map((r) => r.id),
        );
        await this.outbox.append(
          rows.map((r) => deletedEvent(r.id, shopId, r.version + 1)),
        );
        return rows;
      });
      if (batch.length === 0) break;
      deleted += batch.length;
      shopSweepCounter.add(1, { kind: 'purge' });
      await this.invalidation.afterWrite(
        batch.map((r) => ({ productId: r.id, version: r.version + 1 })),
      );
    }
    const current = await this.state.find(shopId);
    if (current?.status === 'DELETED') await this.state.remove(shopId);
    this.logger.log({ action: 'shop.purged', shopId, deleted });
    return deleted;
  }
}
