import type { OrderDto, PaymentStatusValue } from '@marketplace-sandbox/contracts';
import { isConfirmed } from './status';

/**
 * The pay step as a closed state machine (W03 FR-051, data-model "Pay phases"). `TRANSITIONS` IS the reducer: a pair that
 * is not in the table returns the same state object, so an impossible pair (such as `submitting` with a failed payment)
 * cannot be represented. Pure: no timers, no network.
 */
export const PAY_PHASES = ['idle', 'tokenizing', 'submitting', 'processing', 'actionRequired', 'confirming', 'unknown', 'failed', 'completed', 'expired'] as const;
export type PayPhase = (typeof PAY_PHASES)[number];

export const PAY_EVENTS = [
  'PRESS_PAY', // the buyer pressed Pay
  'TOKEN_READY', // the provider returned a payment method token
  'TOKEN_FAILED', // the provider refused the fields (errors shown under the fields)
  'ACCEPTED', // `202` on the intent, or `409 payment_already_exists` followed
  'SUBMIT_REJECTED', // the intent request failed with a problem the form recovers from
  'ACTION_REQUIRED', // payment PENDING with requiresAction
  'ACTION_DONE', // the confirmation frame finished; the payment is PENDING again
  'PAYMENT_UNKNOWN', // payment UNKNOWN
  'PAYMENT_COMPLETED', // payment COMPLETED, order not PAID yet
  'ORDER_PAID', // order PAID (or later)
  'PAYMENT_FAILED', // payment FAILED
  'RESERVATION_ENDED', // the hold ended with no payment in progress
] as const;
export type PayEventType = (typeof PAY_EVENTS)[number];
/** Kept as `PayEvent` for the event names; the reducer takes `{type}` objects. */
export type PayEvent = PayEventType;

export type PayState = { readonly phase: PayPhase };
export type PayAction = { readonly type: PayEventType };

const TRANSITIONS: Record<PayPhase, Partial<Record<PayEventType, PayPhase>>> = {
  idle: { PRESS_PAY: 'tokenizing', RESERVATION_ENDED: 'expired' },
  tokenizing: { TOKEN_READY: 'submitting', TOKEN_FAILED: 'idle' },
  submitting: { ACCEPTED: 'processing', SUBMIT_REJECTED: 'idle', ORDER_PAID: 'completed' },
  processing: { ACTION_REQUIRED: 'actionRequired', PAYMENT_UNKNOWN: 'unknown', PAYMENT_COMPLETED: 'confirming', ORDER_PAID: 'completed', PAYMENT_FAILED: 'failed' },
  actionRequired: {
    ACTION_DONE: 'processing',
    RESERVATION_ENDED: 'expired',
    PAYMENT_UNKNOWN: 'unknown',
    PAYMENT_COMPLETED: 'confirming',
    ORDER_PAID: 'completed',
    PAYMENT_FAILED: 'failed',
  },
  confirming: { PAYMENT_UNKNOWN: 'unknown', ORDER_PAID: 'completed' },
  unknown: { PAYMENT_COMPLETED: 'confirming', ORDER_PAID: 'completed', PAYMENT_FAILED: 'failed' },
  failed: {},
  completed: {},
  expired: {},
};

export function payReducer(state: PayState, action: PayAction): PayState {
  const next = TRANSITIONS[state.phase][action.type];
  return next && next !== state.phase ? { phase: next } : state;
}

// --- server data -> phase -----------------------------------------------------------------------------------------------

type OrderStatus = OrderDto['status'];

export type PayServerData = {
  payment: { status: PaymentStatusValue; requiresAction: boolean } | null;
  orderStatus: OrderStatus;
};

export type PayServerView =
  | { kind: 'phase'; phase: PayPhase }
  /** The order ended (AS-43): the page shows the cancelled/refunded panel, whatever the payment says. */
  | { kind: 'order-ended'; reason: 'cancelled' | 'refunded'; paymentArrivedLate: boolean };

const ARRIVED: ReadonlySet<PaymentStatusValue> = new Set<PaymentStatusValue>(['COMPLETED', 'REFUND_PENDING', 'REFUNDED']);

/** The mapping of data-model.md "Mapping from server data". */
export function serverView({ payment, orderStatus }: PayServerData): PayServerView {
  if (orderStatus === 'CANCELLED' || orderStatus === 'REFUNDED') {
    return { kind: 'order-ended', reason: orderStatus === 'CANCELLED' ? 'cancelled' : 'refunded', paymentArrivedLate: payment !== null && ARRIVED.has(payment.status) };
  }
  if (isConfirmed(orderStatus)) return { kind: 'phase', phase: 'completed' };
  if (!payment) return { kind: 'phase', phase: 'idle' };
  switch (payment.status) {
    case 'PENDING':
      return { kind: 'phase', phase: payment.requiresAction ? 'actionRequired' : 'processing' };
    case 'UNKNOWN':
      return { kind: 'phase', phase: 'unknown' };
    case 'COMPLETED':
      // The order is not PAID here: never "completed" (the success page says "confirmed" only for a PAID order).
      return { kind: 'phase', phase: 'confirming' };
    default:
      return { kind: 'phase', phase: 'failed' };
  }
}

/** The state a page starts in: a reload during a payment resumes it instead of showing the form. */
export function initialPayState(data: PayServerData): PayState {
  const view = serverView(data);
  return { phase: view.kind === 'phase' ? view.phase : 'idle' };
}

/** The event that moves `current` toward what the server reports, or `null` when nothing changes. */
export function eventForServer(current: PayPhase, data: PayServerData): PayEventType | null {
  const view = serverView(data);
  if (view.kind !== 'phase' || view.phase === current) return null;
  switch (view.phase) {
    case 'processing':
      if (current === 'submitting') return 'ACCEPTED';
      return current === 'actionRequired' ? 'ACTION_DONE' : null;
    case 'actionRequired':
      return 'ACTION_REQUIRED';
    case 'unknown':
      return 'PAYMENT_UNKNOWN';
    case 'confirming':
      return 'PAYMENT_COMPLETED';
    case 'completed':
      return 'ORDER_PAID';
    case 'failed':
      return 'PAYMENT_FAILED';
    default:
      return null;
  }
}
