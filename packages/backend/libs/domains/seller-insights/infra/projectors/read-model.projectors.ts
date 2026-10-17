import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  sellerInsightsProductEventSchema,
  sellerInsightsShopDeletedSchema,
  sellerInsightsShopEventSchema,
} from '@marketplace-sandbox/contracts';
import {
  ProductArchived,
  ProductCreated,
  ProductDeleted,
  ProductRestored,
  ProductUpdated,
} from '@app/domains/catalog';
import { ShopCreated, ShopDeleted, ShopUpdated } from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { ErasureService } from '../../application/erasure.service';
import { traceIdOf } from '../../application/insights-log';
import {
  PRODUCT_CATEGORY_DIRECTORY,
  SHOP_DIRECTORY,
  type ProductCategoryDirectory,
  type ShopDirectory,
} from '../../domain/ports';
import { parseOrReject, storeCall } from './support';

const counts = (): SinkCounts => ({ applied: 0, duplicate: 0, stale: 0 });
const uuid = z.string().uuid();

/**
 * `tenancy.shop_created|updated|deleted` -> the shop name read model (R3, S40 FR-014): a version-guarded upsert, so a
 * stale rename or a replay never moves it back; a deleted shop's row is removed.
 */
@Injectable()
export class ShopNameProjector implements Projector {
  readonly name = 'seller-insights-shops';
  readonly topics = [ShopCreated.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    { event: ShopCreated },
    { event: ShopUpdated },
    { event: ShopDeleted },
  ];
  readonly aggregateIdSchema = uuid;

  constructor(@Inject(SHOP_DIRECTORY) private readonly shops: ShopDirectory) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const sink = counts();
    for (const event of events) {
      if (event.type === ShopDeleted.type) {
        const deleted = parseOrReject(
          'shops',
          event,
          sellerInsightsShopDeletedSchema,
        );
        await storeCall(() => this.shops.remove(deleted.shopId));
        sink.applied++;
        continue;
      }
      const shop = parseOrReject('shops', event, sellerInsightsShopEventSchema);
      const outcome = await storeCall(() => this.shops.upsert(shop));
      sink[outcome]++;
    }
    return sink;
  }
}

/**
 * `tenancy.shop_deleted` -> removes every trace of the shop from boards, snapshots, counters, analytics and read models
 * (S40 FR-043). Its own consumer group, so a failure of the name model never holds an erasure back.
 */
@Injectable()
export class ShopErasureProjector implements Projector {
  readonly name = 'seller-insights-shop-erasure';
  readonly topics = [ShopDeleted.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ShopDeleted }];
  readonly aggregateIdSchema = uuid;

  constructor(private readonly erasure: ErasureService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const sink = counts();
    for (const event of events) {
      const deleted = parseOrReject(
        'erasure',
        event,
        sellerInsightsShopDeletedSchema,
      );
      await storeCall(() =>
        this.erasure.erase(
          deleted.shopId,
          traceIdOf(event.traceparent) ?? event.eventId,
        ),
      );
      sink.applied++;
    }
    return sink;
  }
}

const SNAPSHOTS = [
  ProductCreated,
  ProductUpdated,
  ProductArchived,
  ProductRestored,
] as const;

/**
 * `catalog.product_*` -> the product category read model (R3, S40 FR-008): a version-guarded upsert on the compacted topic
 * (replay gives the latest snapshot per product). `catalog.product_deleted` moves the version on and keeps the last
 * category, so past sales stay attributable.
 */
@Injectable()
export class ProductCategoryProjector implements Projector {
  readonly name = 'seller-insights-products';
  readonly topics = [ProductCreated.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    ...SNAPSHOTS.map((event) => ({ event })),
    { event: ProductDeleted },
  ];
  readonly aggregateIdSchema = uuid;

  constructor(
    @Inject(PRODUCT_CATEGORY_DIRECTORY)
    private readonly products: ProductCategoryDirectory,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const sink = counts();
    for (const event of events) {
      const deleted = event.type === ProductDeleted.type;
      const product = parseOrReject(
        'products',
        event,
        sellerInsightsProductEventSchema,
      );
      const outcome = await storeCall(() =>
        this.products.upsert({
          productId: product.productId,
          shopId: product.shopId,
          category: deleted ? null : (product.category ?? null),
          productVersion: product.productVersion,
        }),
      );
      sink[outcome]++;
    }
    return sink;
  }
}
