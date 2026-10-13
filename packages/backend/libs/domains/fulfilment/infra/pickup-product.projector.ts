import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ProductArchived,
  ProductCreated,
  ProductDeleted,
  ProductRestored,
  ProductUpdated,
} from '@app/domains/catalog';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { PickupProjectionService } from '../application/pickup-projection.service';

const SNAPSHOTS = [
  ProductCreated,
  ProductUpdated,
  ProductArchived,
  ProductRestored,
];

/**
 * `catalog.product_*` → the product copy and the documents that show it (S19 FR-031, FR-033). The catalog events carry
 * the full state and the compacted topic keeps the newest per product, so a replay yields the latest snapshot and a
 * `product_deleted` means "remove". `catalog.product_changed` is not consumed and the catalog's table is never read.
 */
@Injectable()
export class PickupProductProjector implements Projector {
  readonly name: string = 'pickup-index-product';
  readonly topics: string[] = [ProductCreated.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    { event: ProductCreated },
    { event: ProductUpdated },
    { event: ProductArchived },
    { event: ProductRestored },
    { event: ProductDeleted },
  ];
  readonly coalesce = true;
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly projection: PickupProjectionService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const total: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    const add = (c: SinkCounts) => {
      total.applied += c.applied;
      total.duplicate += c.duplicate;
      total.stale += c.stale;
    };
    for (const event of events) {
      const deleted = ProductDeleted.match(event);
      if (deleted) {
        add(
          await this.projection.applyProductDeleted({
            kind: 'deleted',
            productId: deleted.payload.productId,
            shopId: deleted.payload.shopId,
            productVersion: deleted.payload.productVersion,
          }),
        );
        continue;
      }
      for (const definition of SNAPSHOTS) {
        const snapshot = definition.match(event);
        if (!snapshot) continue;
        const p = snapshot.payload;
        add(
          await this.projection.applyProduct({
            kind: 'snapshot',
            copy: {
              productId: p.productId,
              shopId: p.shopId,
              title: p.title,
              category: p.category,
              priceMinor: p.priceMinor,
              currency: p.currency,
              status: p.status,
              isSandbox: p.isSandbox,
              version: p.productVersion,
            },
          }),
        );
      }
    }
    return total;
  }
}
