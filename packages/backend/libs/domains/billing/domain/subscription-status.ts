import { assertNever } from '@app/common/core/assert-never';

/**
 * The subscription state machine (S17 FR-015, User Story 3). The status is a closed union; `transition` is the only
 * place that says which move is legal, and every `switch` ends in `assertNever`, so a status or trigger added without
 * handling fails the compiler.
 */
export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'UNPAID',
  'CANCELED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Statuses a customer can still act on (everything but the terminal one). */
export const LIVE_STATUSES: readonly SubscriptionStatus[] = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'UNPAID',
];

/** Statuses that keep the plan's entitlements (`UNPAID` and `CANCELED` fall back to the free tier). */
export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
];

export const TRANSITION_TRIGGERS = [
  'subscribe_with_trial',
  'subscribe',
  'trial_ended',
  'first_charge_failed',
  'dunning_paid',
  'dunning_exhausted',
  'unpaid_paid',
  'period_ended_with_cancellation',
  'cancelled_immediately',
  'unpaid_expired',
  'shop_deleted',
] as const;
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];

export type TransitionResult =
  | { ok: true; to: SubscriptionStatus }
  | { ok: false; error: 'illegal_transition' };

const illegal: TransitionResult = { ok: false, error: 'illegal_transition' };
const to = (status: SubscriptionStatus): TransitionResult => ({
  ok: true,
  to: status,
});

const isLive = (status: SubscriptionStatus): boolean => {
  switch (status) {
    case 'TRIALING':
    case 'ACTIVE':
    case 'PAST_DUE':
    case 'UNPAID':
      return true;
    case 'CANCELED':
      return false;
    default:
      return assertNever(status);
  }
};

/** `from` is `null` for a subscription that does not exist yet. Self-loops are never transitions. */
export function transition(
  from: SubscriptionStatus | null,
  trigger: TransitionTrigger,
): TransitionResult {
  switch (trigger) {
    case 'subscribe_with_trial':
      return from === null ? to('TRIALING') : illegal;
    case 'subscribe':
      return from === null ? to('ACTIVE') : illegal;
    case 'trial_ended':
      return from === 'TRIALING' ? to('ACTIVE') : illegal;
    case 'first_charge_failed':
      return from === 'ACTIVE' ? to('PAST_DUE') : illegal;
    case 'dunning_paid':
      return from === 'PAST_DUE' ? to('ACTIVE') : illegal;
    case 'dunning_exhausted':
      return from === 'PAST_DUE' ? to('UNPAID') : illegal;
    case 'unpaid_paid':
      return from === 'UNPAID' ? to('ACTIVE') : illegal;
    case 'unpaid_expired':
      return from === 'UNPAID' ? to('CANCELED') : illegal;
    case 'period_ended_with_cancellation':
    case 'cancelled_immediately':
    case 'shop_deleted':
      return from !== null && isLive(from) ? to('CANCELED') : illegal;
    default:
      return assertNever(trigger);
  }
}

/** A change of price or quantity is allowed only while the customer is in good standing (FR-046). */
export function isChangeable(status: SubscriptionStatus): boolean {
  switch (status) {
    case 'TRIALING':
    case 'ACTIVE':
      return true;
    case 'PAST_DUE':
    case 'UNPAID':
    case 'CANCELED':
      return false;
    default:
      return assertNever(status);
  }
}
