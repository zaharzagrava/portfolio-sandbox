import type { ProviderResponse } from './provider-outcome';

/** Classification of the provider's answers about a refund (S13 US6, A17): pure. */
export type RefundOutcome =
  /** The refund exists at the provider (created now or before) and has not failed. */
  | { kind: 'done' }
  /** The provider says the charge was refunded already. */
  | { kind: 'already_refunded' }
  /** A hard refusal: retrying will not help. */
  | { kind: 'refused'; httpStatus: number; requestId?: string }
  /** Nothing definite came back (breaker open, timeout, `5xx`, `429`): look again before sending again. */
  | { kind: 'retry' };

const holdsMoney = (status: string | undefined): boolean =>
  status === 'succeeded' ||
  status === 'pending' ||
  status === 'requires_action';

export function classifyRefund(response: ProviderResponse): RefundOutcome {
  switch (response.kind) {
    case 'refund':
      if (holdsMoney(response.refund.status)) return { kind: 'done' };
      return response.refund.status === 'failed' ||
        response.refund.status === 'canceled'
        ? { kind: 'refused', httpStatus: 200 }
        : { kind: 'retry' };
    case 'http_error':
      if (response.code === 'charge_already_refunded')
        return { kind: 'already_refunded' };
      if (response.httpStatus === 429 || response.httpStatus >= 500)
        return { kind: 'retry' };
      return {
        kind: 'refused',
        httpStatus: response.httpStatus,
        ...(response.requestId ? { requestId: response.requestId } : {}),
      };
    default:
      return { kind: 'retry' };
  }
}

/** Does the provider already hold a non-failed refund of the full amount for this charge? `retry` when it cannot say. */
export function classifyRefundLookup(
  response: ProviderResponse,
  amountMinor: number,
): { kind: 'exists' } | { kind: 'none' } | { kind: 'retry' } {
  if (response.kind !== 'refunds') return { kind: 'retry' };
  return response.refunds.some(
    (r) => holdsMoney(r.status) && r.amountMinor === amountMinor,
  )
    ? { kind: 'exists' }
    : { kind: 'none' };
}
