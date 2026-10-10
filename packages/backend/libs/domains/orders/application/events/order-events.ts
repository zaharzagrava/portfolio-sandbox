import { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * `orders.events` (key = orderId → per-order ordering), contract version 1 (specs/domains/S10-cart-checkout/contracts/events.md).
 * Every payload carries `orderVersion`; schemas live in `packages/contracts` so consumers parse the same shape.
 * Consumers: notifications, analytics, leaderboards, seller dashboards, webhooks.
 */
export const ORDERS_AGGREGATE = {
  aggregateType: 'orders',
  retention: 'full-history',
} as const;

export const OrderReserved = defineEvent(
  'order.reserved',
  'orders',
  1,
  orderEventSchemas['order.reserved'],
);

export const OrderPaid = defineEvent(
  'order.paid',
  'orders',
  1,
  orderEventSchemas['order.paid'],
);

export const OrderCancelled = defineEvent(
  'order.cancelled',
  'orders',
  1,
  orderEventSchemas['order.cancelled'],
);

export const OrderRefunded = defineEvent(
  'order.refunded',
  'orders',
  1,
  orderEventSchemas['order.refunded'],
);

export const OrderFulfilmentChanged = defineEvent(
  'order.fulfilment_changed',
  'orders',
  1,
  orderEventSchemas['order.fulfilment_changed'],
);
