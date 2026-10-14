import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ProductDeleted } from '@app/domains/catalog';
import { ShopDeleted } from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { LifecycleService } from '../application/lifecycle.service';

/**
 * `catalog.product_deleted` → the product's documents, passages and bytes are removed (S47 FR-012, AS-50). Replaces the
 * `ON DELETE CASCADE` foreign key to `Product`. Idempotency is `natural`: the purge is a set of conditional updates that
 * a repeat finds already done. Invalid payloads and wrong versions are dead-lettered by the framework (AS-52).
 */
@Injectable()
export class KnowledgeProductDeletedConsumer implements Projector {
  readonly name = 'knowledge-product-deleted';
  readonly topics = [ProductDeleted.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ProductDeleted }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly lifecycle: LifecycleService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const event of events) {
      const { productId } = event.payload as { productId: string };
      const purged = await this.lifecycle.purgeByProduct(productId);
      if (purged > 0) counts.applied += 1;
      else counts.duplicate += 1;
    }
    return counts;
  }
}

/** `tenancy.shop_deleted` → every document of the shop goes; platform documents and other shops are untouched (AS-51). */
@Injectable()
export class KnowledgeShopDeletedConsumer implements Projector {
  readonly name = 'knowledge-shop-deleted';
  readonly topics = [ShopDeleted.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ShopDeleted }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly lifecycle: LifecycleService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const event of events) {
      const { shopId } = event.payload as { shopId: string };
      const purged = await this.lifecycle.purgeByShop(shopId);
      if (purged > 0) counts.applied += 1;
      else counts.duplicate += 1;
    }
    return counts;
  }
}
