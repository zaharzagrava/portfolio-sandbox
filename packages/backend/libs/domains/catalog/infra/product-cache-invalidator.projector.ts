import { Injectable } from '@nestjs/common';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { ProductChanged } from '../application/events/product-events';
import { productCacheKey } from './product-cache';

/**
 * Delete-on-write for the product detail cache, driven by the same
 * `products.events` stream as the search index (D26). Its own consumer group,
 * so a slow ES cluster never delays cache invalidation (and vice versa).
 */
@Injectable()
export class ProductCacheInvalidator implements Projector {
  readonly name = 'product-cache-invalidator';
  readonly topics = [ProductChanged.topic];
  // Deleting a cache key twice is the same as deleting it once.
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ProductChanged }];
  readonly coalesce = true;

  constructor(private readonly cache: CacheService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    await this.cache.invalidate([
      ...new Set(events.map((e) => productCacheKey(e.aggregateId))),
    ]);
  }
}
