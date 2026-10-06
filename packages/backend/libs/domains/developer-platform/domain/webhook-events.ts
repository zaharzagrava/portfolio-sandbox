/** Event types shops can subscribe to (the public contract; additions are non-breaking, removals need a deprecation). */
export const WEBHOOK_EVENT_TYPES = ['order.paid', 'order.cancelled', 'product.stock_low', 'webhook.ping'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_QUEUE = 'webhook-deliveries.fifo';

/** The SQS message: everything needed to (re)deliver, nothing secret. */
export interface WebhookDelivery {
  endpointId: string;
  eventId: string;
  type: WebhookEventType;
  /** Exact JSON that gets signed and POSTed. */
  body: string;
  /** 0 = first pass through the FIFO; ≥1 = long-backoff lane (SD-29 jobs). */
  attempt: number;
}
