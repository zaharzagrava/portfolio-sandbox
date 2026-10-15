import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { productEventSchemas } from '@marketplace-sandbox/contracts';
import type { EventDefinition } from '@app/infrastructure/events/define-event';
import {
  topicFor,
  type EventEnvelope,
} from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { ShopDeleted } from '@app/domains/tenancy';
import { SyncLifecycleService } from '../application/sync-lifecycle.service';

export const OFFLINE_PRODUCT_DELETED_CONSUMER =
  'catalog-sync-offline-product-deleted';
export const OFFLINE_SHOP_DELETED_CONSUMER =
  'catalog-sync-offline-shop-deleted';

const deletedSchema = productEventSchemas['catalog.product_deleted'];
const uuid = z.string().uuid();

function consumed<S extends z.ZodType>(
  type: 'catalog.product_deleted',
  schema: S,
): HandledEvent {
  const definition: EventDefinition<typeof type, 'products', S> = {
    type,
    version: 1,
    aggregateType: 'products',
    topic: topicFor('products'),
    schema,
    carries: 'state',
    create() {
      throw new Error(`${type} is produced by its owning domain`);
    },
    match(envelope) {
      if (envelope.type !== type || envelope.version !== 1) return null;
      return { ...envelope, type, payload: schema.parse(envelope.payload) };
    },
  };
  return { event: definition };
}

/**
 * `catalog.product_deleted` removes the product's field clocks (FR-036, AS-49). Deleting is idempotent by nature, so a
 * second delivery changes nothing; the operation records stay for the retention window.
 */
@Injectable()
export class OfflineProductDeletedConsumer implements Projector {
  readonly name = OFFLINE_PRODUCT_DELETED_CONSUMER;
  readonly topics = [topicFor('products')];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = [
    consumed('catalog.product_deleted', deletedSchema),
  ];

  constructor(private readonly lifecycle: SyncLifecycleService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const deleted = events
      .filter((e) => e.type === 'catalog.product_deleted')
      .map((envelope) => {
        const parsed = deletedSchema.safeParse(envelope.payload);
        if (!parsed.success)
          throw new PermanentError(`invalid ${envelope.type} payload`);
        return parsed.data;
      });
    for (const { shopId, productId } of deleted)
      await this.lifecycle.deleteProductClocks(shopId, productId);
  }
}

/** `tenancy.shop_deleted` removes every sync row of the shop in batches of at most 1,000 (FR-036, AS-48). */
@Injectable()
export class OfflineShopDeletedConsumer implements Projector {
  readonly name = OFFLINE_SHOP_DELETED_CONSUMER;
  readonly topics: string[] = [ShopDeleted.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = [{ event: ShopDeleted }];

  constructor(private readonly lifecycle: SyncLifecycleService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const shops = new Set<string>();
    for (const envelope of events) {
      const parsed = ShopDeleted.schema.safeParse(envelope.payload);
      if (!parsed.success || !uuid.safeParse(parsed.data.shopId).success)
        throw new PermanentError(`invalid ${envelope.type} payload`);
      shops.add(parsed.data.shopId);
    }
    for (const shopId of shops) await this.lifecycle.deleteShopData(shopId);
  }
}
