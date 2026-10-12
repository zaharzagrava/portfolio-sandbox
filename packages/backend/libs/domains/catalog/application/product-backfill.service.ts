import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { ShopProvisioningService } from '@app/domains/tenancy';
import {
  LEGACY_BACKFILL_REPOSITORY,
  type LegacyBackfillRepository,
} from '../domain/ports';
import { backfillOrphansGauge } from '../domain/product-metrics';
import { snapshotEvent } from './events/product-events';
import { ProductCacheInvalidation } from './product-cache-invalidation.service';

export const BACKFILL_SELLERS = 200;
export const BACKFILL_BATCH = 200;

/**
 * Gives the products that predate shops (no `shopId`) their owner's shop (FR-040): at most 200 owners per call to
 * `ShopProvisioningService.ensureShopsForLegacySellers`, at most 200 products per transaction, one
 * `catalog.product_updated` (`changedFields: ["shopId"]`) per product. Products are picked with `SKIP LOCKED` and only
 * while they have no shop, so an interrupted or concurrent run never assigns a product twice.
 */
@Injectable()
export class ProductBackfillService {
  private readonly logger = new Logger(ProductBackfillService.name);

  constructor(
    @Inject(LEGACY_BACKFILL_REPOSITORY)
    private readonly legacy: LegacyBackfillRepository,
    private readonly provisioning: ShopProvisioningService,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly invalidation: ProductCacheInvalidation,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** One round: the next owners and all their products. `sellers` is 0 when nothing is left to do. */
  async runOnce(): Promise<{ sellers: number; products: number }> {
    const owners = await this.legacy.legacySellers(BACKFILL_SELLERS);
    let products = 0;
    if (owners.length > 0) {
      const shops = await this.provisioning.ensureShopsForLegacySellers(owners);
      for (const owner of owners) {
        const shopId = shops.get(owner);
        if (!shopId) continue;
        for (;;) {
          const batch = await this.runner.run(async () => {
            const rows = await this.legacy.assignShop(
              owner,
              shopId,
              BACKFILL_BATCH,
              this.clock.now(),
            );
            if (rows.length > 0)
              await this.outbox.append(
                rows.map((r) => snapshotEvent('updated', r, ['shopId'])),
              );
            return rows;
          });
          if (batch.length === 0) break;
          products += batch.length;
          await this.invalidation.afterWrite(
            batch.map((r) => ({ productId: r.id, version: r.version })),
          );
        }
      }
    }
    const orphans = await this.legacy.orphanCount();
    backfillOrphansGauge.set(orphans);
    if (orphans > 0)
      this.logger.warn(`${orphans} products have no shop and no owner`);
    return { sellers: owners.length, products };
  }
}
