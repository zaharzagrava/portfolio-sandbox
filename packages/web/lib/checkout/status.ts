import type { OrderDto } from '@marketplace-sandbox/contracts';

type OrderStatus = OrderDto['status'];

const CONFIRMED: ReadonlySet<string> = new Set<OrderStatus>(['PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED']);

/**
 * The only decision in the app that an order is "confirmed" (W03 SC-003, data-model "Order status -> UI"): `PAID` and the
 * states after it. A completed payment on a `RESERVED` order is not confirmed. Anything unknown is not confirmed.
 */
export function isConfirmed(status: OrderStatus): boolean {
  return CONFIRMED.has(status);
}
