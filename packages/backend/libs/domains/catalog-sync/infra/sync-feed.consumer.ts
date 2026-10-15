import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import {
  productEventSchemas,
  syncChangeDataSchema,
  type ProductSnapshot,
} from '@marketplace-sandbox/contracts';
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
import { Inject } from '@nestjs/common';
import {
  SYNC_CLOCK,
  SYNC_FEED_REPOSITORY,
  type Clock,
  type SyncFeedRepository,
} from '../domain/ports';
import { offlineFeedLagGauge } from '../application/offline-sync-metrics';

export const OFFLINE_FEED_CONSUMER = 'catalog-sync-offline-feed';

type EventType = keyof typeof productEventSchemas;

/** The contract of a source event as this consumer reads it (the catalog registers the real definition). */
function consumed<T extends EventType, S extends z.ZodType>(
  type: T,
  schema: S,
): HandledEvent {
  const definition: EventDefinition<T, 'products', S> = {
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
 * The change feed of offline sync is a read model of `catalog.product_*` events (R3, FR-024). One entry per accepted
 * event under the shop's feed-state lock (`seq` without gaps); a repeated version is `duplicate`, an older one `stale`
 * (version guard, `natural` idempotency). An event that cannot be read is dead-lettered and the next one goes on.
 * The consumer group differs from the integrations one, so both receive every event.
 */
@Injectable()
export class SyncFeedConsumer implements Projector {
  readonly name = OFFLINE_FEED_CONSUMER;
  readonly topics = [topicFor('products')];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = (
    Object.keys(productEventSchemas) as EventType[]
  ).map((type) => consumed(type, productEventSchemas[type]));

  constructor(
    @Inject(SYNC_FEED_REPOSITORY) private readonly feed: SyncFeedRepository,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    // Read every event first: an invalid one is dead-lettered before the feed changes.
    const entries = events.flatMap((envelope) => {
      const entry = this.parse(envelope);
      return entry ? [entry] : [];
    });
    for (const entry of entries) {
      await this.feed.append(entry.shopId, entry.input);
      offlineFeedLagGauge.set(
        Math.max(
          0,
          (this.clock.now().getTime() - entry.input.occurredAt.getTime()) /
            1_000,
        ),
      );
    }
  }

  private parse(envelope: EventEnvelope) {
    const schema = productEventSchemas[envelope.type as EventType];
    if (!schema) {
      // The framework hands over only the types in `handles`, so a type of the catalog that is not handled and still
      // arrives here is a broken contract and goes to the dead letters; other families are not this feed's business.
      if (envelope.type.startsWith('catalog.product_'))
        throw new PermanentError(`unknown ${envelope.type} event`);
      return null;
    }
    if (envelope.version !== 1)
      throw new PermanentError(`unsupported ${envelope.type} version`);
    const result = schema.safeParse(envelope.payload);
    if (!result.success)
      throw new PermanentError(`invalid ${envelope.type} payload`);
    const occurredAt = new Date(envelope.occurredAt);
    if (Number.isNaN(occurredAt.getTime()))
      throw new PermanentError(`invalid ${envelope.type} timestamp`);

    if (envelope.type === 'catalog.product_deleted') {
      const payload = result.data as {
        productId: string;
        shopId: string;
        productVersion: number;
      };
      return {
        shopId: payload.shopId,
        input: {
          productId: payload.productId,
          version: payload.productVersion,
          deleted: true,
          data: null,
          occurredAt,
        },
      };
    }
    const snapshot = result.data as ProductSnapshot;
    const data = syncChangeDataSchema.safeParse({
      title: snapshot.title,
      description: snapshot.description,
      priceMinor: snapshot.priceMinor,
      currency: snapshot.currency,
      quantity: snapshot.quantity,
      status: snapshot.status,
    });
    if (!data.success)
      throw new PermanentError(`invalid ${envelope.type} payload`);
    return {
      shopId: snapshot.shopId,
      input: {
        productId: snapshot.productId,
        version: snapshot.productVersion,
        deleted: false,
        data: data.data,
        occurredAt,
      },
    };
  }
}
