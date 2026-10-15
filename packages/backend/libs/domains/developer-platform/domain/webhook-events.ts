import { createHash } from 'node:crypto';
import {
  WEBHOOK_EVENT_TYPES,
  type WebhookEventTypeName,
} from '@marketplace-sandbox/contracts';

/**
 * Event types shops can subscribe to (the public contract; additions are non-breaking, removals need a deprecation).
 * The list of names lives in `packages/contracts` so clients and this catalogue cannot drift.
 */
export { WEBHOOK_EVENT_TYPES };
export type WebhookEventType = WebhookEventTypeName;

export interface WebhookEventCatalogueEntry {
  type: WebhookEventType;
  description: string;
  resource: 'order' | 'product' | 'payout' | 'ping';
  /** Version of the platform contract in which the type appeared. */
  since: string;
}

/** FR-020: exactly these 11 types, in this fixed order (AS-14). */
export const WEBHOOK_EVENT_CATALOGUE: readonly WebhookEventCatalogueEntry[] = [
  {
    type: 'order.paid',
    description: "An order containing this shop's products was paid.",
    resource: 'order',
    since: '2026-01-15',
  },
  {
    type: 'order.cancelled',
    description: "An order containing this shop's products was cancelled.",
    resource: 'order',
    since: '2026-01-15',
  },
  {
    type: 'order.refunded',
    description: "An order containing this shop's products was refunded.",
    resource: 'order',
    since: '2026-10-01',
  },
  {
    type: 'product.created',
    description: 'A product of this shop was created.',
    resource: 'product',
    since: '2026-10-01',
  },
  {
    type: 'product.updated',
    description: 'A product of this shop was changed or restored.',
    resource: 'product',
    since: '2026-10-01',
  },
  {
    type: 'product.archived',
    description: 'A product of this shop was archived.',
    resource: 'product',
    since: '2026-10-01',
  },
  {
    type: 'product.deleted',
    description: 'A product of this shop was deleted.',
    resource: 'product',
    since: '2026-10-01',
  },
  {
    type: 'product.stock_low',
    description:
      'A product of this shop is at or below 5 units (once per product per UTC day).',
    resource: 'product',
    since: '2026-01-15',
  },
  {
    type: 'payout.paid',
    description: 'A payout to this shop was sent.',
    resource: 'payout',
    since: '2026-10-01',
  },
  {
    type: 'payout.failed',
    description: 'A payout to this shop failed.',
    resource: 'payout',
    since: '2026-10-01',
  },
  {
    type: 'webhook.ping',
    description: 'A test event sent to one endpoint on request.',
    resource: 'ping',
    since: '2026-01-15',
  },
];

/** `evt_` plus 32 hex characters of a SHA-256 over the parts: the same parts always give the same id (FR-022). */
export function deriveWebhookEventId(...parts: string[]): string {
  return `evt_${createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32)}`;
}

/** The ordered lane (SQS FIFO, group = endpoint id). Its message is `DeliveryMessage` in `webhook-ports.ts`. */
export const WEBHOOK_QUEUE = 'webhook-deliveries.fifo';

/**
 * Receives after which the queue's redrive policy moves a message to the dead-letter queue (`maxReceiveCount` of
 * `webhook-deliveries.fifo` in `elasticmq.conf` and the stack, FR-035). The receive that reaches it is the last one.
 */
export const DELIVERY_MAX_RECEIVES = 5;
