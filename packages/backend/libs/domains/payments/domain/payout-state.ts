/**
 * The payout state machine (S15 FR-024, AS-27): one pure table, the only place that says which status follows which
 * event. A refused pair returns `null` and changes nothing.
 */
export const PAYOUT_STATUSES = [
  'PENDING',
  'SENDING',
  'UNKNOWN',
  'PAID',
  'FAILED',
  'CANCELLED',
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const PAYOUT_EVENTS = [
  'claim',
  'provider_success',
  'provider_rejected',
  'provider_unknown',
  'retries_exhausted',
  'resolver_found_paid',
  'resolver_found_rejected',
  'cancel',
] as const;
export type PayoutEvent = (typeof PAYOUT_EVENTS)[number];

export type PublicPayoutStatus =
  'PENDING' | 'IN_TRANSIT' | 'PAID' | 'FAILED' | 'CANCELLED';

export function assertNever(value: never): never {
  throw new Error(`unhandled payout case: ${String(value)}`);
}

const fromPending = (event: PayoutEvent): PayoutStatus | null => {
  switch (event) {
    case 'claim':
      return 'SENDING';
    case 'cancel':
      return 'CANCELLED';
    case 'provider_success':
    case 'provider_rejected':
    case 'provider_unknown':
    case 'retries_exhausted':
    case 'resolver_found_paid':
    case 'resolver_found_rejected':
      return null;
    default:
      return assertNever(event);
  }
};

const fromSending = (event: PayoutEvent): PayoutStatus | null => {
  switch (event) {
    case 'provider_success':
    case 'resolver_found_paid':
      return 'PAID';
    case 'provider_rejected':
    case 'resolver_found_rejected':
      return 'FAILED';
    case 'provider_unknown':
    case 'retries_exhausted':
      return 'UNKNOWN';
    case 'claim':
    case 'cancel':
      return null;
    default:
      return assertNever(event);
  }
};

const fromUnknown = (event: PayoutEvent): PayoutStatus | null => {
  switch (event) {
    case 'resolver_found_paid':
    case 'provider_success':
      return 'PAID';
    case 'resolver_found_rejected':
    case 'provider_rejected':
      return 'FAILED';
    case 'claim':
    case 'cancel':
    case 'provider_unknown':
    case 'retries_exhausted':
      return null;
    default:
      return assertNever(event);
  }
};

/** The status after `event`, or `null` when the pair is refused (including any unknown status or event). */
export function transition(
  status: PayoutStatus,
  event: PayoutEvent,
): PayoutStatus | null {
  if (!(PAYOUT_EVENTS as readonly string[]).includes(event)) return null;
  switch (status) {
    case 'PENDING':
      return fromPending(event);
    case 'SENDING':
      return fromSending(event);
    case 'UNKNOWN':
      return fromUnknown(event);
    case 'PAID':
    case 'FAILED':
    case 'CANCELLED':
      return null;
    default:
      return (PAYOUT_STATUSES as readonly string[]).includes(status as string)
        ? assertNever(status)
        : null;
  }
}

export const isFinal = (status: PayoutStatus): boolean =>
  status === 'PAID' || status === 'FAILED' || status === 'CANCELLED';

/** `SENDING` and `UNKNOWN` are one status to a seller: the money is on its way. */
export function toPublicStatus(status: PayoutStatus): PublicPayoutStatus {
  switch (status) {
    case 'PENDING':
    case 'PAID':
    case 'FAILED':
    case 'CANCELLED':
      return status;
    case 'SENDING':
    case 'UNKNOWN':
      return 'IN_TRANSIT';
    default:
      return assertNever(status);
  }
}
