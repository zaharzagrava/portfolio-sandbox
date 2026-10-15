import { assertNever } from '@app/common/core/assert-never';

/**
 * What a charge attempt turned out to be (S17 FR-032). Only `succeeded` pays; `declined` and
 * `authentication_required` are definite failures that count as an attempt; `unknown` (timeout, connection error,
 * `5xx`, an answer nobody can classify) is settled later by looking the charge up and is NEVER sent again.
 */
export type ChargeOutcome =
  | { kind: 'succeeded'; providerRef: string }
  | { kind: 'declined'; reason: string }
  | { kind: 'authentication_required'; reason: 'authentication_required' }
  | { kind: 'unknown'; reason: string };

/** A charge found at the provider by our reference, or the lack of one. */
export type LookupOutcome =
  | { kind: 'found'; outcome: Exclude<ChargeOutcome, { kind: 'unknown' }> }
  | { kind: 'not_found' };

/** The fields of a provider intent the classifier reads; anything else is ignored. */
export interface IntentSnapshot {
  id?: unknown;
  status?: unknown;
  last_payment_error?: { code?: string; decline_code?: string } | null;
}

const safeReason = (value: unknown, fallback: string): string =>
  typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value)
    ? value.toLowerCase()
    : fallback;

/**
 * Provider intent → outcome. Never `succeeded` unless the status is exactly `succeeded` and an id is present; a
 * status nobody knows is `unknown`, not a decline (AS-58).
 */
export function classifyIntent(
  intent: IntentSnapshot | null | undefined,
): ChargeOutcome {
  if (
    !intent ||
    typeof intent !== 'object' ||
    typeof intent.status !== 'string'
  )
    return { kind: 'unknown', reason: 'unclassifiable_answer' };
  switch (intent.status) {
    case 'succeeded':
      return typeof intent.id === 'string' && intent.id.length > 0
        ? { kind: 'succeeded', providerRef: intent.id }
        : { kind: 'unknown', reason: 'unclassifiable_answer' };
    case 'requires_payment_method':
      return {
        kind: 'declined',
        reason: safeReason(
          intent.last_payment_error?.decline_code ??
            intent.last_payment_error?.code,
          'card_declined',
        ),
      };
    case 'requires_action':
    case 'requires_confirmation':
      return {
        kind: 'authentication_required',
        reason: 'authentication_required',
      };
    case 'canceled':
      return { kind: 'declined', reason: 'canceled' };
    default:
      return { kind: 'unknown', reason: 'unclassifiable_answer' };
  }
}

interface SdkError {
  type?: string;
  code?: string;
  decline_code?: string;
  statusCode?: number;
}

/** Provider error → outcome: a card refusal is a decline; a 4xx is a definite failure; the rest is `unknown`. */
export function classifyError(error: unknown): ChargeOutcome {
  const e = (error ?? {}) as SdkError;
  if (e.type === 'StripeCardError') {
    if (e.code === 'authentication_required')
      return {
        kind: 'authentication_required',
        reason: 'authentication_required',
      };
    return {
      kind: 'declined',
      reason: safeReason(e.decline_code ?? e.code, 'card_declined'),
    };
  }
  const status = e.statusCode;
  if (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 429 &&
    status !== 408
  )
    return { kind: 'declined', reason: safeReason(e.code, 'invalid_request') };
  return { kind: 'unknown', reason: 'provider_unreachable' };
}

/** The reason text carried by a definite failure. */
export function failureReason(
  outcome: Exclude<ChargeOutcome, { kind: 'succeeded' } | { kind: 'unknown' }>,
): string {
  switch (outcome.kind) {
    case 'declined':
    case 'authentication_required':
      return outcome.reason;
    default:
      return assertNever(outcome);
  }
}
