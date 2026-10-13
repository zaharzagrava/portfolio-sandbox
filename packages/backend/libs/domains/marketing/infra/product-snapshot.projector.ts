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
import { SnapshotEffectsService } from '../application/snapshot-effects.service';

const SNAPSHOTS = [
  ProductCreated,
  ProductUpdated,
  ProductArchived,
  ProductRestored,
];

/**
 * `products.events` -> the product read model of sponsored listings and its effect on campaigns (S36 FR-060, R-5). The
 * framework validates every payload and dead-letters the invalid ones; the version guard is the upsert's `WHERE
 * productVersion < incoming`, so a duplicate or older event has no effect. Not coalesced: an archive followed by a restore
 * in one batch must still pause the campaign. The catalog's table is never read.
 */
@Injectable()
export class AdsProductSnapshotProjector implements Projector {
  readonly name = 'ads-product-snapshot';
  readonly topics = [ProductCreated.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    { event: ProductCreated },
    { event: ProductUpdated },
    { event: ProductArchived },
    { event: ProductRestored },
    { event: ProductDeleted },
  ];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly effects: SnapshotEffectsService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    const note = (applied: boolean) => {
      if (applied) counts.applied++;
      else counts.stale++;
    };
    for (const event of events) {
      const deleted = ProductDeleted.match(event);
      if (deleted) {
        note(await this.effects.applyProductDeleted(deleted.payload));
        continue;
      }
      for (const definition of SNAPSHOTS) {
        const matched = definition.match(event);
        if (!matched) continue;
        const p = matched.payload;
        note(
          await this.effects.applyProduct({
            productId: p.productId,
            shopId: p.shopId,
            title: p.title,
            category: p.category,
            priceMinor: p.priceMinor,
            currency: p.currency,
            inStock: p.inStock,
            status: p.status,
            isSandbox: p.isSandbox,
            productVersion: p.productVersion,
          }),
        );
        break;
      }
    }
    return counts;
  }
}
