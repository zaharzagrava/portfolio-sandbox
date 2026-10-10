import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import {
  ProductArchived,
  ProductCreated,
  ProductDeleted,
  ProductRestored,
  ProductUpdated,
} from '@app/domains/catalog';
import { ProductProjectionService } from '../../application/projection/product-projection.service';

/**
 * Group `search-indexer` (name kept from the catalog's old projector so committed offsets carry over): the full
 * product state into the public index and the shop search table. `versionGuard`: every write is compared with the
 * stored `productVersion` (and the delete tombstone), so redelivery and reordering change nothing (AS-23 to AS-26).
 * Events carry the full state, so a batch is reduced to the newest version per product (AS-34).
 */
@Injectable()
export class ProductIndexProjector implements Projector {
  readonly name = 'search-indexer';
  readonly topics = [ProductCreated.topic];
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

  constructor(private readonly projection: ProductProjectionService) {}

  project(events: EventEnvelope[]): Promise<SinkCounts> {
    return this.projection.project(events);
  }
}
