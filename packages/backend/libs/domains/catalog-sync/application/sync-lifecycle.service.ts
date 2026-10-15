import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SYNC_CATALOG_GATEWAY,
  SYNC_CLOCK,
  SYNC_CONFIG,
  SYNC_CONFLICT_REPOSITORY,
  SYNC_FEED_REPOSITORY,
  SYNC_FIELD_CLOCK_REPOSITORY,
  SYNC_OPERATION_REPOSITORY,
  type Clock,
  type SyncCatalogGateway,
  type SyncConfig,
  type SyncConflictRepository,
  type SyncFeedRepository,
  type SyncFieldClockRepository,
  type SyncOperationRepository,
} from '../domain/ports';
import {
  offlineConflictsOpenGauge,
  offlineOpsInFlightGauge,
} from './offline-sync-metrics';
import { SyncPushService } from './sync-push.service';

/** Rows per statement of a purge or a recovery pass (R-14: at most 1,000). */
export const LIFECYCLE_BATCH = 1_000;

/**
 * Everything that happens to sync data outside a request: recovery of unfinished operations (FR-005), compaction of the
 * feed (FR-028), retention (FR-037), erasure with the shop or the product (FR-036) and the rebuild of a shop's feed
 * (R-07). Each step is idempotent and safe on two instances at once: the conditional statements decide the winner.
 */
@Injectable()
export class SyncLifecycleService {
  private readonly logger = new Logger(SyncLifecycleService.name);
  private readonly building = new Map<string, Promise<void>>();

  constructor(
    @Inject(SYNC_OPERATION_REPOSITORY)
    private readonly ops: SyncOperationRepository,
    @Inject(SYNC_FEED_REPOSITORY) private readonly feed: SyncFeedRepository,
    @Inject(SYNC_FIELD_CLOCK_REPOSITORY)
    private readonly fieldClocks: SyncFieldClockRepository,
    @Inject(SYNC_CONFLICT_REPOSITORY)
    private readonly conflicts: SyncConflictRepository,
    @Inject(SYNC_CATALOG_GATEWAY) private readonly catalog: SyncCatalogGateway,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    @Inject(SYNC_CONFIG) private readonly config: SyncConfig,
    private readonly push: SyncPushService,
  ) {}

  /** Completes claims older than the recovery age, each by exactly one caller (the takeover is conditional). */
  async redriveStale(limit = LIFECYCLE_BATCH): Promise<{ completed: number }> {
    const now = this.clock.now();
    const stale = await this.ops.listStale(
      new Date(now.getTime() - this.config.recoveryAfterMs),
      limit,
    );
    let completed = 0;
    for (const row of stale) {
      const won = await this.ops.takeOver(
        row.shopId,
        row.opId,
        row.claimedAt,
        now,
      );
      if (!won) continue;
      try {
        await this.push.completeClaimed(row);
        completed++;
      } catch (error) {
        // The claim stays pending with a fresh lease; the next pass tries again.
        this.logger.warn({
          action: 'catalog-sync.offline_redrive_failed',
          shopId: row.shopId,
          opId: row.opId,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    await this.refreshGauges();
    return { completed };
  }

  /** Removes superseded feed entries and old tombstones, shop by shop, raising each shop's horizon. */
  async compactFeeds(): Promise<{ shops: number; removed: number }> {
    const now = this.clock.now();
    const before = new Date(now.getTime() - this.config.maxOpAgeMs);
    let after: string | null = null;
    let shops = 0;
    let removed = 0;
    for (;;) {
      const batch = await this.feed.shopsWithEntriesBefore(before, after, 100);
      if (batch.length === 0) break;
      for (const shopId of batch) {
        for (;;) {
          const pass = await this.feed.compact(
            shopId,
            before,
            LIFECYCLE_BATCH,
            now,
          );
          removed += pass.removed;
          if (pass.removed < LIFECYCLE_BATCH) break;
        }
        shops++;
      }
      after = batch[batch.length - 1];
    }
    return { shops, removed };
  }

  /** Deletes operation records past retention, except those of an open conflict. */
  async purgeOperations(): Promise<{ removed: number }> {
    const before = new Date(
      this.clock.now().getTime() - this.config.retentionMs,
    );
    let removed = 0;
    for (;;) {
      const pass = await this.ops.purgeBefore(before, LIFECYCLE_BATCH);
      removed += pass;
      if (pass < LIFECYCLE_BATCH) break;
    }
    return { removed };
  }

  /** `tenancy.shop_deleted`: every row of the shop in the five tables, in batches. */
  async deleteShopData(shopId: string): Promise<void> {
    for (const step of [
      (limit: number) => this.conflicts.deleteShop(shopId, limit),
      (limit: number) => this.ops.deleteShop(shopId, limit),
      (limit: number) => this.fieldClocks.deleteShop(shopId, limit),
      (limit: number) => this.feed.deleteShop(shopId, limit),
    ])
      for (;;) if ((await step(LIFECYCLE_BATCH)) < LIFECYCLE_BATCH) break;
  }

  /** `catalog.product_deleted`: the product's field clocks (its operations stay for the retention window). */
  deleteProductClocks(shopId: string, productId: string): Promise<number> {
    return this.fieldClocks.deleteProduct(shopId, productId);
  }

  async refreshGauges(): Promise<void> {
    offlineConflictsOpenGauge.set(await this.conflicts.countOpen());
    offlineOpsInFlightGauge.set(await this.ops.countPending());
  }

  /**
   * Builds the shop's feed from the catalog the first time it is read: a new generation (every older cursor answers
   * `410`) and one entry per product with its version. Events seen before the build stay; the version guard keeps the
   * newest of each. Concurrent callers on one instance share one build.
   */
  async ensureFeedBuilt(shopId: string): Promise<void> {
    const state = await this.feed.state(shopId);
    if (state && state.generation >= 1) return;
    let build = this.building.get(shopId);
    if (!build) {
      build = this.rebuildFeed(shopId).finally(() =>
        this.building.delete(shopId),
      );
      this.building.set(shopId, build);
    }
    await build;
  }

  /** The job `catalog-sync.backfill-change-log` and the first read both end here. */
  async rebuildFeed(shopId: string): Promise<void> {
    await this.feed.startGeneration(shopId);
    const now = this.clock.now();
    let cursor: string | null = null;
    do {
      const page = await this.catalog.listProducts(shopId, cursor);
      for (const product of page.items)
        await this.feed.append(shopId, {
          productId: product.id,
          version: product.version,
          deleted: false,
          data: product.data,
          occurredAt: now,
        });
      cursor = page.nextCursor;
    } while (cursor);
  }
}
