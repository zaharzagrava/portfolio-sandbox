import { assertNever } from '@app/common/core/assert-never';

/**
 * Order state machine (S10 FR-033, AS-54). Pure: `decide(status, command)` says whether a command applies, was already
 * applied (an idempotent repeat) or is invalid for that status.
 *
 *   PENDING ──reserve──► RESERVED ──markPaid──► PAID ──► FULFILLING ──► SHIPPED ──► DELIVERED
 *      │ cancel(out_of_stock)   │ cancel(payment_failed | hold_expired | user_cancelled)
 *      └────────────────────────┴──► CANCELLED
 *   PAID | FULFILLING ──refund──► REFUNDED
 */
export const ORDER_STATUSES = [
  'PENDING',
  'RESERVED',
  'PAID',
  'FULFILLING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  'CANCELLED',
  'REFUNDED',
  'DELIVERED',
];

export const CANCEL_REASONS = [
  'out_of_stock',
  'payment_failed',
  'hold_expired',
  'user_cancelled',
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export type OrderCommand =
  | { type: 'reserve' }
  | { type: 'markPaid'; paymentRef: string }
  | { type: 'cancel'; reason: CancelReason }
  | { type: 'startFulfilment' }
  | { type: 'ship'; trackingCode: string }
  | { type: 'deliver' }
  | { type: 'refund'; reason: string };

export type Decision =
  | { kind: 'apply'; to: OrderStatus }
  | { kind: 'already_applied' }
  | { kind: 'invalid' };

const APPLY = (to: OrderStatus): Decision => ({ kind: 'apply', to });
const SAME: Decision = { kind: 'already_applied' };
const INVALID: Decision = { kind: 'invalid' };

/** Statuses a payment has already been taken in. */
const PAID_OR_LATER: readonly OrderStatus[] = [
  'PAID',
  'FULFILLING',
  'SHIPPED',
  'DELIVERED',
  'REFUNDED',
];

export function decide(status: OrderStatus, command: OrderCommand): Decision {
  switch (command.type) {
    case 'reserve':
      return status === 'PENDING' ? APPLY('RESERVED') : INVALID;
    case 'markPaid':
      if (status === 'RESERVED') return APPLY('PAID');
      return PAID_OR_LATER.includes(status) ? SAME : INVALID;
    case 'cancel':
      if (status === 'CANCELLED') return SAME;
      if (command.reason === 'out_of_stock')
        return status === 'PENDING' ? APPLY('CANCELLED') : INVALID;
      return status === 'RESERVED' ? APPLY('CANCELLED') : INVALID;
    case 'startFulfilment':
      return status === 'PAID' ? APPLY('FULFILLING') : INVALID;
    case 'ship':
      return status === 'FULFILLING' ? APPLY('SHIPPED') : INVALID;
    case 'deliver':
      return status === 'SHIPPED' ? APPLY('DELIVERED') : INVALID;
    case 'refund':
      if (status === 'REFUNDED') return SAME;
      return status === 'PAID' || status === 'FULFILLING'
        ? APPLY('REFUNDED')
        : INVALID;
    default:
      return assertNever(command);
  }
}

/** Statuses from which `command` applies, and where it leads (legacy callers that guard with `status IN (...)`). */
export function transitionFor(command: OrderCommand): {
  from: readonly OrderStatus[];
  to: OrderStatus;
} {
  const from: OrderStatus[] = [];
  let to: OrderStatus | undefined;
  for (const status of ORDER_STATUSES) {
    const d = decide(status, command);
    if (d.kind === 'apply') {
      from.push(status);
      to = d.to;
    }
  }
  return { from, to: to as OrderStatus };
}

export function canTransition(
  from: OrderStatus,
  command: OrderCommand,
): boolean {
  return decide(from, command).kind === 'apply';
}

/** States in which reserved stock must be returned. */
export const RELEASES_STOCK: readonly OrderStatus[] = ['CANCELLED'];
