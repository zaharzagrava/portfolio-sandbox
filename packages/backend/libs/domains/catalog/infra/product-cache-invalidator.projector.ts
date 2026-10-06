import { Injectable } from '@nestjs/common';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { KafkaTopicGroup } from '@app/infrastructure/outbox/outbox.model';
import { productCacheKey } from './product-cache';

/**
 * Delete-on-write for the product detail cache, driven by the same
 * `products.events` stream as the search index (D26). Its own consumer group,
 * so a slow ES cluster never delays cache invalidation (and vice versa).
 */
@Injectable()
export class ProductCacheInvalidator implements Projector {
  readonly name = 'product-cache-invalidator';
  readonly topics = [KafkaTopicGroup.PRODUCTS_EVENTS];
  readonly coalesce = true;

  constructor(private readonly cache: CacheService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    await this.cache.invalidate([...new Set(events.map((e) => productCacheKey(e.aggregateId)))]);
  }
}
