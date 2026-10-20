import type { z } from 'zod';
import { orderEventSchemas } from '@marketplace-sandbox/contracts';
import type { EventDefinition } from '@app/infrastructure/events/define-event';
import { topicFor } from '@app/infrastructure/events/event-envelope';

/**
 * The two `orders.events` types affiliate conversions consume, as the consumer framework sees them: marketing does not
 * import the orders domain (orders asks marketing who owns a `ref`, so the reverse edge would be a cycle). The schemas are
 * the contract's; the definitions are deliberately not registered, because the producing domain owns the registered ones
 * (one per process).
 */
function consumed<S extends z.ZodType>(
  type: string,
  schema: S,
): EventDefinition<string, string, S> {
  return {
    type,
    version: 1,
    aggregateType: 'orders',
    topic: topicFor('orders'),
    schema,
    carries: 'delta',
    create() {
      throw new Error(`${type} is consumed by marketing, never produced`);
    },
    match(envelope) {
      return envelope.type === type && envelope.version === 1
        ? { ...envelope, payload: schema.parse(envelope.payload) }
        : null;
    },
  };
}

export const consumedOrderPaid = consumed(
  'order.paid',
  orderEventSchemas['order.paid'],
);
export const consumedOrderRefunded = consumed(
  'order.refunded',
  orderEventSchemas['order.refunded'],
);
