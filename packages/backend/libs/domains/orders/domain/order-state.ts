import { assertNever } from '@app/common/core/assert-never';

/**
 * Checkout order state machine (lesson 10/07 #19):
 *
 *   PENDING ──reserve──► RESERVED ──payment ok──► PAID ──► FULFILLING ──► SHIPPED ──► DELIVERED
 *      │                    │ payment failed / hold expired / user cancel
 *      └────────────────────┴──► CANCELLED (stock released)
 *   PAID ──refund──► REFUNDED
 */
export const ORDER_STATUSES = ['PENDING', 'RESERVED', 'PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type OrderCommand =
  | { type: 'reserve' }
  | { type: 'markPaid'; paymentId: string }
  | { type: 'cancel'; reason: 'payment_failed' | 'hold_expired' | 'user_cancelled' | 'out_of_stock' }
  | { type: 'startFulfilment' }
  | { type: 'ship'; trackingCode: string }
  | { type: 'deliver' }
  | { type: 'refund'; reason: string };

/** Which states each command may start from. Anything else is an invalid transition (409). */
const TRANSITIONS = {
  reserve: { from: ['PENDING'], to: 'RESERVED' },
  markPaid: { from: ['RESERVED'], to: 'PAID' },
  cancel: { from: ['PENDING', 'RESERVED'], to: 'CANCELLED' },
  startFulfilment: { from: ['PAID'], to: 'FULFILLING' },
  ship: { from: ['FULFILLING'], to: 'SHIPPED' },
  deliver: { from: ['SHIPPED'], to: 'DELIVERED' },
  refund: { from: ['PAID', 'FULFILLING'], to: 'REFUNDED' },
} as const satisfies Record<OrderCommand['type'], { from: readonly OrderStatus[]; to: OrderStatus }>;

export function transitionFor(command: OrderCommand): { from: readonly OrderStatus[]; to: OrderStatus } {
  switch (command.type) {
    case 'reserve':
    case 'markPaid':
    case 'cancel':
    case 'startFulfilment':
    case 'ship':
    case 'deliver':
    case 'refund':
      return TRANSITIONS[command.type];
    default:
      return assertNever(command);
  }
}

export function canTransition(from: OrderStatus, command: OrderCommand): boolean {
  return (transitionFor(command).from as readonly OrderStatus[]).includes(from);
}

/** States in which reserved stock must be returned. */
export const RELEASES_STOCK: readonly OrderStatus[] = ['CANCELLED'];
