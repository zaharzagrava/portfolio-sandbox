import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * `products.events` (key = productId). Transitional "something changed" notification emitted by every writer of a
 * product row; consumers (search index, caches, feeds, outbound sync) read the current row, not the payload.
 * S05 replaces it with full-state `catalog.product_*` events whose `aggregateVersion` is the product version
 * (strictly increasing, also on delete) and registers the topic `latest-per-key`; until then the version is the
 * emission time in milliseconds, which only orders notifications and carries no state.
 */
export const ProductChanged = defineEvent(
  'catalog.product_changed',
  'products',
  1,
  z.object({ productId: z.string() }),
  // A "look it up" notification: the newest one supersedes the earlier ones (consumers read the current row), which
  // is exactly what coalescing and compaction need.
  { carries: 'state' },
);

export const productChanged = (productId: string) =>
  ProductChanged.create(productId, Date.now(), { productId });

/** Every module whose services append product events registers the aggregate through `EventsModule.forAggregates`. */
export const PRODUCTS_AGGREGATE: TopicRegistration = {
  aggregateType: 'products',
  retention: 'full-history',
};
