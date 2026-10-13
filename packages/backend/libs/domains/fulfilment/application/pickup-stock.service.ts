import { Inject, Injectable } from '@nestjs/common';
import type {
  PickupListQuery,
  PickupStock,
  PickupStockAdjusted,
  PickupStockPage,
  PickupStockSet,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { decideAdjust, decideSet } from '../domain/stock-rules';
import {
  CATALOG_PRODUCT_READER,
  PICKUP_POINT_REPOSITORY,
  PICKUP_STOCK_REPOSITORY,
  PRODUCT_COPY_STORE,
  type CatalogProductReader,
  type PickupPointRecord,
  type PickupPointRepository,
  type PickupStockRecord,
  type PickupStockRepository,
  type ProductCopyStore,
} from '../domain/pickup-ports';
import {
  InsufficientPickupStockError,
  PickupPointInactiveError,
  PickupPointNotFoundError,
  PickupValidationError,
  ProductNotFoundError,
  StockLimitExceededError,
  StockVersionConflictError,
} from '../domain/pickup-errors';
import { decodeCursor, encodeCursor, queryKey } from '../domain/search-cursor';
import { PickupMetrics } from '../infra/pickup-metrics';
import { PickupStockChanged } from './events/pickup-events';
import { guardWrite } from './pickup-guard';

export const stockChangedEvent = (
  point: Pick<PickupPointRecord, 'shopId' | 'lat' | 'lng'>,
  stock: Pick<
    PickupStockRecord,
    'pickupPointId' | 'productId' | 'quantity' | 'version'
  >,
) =>
  PickupStockChanged.create(
    `${stock.pickupPointId}:${stock.productId}`,
    stock.version,
    {
      pickupPointId: stock.pickupPointId,
      productId: stock.productId,
      shopId: point.shopId,
      quantity: stock.quantity,
      stockVersion: stock.version,
      lat: point.lat,
      lng: point.lng,
    },
  );

const view = (s: PickupStockRecord): PickupStock => ({
  pickupPointId: s.pickupPointId,
  productId: s.productId,
  quantity: s.quantity,
  version: s.version,
});

/** Writes of a row race on its first insert only; a second pass finds the winner's row and decides again. */
const INSERT_ATTEMPTS = 3;

/**
 * Seller use cases for local stock (S19 FR-010..FR-014). The point and the product are checked before the transaction
 * opens (no network I/O inside it); inside it the row is locked, the pure rules of `stock-rules.ts` decide, and the
 * row and its event commit together. The store's CHECKs are the guarantee behind the rules.
 */
@Injectable()
export class PickupStockService {
  constructor(
    @Inject(PICKUP_POINT_REPOSITORY)
    private readonly points: PickupPointRepository,
    @Inject(PICKUP_STOCK_REPOSITORY)
    private readonly stock: PickupStockRepository,
    @Inject(PRODUCT_COPY_STORE) private readonly copies: ProductCopyStore,
    @Inject(CATALOG_PRODUCT_READER)
    private readonly catalog: CatalogProductReader,
    private readonly tx: TransactionRunner,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The point must belong to the shop; the product too (asked with the shop filter). */
  private async prepare(shopId: string, pointId: string, productId: string) {
    const point = await this.points.findInShop(shopId, pointId);
    if (!point) throw new PickupPointNotFoundError();
    const product = await this.catalog.findOwned(shopId, productId);
    if (!product) throw new ProductNotFoundError();
    return { point, product };
  }

  async set(
    shopId: string,
    pointId: string,
    productId: string,
    body: PickupStockSet,
  ): Promise<PickupStock> {
    const { product } = await this.prepare(shopId, pointId, productId);
    return guardWrite(() =>
      this.tx.run(async () => {
        const point = await this.activePoint(shopId, pointId);
        await this.copies.upsert(product);
        for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
          const row = await this.stock.lockRow(pointId, productId);
          const decision = decideSet(row, body);
          if (decision.kind === 'conflict') {
            PickupMetrics.stockChanges.add(1, { kind: 'rejected' });
            throw new StockVersionConflictError(decision.currentVersion);
          }
          if (decision.kind === 'noop') return view(row!);
          const now = this.clock.now();
          const written = row
            ? await this.stock.update(
                pointId,
                productId,
                body.quantity,
                decision.version,
                now,
              )
            : await this.stock.insert(pointId, productId, body.quantity, now);
          if (!written) continue; // a concurrent insert won: lock its row and decide again
          await this.outbox.append(stockChangedEvent(point, written));
          PickupMetrics.stockChanges.add(1, { kind: 'set' });
          return view(written);
        }
        throw new Error('stock row insert did not settle');
      }),
    );
  }

  async adjust(
    shopId: string,
    pointId: string,
    productId: string,
    delta: number,
  ): Promise<PickupStockAdjusted> {
    const { product } = await this.prepare(shopId, pointId, productId);
    return guardWrite(() =>
      this.tx.run(async () => {
        const point = await this.activePoint(shopId, pointId);
        await this.copies.upsert(product);
        for (let attempt = 0; attempt < INSERT_ATTEMPTS; attempt++) {
          const row = await this.stock.lockRow(pointId, productId);
          const decision = decideAdjust(row?.quantity ?? null, delta);
          if (decision.kind !== 'apply') {
            PickupMetrics.stockChanges.add(1, { kind: 'rejected' });
            throw decision.kind === 'insufficient'
              ? new InsufficientPickupStockError(decision.available)
              : new StockLimitExceededError();
          }
          const now = this.clock.now();
          const written = row
            ? await this.stock.update(
                pointId,
                productId,
                decision.quantity,
                row.version + 1,
                now,
              )
            : await this.stock.insert(
                pointId,
                productId,
                decision.quantity,
                now,
              );
          if (!written) continue;
          await this.outbox.append(stockChangedEvent(point, written));
          PickupMetrics.stockChanges.add(1, { kind: 'adjust' });
          return { ...view(written), applied: true as const };
        }
        throw new Error('stock row insert did not settle');
      }),
    );
  }

  async list(
    shopId: string,
    pointId: string,
    query: PickupListQuery,
  ): Promise<PickupStockPage> {
    const point = await this.points.findInShop(shopId, pointId);
    if (!point) throw new PickupPointNotFoundError();
    const key = queryKey({ pointId, list: 'stock' });
    let after: string | null = null;
    if (query.cursor) {
      const tuple = decodeCursor(query.cursor, key);
      if (!tuple || typeof tuple[0] !== 'string')
        throw new PickupValidationError(['cursor']);
      after = tuple[0];
    }
    const rows = await this.stock.listOfPoint(pointId, query.limit + 1, after);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((s) => ({
        productId: s.productId,
        quantity: s.quantity,
        version: s.version,
        updatedAt: s.updatedAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor([last.productId], key)
          : null,
    };
  }

  /** Inside the transaction: the point must still be active (the shop is in the predicate). */
  private async activePoint(shopId: string, pointId: string) {
    const point = await this.points.findInShop(shopId, pointId);
    if (!point) throw new PickupPointNotFoundError();
    if (!point.active) {
      PickupMetrics.stockChanges.add(1, { kind: 'rejected' });
      throw new PickupPointInactiveError();
    }
    return point;
  }
}
