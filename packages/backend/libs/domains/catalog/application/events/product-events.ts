import { z } from 'zod';
import {
  productDeletedPayloadSchema,
  productSnapshotSchema,
  type ProductSnapshot,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { toSnapshot, type ProductRecord } from '../../domain/product-view';

/**
 * `products.events` (key = productId, `latest-per-key`): the full state of a product after every committed change.
 * `aggregateVersion` is the product's own `version`, rising by exactly 1 per event of one product (also on delete),
 * so a consumer's version guard and the compacted topic both keep the newest state. View counts, `createdBy` and
 * embeddings are never part of it.
 */
export const ProductCreated = defineEvent(
  'catalog.product_created',
  'products',
  1,
  productSnapshotSchema,
  { carries: 'state' },
);
export const ProductUpdated = defineEvent(
  'catalog.product_updated',
  'products',
  1,
  productSnapshotSchema,
  { carries: 'state' },
);
export const ProductArchived = defineEvent(
  'catalog.product_archived',
  'products',
  1,
  productSnapshotSchema,
  { carries: 'state' },
);
export const ProductRestored = defineEvent(
  'catalog.product_restored',
  'products',
  1,
  productSnapshotSchema,
  { carries: 'state' },
);
export const ProductDeleted = defineEvent(
  'catalog.product_deleted',
  'products',
  1,
  productDeletedPayloadSchema,
  { carries: 'state' },
);

/**
 * TRANSITIONAL: the "something changed" notification still appended by the capabilities that update `Product` with raw
 * SQL (catalog-sync, public-api, discovery, launch-events; `gaps.md` section C). Consumers in this domain treat it as
 * an unconditional invalidation and never read its version, which is 0 so that it can never outrank a snapshot.
 */
export const ProductChanged = defineEvent(
  'catalog.product_changed',
  'products',
  1,
  z.object({ productId: z.string() }),
  { carries: 'state' },
);

export const productChanged = (productId: string) =>
  ProductChanged.create(productId, 0, { productId });

export const PRODUCTS_AGGREGATE: TopicRegistration = {
  aggregateType: 'products',
  retention: 'latest-per-key',
};

export type SnapshotEventKind = 'created' | 'updated' | 'archived' | 'restored';

const DEFINITIONS = {
  created: ProductCreated,
  updated: ProductUpdated,
  archived: ProductArchived,
  restored: ProductRestored,
} as const;

/** The envelope for a committed change: full state, `aggregateVersion = productVersion`. */
export const snapshotEvent = (
  kind: SnapshotEventKind,
  record: ProductRecord,
  changedFields: ProductSnapshot['changedFields'],
): EventEnvelope =>
  DEFINITIONS[kind].create(
    record.id,
    record.version,
    toSnapshot(record, changedFields),
  );

export const deletedEvent = (
  productId: string,
  shopId: string,
  productVersion: number,
): EventEnvelope =>
  ProductDeleted.create(productId, productVersion, {
    productId,
    shopId,
    productVersion,
  });
