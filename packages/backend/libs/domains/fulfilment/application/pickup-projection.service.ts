import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import type { SinkCounts } from '@app/infrastructure/projections/projector';
import {
  buildOfferDocument,
  type OfferWrite,
  type PointFacts,
  type ProductCopyFacts,
  type ShopCopyFacts,
} from '../domain/offer-document';
import {
  PICKUP_AVAILABILITY_INDEX,
  PICKUP_POINT_REPOSITORY,
  PICKUP_STOCK_REPOSITORY,
  PRODUCT_COPY_STORE,
  SHOP_COPY_STORE,
  type PickupAvailabilityIndex,
  type PickupPointRecord,
  type PickupPointRepository,
  type PickupStockRecord,
  type PickupStockRepository,
  type ProductCopyStore,
  type ShopCopyStore,
} from '../domain/pickup-ports';
import { PickupMetrics } from '../infra/pickup-metrics';
import { pointChangedEvent } from './pickup-points.service';
import { stockChangedEvent } from './pickup-stock.service';

/** A bulk request to the index holds at most this many documents (research R-8). */
const CHUNK = 500;

export interface ProductChange {
  kind: 'snapshot';
  copy: ProductCopyFacts & { shopId: string };
}
export interface ProductDeletion {
  kind: 'deleted';
  productId: string;
  shopId: string;
  productVersion: number;
}
export interface ShopChange {
  kind: 'status';
  shopId: string;
  status: string;
  shopVersion: number;
}
export interface ShopDeletion {
  kind: 'deleted';
  shopId: string;
  shopVersion: number;
}

const toPointFacts = (p: PickupPointRecord): PointFacts => ({
  id: p.id,
  shopId: p.shopId,
  name: p.name,
  address: p.address,
  lat: p.lat,
  lng: p.lng,
  active: p.active,
  version: p.version,
});

/**
 * What the four consumers do (S19 FR-030..FR-035). The index document of one (point, product) is a pure function of
 * the current state of its four sources, read from this domain's own tables (stock, point, the two copies); so the
 * order in which events of different topics arrive cannot change the result, and `docVersion` (the sum of the source
 * versions) orders writes that do race. A delivery therefore always rebuilds the documents it touches, applied or not:
 * a crash between a copy write and the index write is repaired by the redelivery.
 */
@Injectable()
export class PickupProjectionService {
  constructor(
    @Inject(PICKUP_POINT_REPOSITORY)
    private readonly points: PickupPointRepository,
    @Inject(PICKUP_STOCK_REPOSITORY)
    private readonly stock: PickupStockRepository,
    @Inject(PRODUCT_COPY_STORE) private readonly products: ProductCopyStore,
    @Inject(SHOP_COPY_STORE) private readonly shops: ShopCopyStore,
    @Inject(PICKUP_AVAILABILITY_INDEX)
    private readonly index: PickupAvailabilityIndex,
    private readonly tx: TransactionRunner,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Stock events: the documents of the named (point, product) pairs. */
  applyStock(
    pairs: { pickupPointId: string; productId: string }[],
  ): Promise<SinkCounts> {
    return this.rebuildPairs(pairs);
  }

  /** Point events: every document of the named points. */
  async applyPoints(pointIds: string[]): Promise<SinkCounts> {
    const writes: OfferWrite[] = [];
    const context = this.context();
    for (const pointId of new Set(pointIds)) {
      let after: string | null = null;
      for (;;) {
        const rows = await this.stock.listOfPoint(pointId, CHUNK, after);
        for (const row of rows) writes.push(await this.build(row, context));
        if (rows.length < CHUNK) break;
        after = rows[rows.length - 1].productId;
      }
    }
    return this.publish(writes);
  }

  /** A product snapshot: the copy (version-guarded) and then the documents of the product's stock rows. */
  async applyProduct(change: ProductChange): Promise<SinkCounts> {
    const rows = await this.stock.listOfProduct(change.copy.productId);
    // a product with no pickup stock is not ours: no copy, no write
    if (rows.length === 0) return { applied: 0, duplicate: 0, stale: 0 };
    const stored = await this.products.upsert(change.copy);
    const counts = await this.rebuildPairs(rows);
    if (!stored) counts.stale += 1;
    return counts;
  }

  /**
   * `catalog.product_deleted`: the index documents are deleted first (idempotent, versioned), then the stock rows,
   * the copy and one quantity-0 event per row go in one transaction. A crash in between is repaired by the redelivery,
   * which deletes the documents again.
   */
  async applyProductDeleted(change: ProductDeletion): Promise<SinkCounts> {
    const rows = await this.stock.listOfProduct(change.productId);
    if (rows.length === 0) {
      if (await this.products.find(change.productId))
        await this.products.remove(change.productId);
      return { applied: 0, duplicate: 0, stale: 0 };
    }
    const context = this.context();
    const writes: OfferWrite[] = [];
    for (const row of rows) {
      const point = await this.pointOf(row.pickupPointId, context);
      const shop = await this.shopOf(point.shopId, context);
      writes.push(
        buildOfferDocument({
          stock: { ...row, quantity: 0, version: row.version + 1 },
          point: toPointFacts(point),
          product: {
            productId: change.productId,
            title: '',
            category: '',
            priceMinor: 0,
            currency: 'XXX',
            status: 'DELETED',
            isSandbox: false,
            version: change.productVersion,
          },
          shop,
        }),
      );
    }
    const counts = await this.publish(writes);
    await this.tx.run(async () => {
      const removed = await this.stock.deleteOfProduct(change.productId);
      for (const row of removed) {
        const point = await this.pointOf(row.pickupPointId, context);
        await this.outbox.append(
          stockChangedEvent(point, {
            ...row,
            quantity: 0,
            version: row.version + 1,
          }),
        );
      }
      await this.products.remove(change.productId);
    });
    return counts;
  }

  /** A shop status: the copy (version-guarded) and then every document of the shop. */
  async applyShopStatus(change: ShopChange): Promise<SinkCounts> {
    const stored = await this.shops.upsert({
      shopId: change.shopId,
      status: change.status,
      version: change.shopVersion,
    });
    const counts = await this.rebuildShop(change.shopId);
    if (!stored) counts.stale += 1;
    return counts;
  }

  /**
   * `tenancy.shop_deleted`: the copy turns `DELETED` and every active point turns inactive with one event each, in one
   * transaction; the stock stays. A repeat finds no active point and changes nothing.
   */
  async applyShopDeleted(change: ShopDeletion): Promise<SinkCounts> {
    await this.tx.run(async () => {
      await this.shops.upsert({
        shopId: change.shopId,
        status: 'DELETED',
        version: change.shopVersion,
      });
      const changed = await this.points.deactivateAllOfShop(
        change.shopId,
        this.clock.now(),
      );
      for (const point of changed)
        await this.outbox.append(pointChangedEvent(point));
    });
    return this.rebuildShop(change.shopId);
  }

  private async rebuildShop(shopId: string): Promise<SinkCounts> {
    const writes: OfferWrite[] = [];
    const context = this.context();
    let after: [string, string] | null = null;
    for (;;) {
      const rows = await this.stock.listOfShop(shopId, CHUNK, after);
      for (const row of rows) writes.push(await this.build(row, context));
      if (rows.length < CHUNK) break;
      const last = rows[rows.length - 1];
      after = [last.pickupPointId, last.productId];
    }
    return this.publish(writes);
  }

  private async rebuildPairs(
    pairs: { pickupPointId: string; productId: string }[],
  ): Promise<SinkCounts> {
    const context = this.context();
    const writes: OfferWrite[] = [];
    const seen = new Set<string>();
    for (const pair of pairs) {
      const key = `${pair.pickupPointId}:${pair.productId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // the row as it is now, not as the event said: a late event cannot resurrect stock that has gone
      const row = await this.stock.find(pair.pickupPointId, pair.productId);
      if (row) writes.push(await this.build(row, context));
    }
    return this.publish(writes);
  }

  private async build(
    row: PickupStockRecord,
    context: Cache,
  ): Promise<OfferWrite> {
    const point = await this.pointOf(row.pickupPointId, context);
    const [product, shop] = await Promise.all([
      this.productOf(row.productId, context),
      this.shopOf(point.shopId, context),
    ]);
    return buildOfferDocument({
      stock: row,
      point: toPointFacts(point),
      product,
      shop,
    });
  }

  /** Writes in chunks of 500 and reports how many the index applied and how many it found already newer. */
  private async publish(writes: OfferWrite[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (let i = 0; i < writes.length; i += CHUNK) {
      const result = await this.index.write(writes.slice(i, i + CHUNK));
      counts.applied += result.applied;
      counts.stale += result.stale;
    }
    return counts;
  }

  private context(): Cache {
    return {
      points: new Map(),
      products: new Map(),
      shops: new Map(),
    };
  }

  private async pointOf(id: string, c: Cache): Promise<PickupPointRecord> {
    let point = c.points.get(id);
    if (!point) {
      point = (await this.points.findById(id)) ?? undefined;
      if (!point) throw new Error(`pickup point ${id} has stock but no row`);
      c.points.set(id, point);
    }
    return point;
  }

  private async productOf(
    id: string,
    c: Cache,
  ): Promise<ProductCopyFacts | null> {
    if (!c.products.has(id)) c.products.set(id, await this.products.find(id));
    return c.products.get(id) ?? null;
  }

  private async shopOf(id: string, c: Cache): Promise<ShopCopyFacts | null> {
    if (!c.shops.has(id)) c.shops.set(id, await this.shops.find(id));
    return c.shops.get(id) ?? null;
  }

  /** Seconds between the commit of the newest applied event and now (S19 FR-036). */
  recordLag(occurredAt: string[]): void {
    if (occurredAt.length === 0) return;
    const newest = Math.max(...occurredAt.map((t) => Date.parse(t)));
    PickupMetrics.indexLag.set(
      Math.max(0, (this.clock.now().getTime() - newest) / 1000),
    );
  }
}

interface Cache {
  points: Map<string, PickupPointRecord>;
  products: Map<string, (ProductCopyFacts & { shopId: string }) | null>;
  shops: Map<string, ShopCopyFacts | null>;
}
