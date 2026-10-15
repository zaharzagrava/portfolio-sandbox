import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import {
  productEventSchemas,
  webhookOrderEventSchemas,
  webhookPayoutEventSchemas,
  webhookShopDeletedSchema,
  type WebhookOrderPaidEvent,
  type WebhookOrderRefundedEvent,
  type WebhookOrderStatusEvent,
  type WebhookPayoutFailedEvent,
  type WebhookPayoutPaidEvent,
} from '@marketplace-sandbox/contracts';
import { OrderQueryService } from '@app/domains/orders';
import type { EventDefinition } from '@app/infrastructure/events/define-event';
import { topicFor } from '@app/infrastructure/events/event-envelope';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import {
  WebhookRoutingService,
  type RoutedEvent,
} from '../application/webhook-routing.service';
import { WebhookLifecycleService } from '../application/webhook-lifecycle.service';
import { recordDeadLetter } from '../application/webhook-metrics';
import {
  affectedOrderShops,
  mapOrderStatusEvent,
  mapPayoutEvent,
  mapProductEvent,
  sliceOrderForShop,
  webhookEventId,
  type MappedEvent,
} from '../domain/webhook-event-mapper';
import { decideStockLow } from '../domain/stock-low';

/**
 * The S53 consumers of the webhook capability (S43 FR-021, plan "Edges"). Each is its own consumer group with its own
 * offsets and dead letters. A consumer holds no state: it validates the source event against the schema in
 * `packages/contracts` (a payload that can never be applied is a `PermanentError`, dead-lettered with no effect and no
 * receipt), maps it with the pure mapper, and hands the result to the routing service, which keeps the receipt per source
 * event. No other domain's table is read.
 */

export const WEBHOOK_ROUTER_ORDERS = 'webhook-router-orders';
export const WEBHOOK_ROUTER_PRODUCTS = 'webhook-router-products';
export const WEBHOOK_ROUTER_PAYOUTS = 'webhook-router-payouts';
export const WEBHOOK_SHOP_DELETED = 'webhook-shop-deleted';

/**
 * Whether `order.cancelled` / `order.refunded` without `shopIds` (S10 has not shipped the field yet) may be completed
 * through the orders service. Off by default: the event is then invalid (AS-31). Plan, Complexity Tracking: remove with
 * the S10 field.
 */
export const WEBHOOK_ORDER_SHOPS_FALLBACK = Symbol(
  'WEBHOOK_ORDER_SHOPS_FALLBACK',
);

/**
 * The contract of a source event as this consumer reads it. The projection runner validates the payload with
 * `schema` and hands over the parsed copy, so the schema must keep every field the consumer reads. Not registered in the
 * event registry: the owning domain registers its own definition of the same type.
 */
function consumed<T extends string, A extends string, S extends z.ZodType>(
  type: T,
  aggregateType: A,
  schema: S,
): HandledEvent {
  const definition: EventDefinition<T, A, S> = {
    type,
    version: 1,
    aggregateType,
    topic: topicFor(aggregateType),
    schema,
    carries: 'delta',
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The payload as the contract defines it, or `PermanentError` (never a value of the message in the reason). */
function parsePayload<S extends z.ZodType>(
  schema: S,
  envelope: EventEnvelope,
): z.infer<S> {
  const parsed = schema.safeParse(envelope.payload);
  if (!parsed.success)
    throw poison(envelope.eventId, `invalid ${envelope.type} payload`);
  return parsed.data;
}

/** A source event that can never be applied: counted once on the router lane, then dead-lettered by the framework. */
function poison(sourceEventId: string, reason: string): PermanentError {
  recordDeadLetter('router', sourceEventId);
  return new PermanentError(reason);
}

function routed(mapped: MappedEvent, source: EventEnvelope): RoutedEvent {
  return {
    shopId: mapped.shopId,
    type: mapped.type,
    eventId: webhookEventId(source.eventId, mapped.shopId),
    created: source.occurredAt,
    resource: mapped.resource,
    resourceVersion: mapped.resourceVersion,
    object: mapped.object,
  };
}

const sourceOf = (envelope: EventEnvelope) => ({
  eventId: envelope.eventId,
  occurredAt: envelope.occurredAt,
});

// ---------------------------------------------------------------- orders

@Injectable()
export class WebhookOrdersConsumer implements Projector {
  readonly name = WEBHOOK_ROUTER_ORDERS;
  readonly topics = [topicFor('orders')];
  readonly idempotency: IdempotencyMechanism = 'inbox';
  readonly handles: HandledEvent[] = [
    consumed('order.paid', 'orders', webhookOrderEventSchemas['order.paid']),
    consumed(
      'order.cancelled',
      'orders',
      webhookOrderEventSchemas['order.cancelled'],
    ),
    consumed(
      'order.refunded',
      'orders',
      webhookOrderEventSchemas['order.refunded'],
    ),
  ];
  readonly attempts = 5;

  constructor(
    private readonly routing: WebhookRoutingService,
    @Optional()
    @Inject(WEBHOOK_ORDER_SHOPS_FALLBACK)
    private readonly fallback: boolean = false,
    @Optional() private readonly orders?: OrderQueryService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      const mapped = await this.map(envelope);
      if (mapped)
        await this.routing.route(
          this.name,
          sourceOf(envelope),
          mapped.map((m) => routed(m, envelope)),
        );
    }
  }

  private async map(envelope: EventEnvelope): Promise<MappedEvent[] | null> {
    switch (envelope.type) {
      case 'order.paid': {
        const order: WebhookOrderPaidEvent = parsePayload(
          webhookOrderEventSchemas['order.paid'],
          envelope,
        );
        return affectedOrderShops(order)
          .map((shopId) => sliceOrderForShop(order, shopId))
          .filter((m): m is MappedEvent => m !== null);
      }
      case 'order.cancelled': {
        const order: WebhookOrderStatusEvent = parsePayload(
          webhookOrderEventSchemas['order.cancelled'],
          envelope,
        );
        return (
          await this.shopsOf(envelope.eventId, order.orderId, order.shopIds)
        ).map((shopId) =>
          mapOrderStatusEvent('order.cancelled', order, shopId),
        );
      }
      case 'order.refunded': {
        const order: WebhookOrderRefundedEvent = parsePayload(
          webhookOrderEventSchemas['order.refunded'],
          envelope,
        );
        return (
          await this.shopsOf(envelope.eventId, order.orderId, order.shopIds)
        ).map((shopId) => mapOrderStatusEvent('order.refunded', order, shopId));
      }
      default:
        return null;
    }
  }

  /** `shopIds` from the event; without them an invalid event, unless the flagged fallback asks the orders service. */
  private async shopsOf(
    sourceEventId: string,
    orderId: string,
    shopIds: string[] | undefined,
  ): Promise<string[]> {
    if (shopIds) return [...new Set(shopIds)];
    if (!this.fallback || !this.orders)
      throw poison(sourceEventId, 'the order event names no shops');
    const lines =
      (await this.orders.getOrderLines([orderId])).get(orderId) ?? [];
    return [
      ...new Set(
        lines.map((l) => l.shopId).filter((id): id is string => id !== null),
      ),
    ];
  }
}

// ---------------------------------------------------------------- products

const SNAPSHOT_TYPES = new Set([
  'catalog.product_created',
  'catalog.product_updated',
  'catalog.product_restored',
]);

@Injectable()
export class WebhookProductsConsumer implements Projector {
  readonly name = WEBHOOK_ROUTER_PRODUCTS;
  readonly topics = [topicFor('products')];
  readonly idempotency: IdempotencyMechanism = 'inbox';
  // `catalog.product_changed` is deliberately absent: the framework skips it
  readonly handles: HandledEvent[] = (
    Object.keys(productEventSchemas) as (keyof typeof productEventSchemas)[]
  ).map((type) => consumed(type, 'products', productEventSchemas[type]));
  readonly attempts = 5;

  constructor(private readonly routing: WebhookRoutingService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      const type = envelope.type as keyof typeof productEventSchemas;
      const schema = productEventSchemas[type];
      if (!schema) continue;
      const payload = parsePayload(schema, envelope);
      const out: RoutedEvent[] = [];
      const mapped = mapProductEvent(
        envelope.type,
        payload as Parameters<typeof mapProductEvent>[1],
      );
      if (mapped) out.push(routed(mapped, envelope));
      if (SNAPSHOT_TYPES.has(envelope.type)) {
        const snapshot = payload as z.infer<
          (typeof productEventSchemas)['catalog.product_updated']
        >;
        const decision = decideStockLow({
          productId: snapshot.productId,
          shopId: snapshot.shopId,
          title: snapshot.title,
          quantity: snapshot.quantity,
          changedFields: snapshot.changedFields,
          isSandbox: snapshot.isSandbox,
          occurredAt: envelope.occurredAt,
        });
        if (decision.emit)
          out.push({
            shopId: snapshot.shopId,
            type: 'product.stock_low',
            eventId: decision.eventId,
            created: envelope.occurredAt,
            resource: 'product',
            resourceVersion: decision.resourceVersion,
            object: decision.object,
          });
      }
      await this.routing.route(this.name, sourceOf(envelope), out);
    }
  }
}

// ---------------------------------------------------------------- payouts

@Injectable()
export class WebhookPayoutsConsumer implements Projector {
  readonly name = WEBHOOK_ROUTER_PAYOUTS;
  readonly topics = [topicFor('payouts')];
  readonly idempotency: IdempotencyMechanism = 'inbox';
  // other payout types (cancelled, in doubt, discrepancy) are absent: the framework skips them
  readonly handles: HandledEvent[] = [
    consumed(
      'payout.paid',
      'payouts',
      webhookPayoutEventSchemas['payout.paid'],
    ),
    consumed(
      'payout.failed',
      'payouts',
      webhookPayoutEventSchemas['payout.failed'],
    ),
  ];
  readonly attempts = 5;

  constructor(private readonly routing: WebhookRoutingService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      if (envelope.type !== 'payout.paid' && envelope.type !== 'payout.failed')
        continue;
      const payload: WebhookPayoutPaidEvent | WebhookPayoutFailedEvent =
        parsePayload(webhookPayoutEventSchemas[envelope.type], envelope);
      const mapped = mapPayoutEvent(envelope.type, payload);
      await this.routing.route(
        this.name,
        sourceOf(envelope),
        mapped ? [routed(mapped, envelope)] : [],
      );
    }
  }
}

// ---------------------------------------------------------------- shop deleted

@Injectable()
export class WebhookShopDeletedConsumer implements Projector {
  readonly name = WEBHOOK_SHOP_DELETED;
  readonly topics = [topicFor('tenancy')];
  readonly idempotency: IdempotencyMechanism = 'inbox';
  readonly handles: HandledEvent[] = [
    consumed('tenancy.shop_deleted', 'tenancy', webhookShopDeletedSchema),
  ];
  readonly attempts = 5;

  constructor(
    private readonly routing: WebhookRoutingService,
    private readonly lifecycle: WebhookLifecycleService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const envelope of events) {
      if (envelope.type !== 'tenancy.shop_deleted') continue;
      const { shopId } = parsePayload(webhookShopDeletedSchema, envelope);
      // the id reaches SQL and cache keys: anything but a UUID is poison
      if (!UUID.test(shopId))
        throw poison(envelope.eventId, 'invalid tenancy.shop_deleted payload');
      await this.routing.once(this.name, envelope.eventId, async () => {
        await this.lifecycle.purgeShop(shopId);
      });
    }
  }
}
