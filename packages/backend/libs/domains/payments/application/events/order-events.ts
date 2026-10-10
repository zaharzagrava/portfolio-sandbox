import { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { lazy, sharedEvent } from './shared-event';

/**
 * `orders.events` as consumed by payments (the order copy and the order-driven compensation). The producer is orders;
 * payments never imports it (no `orders ↔ payments` cycle), it builds the same contracts from `packages/contracts`.
 */
export const orderEvents = lazy(() => ({
  reserved: sharedEvent(
    'order.reserved',
    'orders',
    1,
    orderEventSchemas['order.reserved'],
  ),
  paid: sharedEvent('order.paid', 'orders', 1, orderEventSchemas['order.paid']),
  cancelled: sharedEvent(
    'order.cancelled',
    'orders',
    1,
    orderEventSchemas['order.cancelled'],
  ),
}));
