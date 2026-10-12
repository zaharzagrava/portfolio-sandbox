import { Inject, Injectable } from '@nestjs/common';
import {
  ORDER_REPOSITORY,
  PRODUCT_CATALOG,
  type OrderRepository,
  type ProductCatalogPort,
} from '../domain/ports';
import { backfillOrphansGauge } from '../domain/order-metrics';

export const BACKFILL_BATCH = 200;
export const REMOVED_PRODUCT_TITLE = '(removed product)';

/**
 * Fills the title and line total of items created before the snapshot columns existed (S10 data-model, expand →
 * backfill → contract). Resumable and safe to repeat: it only reads items that are still empty and writes only what is
 * still empty. The products come from the catalog's batch read; a product that no longer exists gets a fixed title.
 */
@Injectable()
export class ItemBackfillService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepository,
    @Inject(PRODUCT_CATALOG) private readonly catalog: ProductCatalogPort,
  ) {}

  /** Runs batches until nothing is left; returns the number of items touched. */
  async run(): Promise<number> {
    let touched = 0;
    for (;;) {
      const batch = await this.orders.itemsMissingSnapshot(BACKFILL_BATCH);
      if (batch.length === 0) break;
      const needTitle = [
        ...new Set(
          batch.filter((i) => i.title === null).map((i) => i.productId),
        ),
      ];
      const products = needTitle.length
        ? await this.catalog.getProducts(needTitle)
        : new Map();
      for (const item of batch) {
        await this.orders.fillItemSnapshot(
          item.id,
          products.get(item.productId)?.title ?? REMOVED_PRODUCT_TITLE,
          item.unitPriceMinor * item.quantity,
        );
      }
      touched += batch.length;
      if (batch.length < BACKFILL_BATCH) break;
    }
    backfillOrphansGauge.set(await this.orders.countItemsWithoutShop());
    return touched;
  }
}
