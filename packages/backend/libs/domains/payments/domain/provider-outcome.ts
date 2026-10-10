import type { PaymentFailureCode } from '@marketplace-sandbox/contracts';

/**
 * The provider's answers as the payments domain sees them (anti-corruption layer, S13 A9/A24): the adapter turns SDK
 * objects and errors into `ProviderResponse`; the functions here classify and validate them. Pure.
 */
export interface IntentSnapshot {
  id: string;
  /** Provider status string; `undefined` when the answer had none (an invalid answer). */
  status: string | undefined;
  amountMinor: number | undefined;
  currency: string | undefined;
  /** `metadata.orderId` of the intent. */
  orderId: string | undefined;
  clientSecret?: string | null;
  lastErrorCode?: string | null;
  lastDeclineCode?: string | null;
}

export interface RefundSnapshot {
  id: string;
  status: string | undefined;
  amountMinor: number | undefined;
}

export type ProviderResponse =
  | { kind: 'intent'; intent: IntentSnapshot }
  | { kind: 'refund'; refund: RefundSnapshot }
  | { kind: 'refunds'; refunds: RefundSnapshot[] }
  /** A card error (declined, insufficient funds, expired ...): a definite "no". */
  | { kind: 'card_error'; code?: string; declineCode?: string }
  | {
      kind: 'http_error';
      httpStatus: number;
      requestId?: string;
      code?: string;
    }
  /** The request never left (open breaker, no connection) or the provider refused to look at it (rate limit). */
  | {
      kind: 'not_sent';
      reason: 'circuit_open' | 'rate_limited' | 'connect_failed';
    }
  | {
      kind: 'ambiguous';
      reason: 'timeout' | 'network' | 'server_error' | 'malformed';
    }
  /** Lookups only: the provider has no intent for our reference. */
  | { kind: 'not_found' };

export interface ExpectedIntent {
  amountMinor: number;
  currency: string;
  orderId: string;
}

export type MismatchField =
  'amount' | 'currency' | 'status' | 'orderId' | 'clientSecret';

export type ChargeOutcome =
  | { kind: 'succeeded'; providerRef: string }
  | { kind: 'declined'; code: PaymentFailureCode }
  | { kind: 'requires_action'; providerRef: string; clientSecret: string }
  | { kind: 'rejected'; httpStatus: number; requestId?: string }
  | {
      kind: 'not_sent';
      reason: 'circuit_open' | 'rate_limited' | 'connect_failed';
    }
  | {
      kind: 'ambiguous';
      reason:
        'timeout' | 'network' | 'server_error' | 'malformed' | 'processing';
    }
  | { kind: 'invalid'; field: MismatchField };

export type LookupOutcome =
  | { kind: 'succeeded'; providerRef: string }
  | { kind: 'requires_action'; providerRef: string; clientSecret: string }
  | { kind: 'failed'; code: PaymentFailureCode }
  | { kind: 'not_found' }
  | { kind: 'unreachable' }
  | { kind: 'pending' }
  | { kind: 'mismatch'; field: MismatchField };

/** The failure code for a card error or the last error of an intent. */
export function declineCodeFor(
  code: string | null | undefined,
  declineCode?: string | null,
): PaymentFailureCode {
  if (declineCode === 'insufficient_funds' || code === 'insufficient_funds')
    return 'insufficient_funds';
  if (code === 'expired_card' || declineCode === 'expired_card')
    return 'expired_card';
  if (code === 'card_declined') return 'card_declined';
  return 'declined_other';
}

/** The first field of the intent that does not match what we asked for, or null. */
export function findMismatch(
  intent: IntentSnapshot,
  expected: ExpectedIntent,
): MismatchField | null {
  if (!intent.status) return 'status';
  if (intent.amountMinor !== expected.amountMinor) return 'amount';
  if ((intent.currency ?? '').toUpperCase() !== expected.currency.toUpperCase())
    return 'currency';
  if (intent.orderId !== expected.orderId) return 'orderId';
  return null;
}

export function classifyCharge(
  response: ProviderResponse,
  expected: ExpectedIntent,
): ChargeOutcome {
  switch (response.kind) {
    case 'card_error':
      return {
        kind: 'declined',
        code: declineCodeFor(response.code, response.declineCode),
      };
    case 'not_sent':
      return { kind: 'not_sent', reason: response.reason };
    case 'ambiguous':
      return { kind: 'ambiguous', reason: response.reason };
    case 'not_found':
    case 'refund':
    case 'refunds':
      return { kind: 'ambiguous', reason: 'malformed' };
    case 'http_error':
      if (response.httpStatus === 429)
        return { kind: 'not_sent', reason: 'rate_limited' };
      if (response.httpStatus >= 500)
        return { kind: 'ambiguous', reason: 'server_error' };
      return {
        kind: 'rejected',
        httpStatus: response.httpStatus,
        ...(response.requestId ? { requestId: response.requestId } : {}),
      };
    case 'intent': {
      const intent = response.intent;
      const mismatch = findMismatch(intent, expected);
      if (mismatch) return { kind: 'invalid', field: mismatch };
      switch (intent.status) {
        case 'succeeded':
          return { kind: 'succeeded', providerRef: intent.id };
        case 'requires_action':
        case 'requires_confirmation':
          return intent.clientSecret
            ? {
                kind: 'requires_action',
                providerRef: intent.id,
                clientSecret: intent.clientSecret,
              }
            : { kind: 'invalid', field: 'clientSecret' };
        case 'requires_payment_method':
          return {
            kind: 'declined',
            code: declineCodeFor(intent.lastErrorCode, intent.lastDeclineCode),
          };
        case 'canceled':
          return { kind: 'declined', code: 'provider_canceled' };
        case 'processing':
          return { kind: 'ambiguous', reason: 'processing' };
        default:
          return { kind: 'invalid', field: 'status' };
      }
    }
  }
}

/** Classification of the answer to a lookup (by our reference or by intent id) for an `UNKNOWN` payment. */
export function classifyLookup(
  response: ProviderResponse,
  expected: ExpectedIntent,
): LookupOutcome {
  switch (response.kind) {
    case 'not_found':
      return { kind: 'not_found' };
    case 'not_sent':
    case 'ambiguous':
    case 'http_error':
    case 'card_error':
    case 'refund':
    case 'refunds':
      return { kind: 'unreachable' };
    case 'intent': {
      const intent = response.intent;
      const mismatch = findMismatch(intent, expected);
      if (mismatch) return { kind: 'mismatch', field: mismatch };
      switch (intent.status) {
        case 'succeeded':
          return { kind: 'succeeded', providerRef: intent.id };
        case 'requires_action':
        case 'requires_confirmation':
          return intent.clientSecret
            ? {
                kind: 'requires_action',
                providerRef: intent.id,
                clientSecret: intent.clientSecret,
              }
            : { kind: 'mismatch', field: 'clientSecret' };
        case 'requires_payment_method':
          return {
            kind: 'failed',
            code: declineCodeFor(intent.lastErrorCode, intent.lastDeclineCode),
          };
        case 'canceled':
          return { kind: 'failed', code: 'provider_canceled' };
        case 'processing':
          return { kind: 'pending' };
        default:
          return { kind: 'mismatch', field: 'status' };
      }
    }
  }
}
