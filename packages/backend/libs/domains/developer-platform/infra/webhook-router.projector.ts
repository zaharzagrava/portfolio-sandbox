import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { createHash } from 'node:crypto';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { OrderCancelled, OrderPaid } from '@app/domains/orders';
import { KafkaTopicGroup } from '@app/infrastructure/outbox/outbox.model';
import { ApiVersion, isApiVersion, LATEST_VERSION, transformForVersion } from '../domain/versioning';
import { WebhookEndpointsService } from '../application/webhook-endpoints.service';
import { WEBHOOK_QUEUE, WebhookDelivery, WebhookEventType } from '../domain/webhook-events';

const LOW_STOCK = 5;

interface ShopEvent {
  shopId: string;
  type: WebhookEventType;
  /** Stable per (source event, shop): receivers dedupe on it (at-least-once delivery). */
  eventId: string;
  created: string;
  object: Record<string, unknown>;
  resource: 'order' | 'product';
}

/**
 * Domain events → per-shop webhook events → one FIFO message per subscribed
 * endpoint (MessageGroupId = endpointId: per-endpoint ordering and isolation -
 * a dead endpoint only blocks its own group). Fat payloads, rendered in each
 * endpoint's pinned API version (same transformers as the REST API).
 */
@Injectable()
export class WebhookRouterProjector implements Projector {
  readonly name = 'webhook-router';
  readonly topics = [OrderPaid.topic, KafkaTopicGroup.PRODUCTS_EVENTS];

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly endpoints: WebhookEndpointsService,
    private readonly queue: TaskQueue,
    private readonly redis: RedisService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const event of events) {
      for (const shopEvent of await this.toShopEvents(event)) await this.fanOut(shopEvent);
    }
  }

  async fanOut(e: ShopEvent): Promise<number> {
    const subscribers = await this.endpoints.subscribers(e.shopId, e.type);
    const messages = subscribers.map((endpoint) => {
      const version: ApiVersion = isApiVersion(endpoint.apiVersion) ? endpoint.apiVersion : LATEST_VERSION;
      const body = JSON.stringify({
        id: e.eventId,
        object: 'event',
        type: e.type,
        created: e.created,
        api_version: version,
        data: { object: transformForVersion(e.resource, e.object, version) },
      });
      return {
        body: { endpointId: endpoint.id, eventId: e.eventId, type: e.type, body, attempt: 0 } satisfies WebhookDelivery,
        options: { groupId: endpoint.id, deduplicationId: createHash('sha256').update(`${e.eventId}:${endpoint.id}`).digest('hex').slice(0, 64) },
      };
    });
    if (messages.length) await this.queue.enqueueBatch(WEBHOOK_QUEUE, messages);
    return messages.length;
  }

  private async toShopEvents(event: EventEnvelope): Promise<ShopEvent[]> {
    const evtId = (shopId: string) => `evt_${createHash('sha256').update(`${event.eventId}:${shopId}`).digest('hex').slice(0, 24)}`;

    const paid = OrderPaid.match(event);
    if (paid) {
      const byShop = new Map<string, typeof paid.payload.lines>();
      for (const line of paid.payload.lines) if (line.shopId) byShop.set(line.shopId, [...(byShop.get(line.shopId) ?? []), line]);
      return [...byShop].map(([shopId, lines]) => ({
        shopId,
        type: 'order.paid' as const,
        eventId: evtId(shopId),
        created: event.occurredAt,
        resource: 'order' as const,
        object: {
          id: event.aggregateId,
          object: 'order',
          status: 'PAID',
          total: { amount: lines.reduce((s, l) => s + l.price * l.quantity, 0), currency: paid.payload.currency ?? 'usd' },
          lines: lines.map((l) => ({ product_id: l.productId, quantity: l.quantity, unit_price: l.price })),
        },
      }));
    }

    const cancelled = OrderCancelled.match(event);
    if (cancelled) {
      const shops = await this.sequelize.query<{ shopId: string }>(`SELECT DISTINCT "shopId" FROM "ShopOrder" WHERE "bisOrderId" = :id AND "shopId" IS NOT NULL`, {
        type: QueryTypes.SELECT,
        replacements: { id: event.aggregateId },
      });
      return shops.map(({ shopId }) => ({
        shopId,
        type: 'order.cancelled' as const,
        eventId: evtId(shopId),
        created: event.occurredAt,
        resource: 'order' as const,
        object: { id: event.aggregateId, object: 'order', status: 'CANCELLED', reason: cancelled.payload.reason },
      }));
    }

    // products.events (outbox, payload {productId}): low-stock crossing, at most one alert per product per day.
    const productId = (event.payload as { productId?: string } | undefined)?.productId;
    if (event.aggregateType === 'products' || productId) {
      if (!productId) return [];
      const [p] = await this.sequelize.query<{ id: string; shopId: string | null; title: string; quantity: number; price: string }>(
        `SELECT id, "shopId", title, quantity, price FROM "Product" WHERE id = :productId`,
        { type: QueryTypes.SELECT, replacements: { productId } },
      );
      if (!p?.shopId || p.quantity > LOW_STOCK) return [];
      const day = new Date().toISOString().slice(0, 10);
      if (!(await this.redis.client.set(`wh:lowstock:${p.id}:${day}`, '1', 'EX', 86_400, 'NX'))) return [];
      return [
        {
          shopId: p.shopId,
          type: 'product.stock_low',
          eventId: `evt_${createHash('sha256').update(`lowstock:${p.id}:${day}`).digest('hex').slice(0, 24)}`,
          created: new Date().toISOString(),
          resource: 'product',
          object: { id: p.id, object: 'product', title: p.title, stock: p.quantity, price: { amount: Number(p.price), currency: 'usd' } },
        },
      ];
    }
    return [];
  }
}
