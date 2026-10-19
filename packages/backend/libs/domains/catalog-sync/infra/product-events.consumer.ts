import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import {
  productEventSchemas,
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
import { IntegrationHealthService } from '../application/integration-health.service';
import { PRODUCT_ENTITY } from '../application/integration-view.service';
import { StockSyncService } from '../application/stock-sync.service';
import {
  INTEGRATION_REPOSITORY,
  LINK_REPOSITORY,
  ProviderCallError,
  type IntegrationRecord,
  type IntegrationRepository,
  type LinkRepository,
} from '../domain/ports';

export const PRODUCT_EVENTS_CONSUMER = 'catalog-sync-product-events';

type EventType = keyof typeof productEventSchemas;

/** The contract of a source event as this consumer reads it (the owning domain registers its own definition). */
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

type Snapshot = ProductSnapshot;
type Deleted = z.infer<(typeof productEventSchemas)['catalog.product_deleted']>;

interface Parsed {
  productId: string;
  shopId: string;
  version: number;
  deleted: boolean;
  snapshot?: Snapshot;
  /** Any event of the batch for this product changed the quantity (coalescing keeps only the latest state). */
  quantityChanged: boolean;
}

/**
 * S05's `catalog.product_*` events on `products.events` become stock pushes (FR-042, AS-40, AS-44, AS-46). The events
 * carry the full state, so a batch is reduced to the latest event per product (`coalesce`; `project` also does it, for a
 * direct call). Idempotency is `natural`: the link's `lastLocalVersion` ignores a repeated or older version, an echo of
 * our own apply has a quantity equal to the base, and the provider write is conditional. (`inbox` would run the provider
 * calls inside the inbox transaction.) A provider failure is logged and left to the next event, pull or reconciliation:
 * pausing the partition would stall every other shop's events.
 */
@Injectable()
export class ProductEventsConsumer implements Projector {
  private readonly logger = new Logger(ProductEventsConsumer.name);
  readonly name = PRODUCT_EVENTS_CONSUMER;
  readonly topics = [topicFor('products')];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly coalesce = true;
  readonly attempts = 5;
  // `catalog.product_changed` is deliberately absent: the framework skips it.
  readonly handles: HandledEvent[] = (
    Object.keys(productEventSchemas) as EventType[]
  ).map((type) => consumed(type, productEventSchemas[type]));

  constructor(
    private readonly stock: StockSyncService,
    @Inject(LINK_REPOSITORY) private readonly links: LinkRepository,
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    private readonly health: IntegrationHealthService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    // Validate first: an invalid event is dead-lettered before anything is sent.
    const latest = new Map<string, Parsed>();
    for (const envelope of events) {
      const parsed = this.parse(envelope);
      if (!parsed) continue;
      const previous = latest.get(parsed.productId);
      const quantityChanged =
        parsed.quantityChanged || (previous?.quantityChanged ?? false);
      if (!previous || parsed.version >= previous.version)
        latest.set(parsed.productId, { ...parsed, quantityChanged });
      else previous.quantityChanged = quantityChanged;
    }

    const live = new Map<string, IntegrationRecord | null>();
    for (const item of latest.values()) {
      if (item.deleted) {
        await this.links.ignoreByLocal(item.shopId, item.productId);
        continue;
      }
      const snapshot = item.snapshot!;
      if (snapshot.isSandbox || !item.quantityChanged) continue;
      // The event's `shopId` is in the predicate: an event cannot reach another shop's link.
      const links = await this.links.findByLocal(item.shopId, item.productId);
      for (const link of links) {
        if (link.entity !== PRODUCT_ENTITY || link.state !== 'ACTIVE') continue;
        if (!live.has(link.integrationId))
          live.set(
            link.integrationId,
            await this.integrations.findById(link.integrationId),
          );
        const integration = live.get(link.integrationId);
        if (!integration || integration.shopId !== item.shopId) continue;
        if (integration.status !== 'ACTIVE' || !integration.credentialsSealed)
          continue;
        try {
          await this.stock.pushLocal(integration, link, {
            quantity: snapshot.quantity,
            version: item.version,
          });
        } catch (error) {
          if (!(error instanceof ProviderCallError)) throw error;
          // A credential that no longer works stops the pushes until the seller reconnects (AS-60).
          if (error.kind === 'auth_failed')
            await this.health.markNeedsReauth(integration);
          else
            await this.integrations.recordError(
              integration.id,
              `stock_push_failed: ${error.kind}`,
            );
          this.logger.warn({
            action: 'catalog-sync.stock_push_failed',
            integrationId: integration.id,
            shopId: integration.shopId,
            reason: error.kind,
          });
        }
      }
    }
  }

  private parse(envelope: EventEnvelope): Parsed | null {
    const schema = productEventSchemas[envelope.type as EventType];
    if (!schema) return null;
    if (envelope.version !== 1)
      throw new PermanentError(`unsupported ${envelope.type} version`);
    const result = schema.safeParse(envelope.payload);
    if (!result.success)
      throw new PermanentError(`invalid ${envelope.type} payload`);
    if (envelope.type === 'catalog.product_deleted') {
      const payload = result.data as Deleted;
      return {
        productId: payload.productId,
        shopId: payload.shopId,
        version: payload.productVersion,
        deleted: true,
        quantityChanged: false,
      };
    }
    const snapshot = result.data as Snapshot;
    return {
      productId: snapshot.productId,
      shopId: snapshot.shopId,
      version: snapshot.productVersion,
      deleted: false,
      snapshot,
      quantityChanged: snapshot.changedFields.includes('quantity'),
    };
  }
}
