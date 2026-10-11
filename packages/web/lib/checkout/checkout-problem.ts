import type { CheckoutFailure } from '@/lib/api/checkout';
import type { Problem } from '@/lib/api/errors';
import { parseCheckoutExtras, type CheckoutExtras } from './problem-view';

/**
 * What the order function hands to the browser when `POST /checkout` did not create an order (W03 FR-011, FR-081): the
 * parsed problem (`status`, `code`, `requestId`, `Retry-After`) plus the extension fields of the codes the UI acts on.
 * Plain data, so it crosses the Server Function boundary. `retryAfter` is the contract name of the wait in seconds;
 * `retryAfterSeconds` is the same number under the name `Problem` and `problemCopy` read.
 */
export type CheckoutProblem = Problem &
  CheckoutExtras & {
    retryAfter?: number;
    /** A 4xx `detail` that is a plain string (FR-082); never set for a 5xx. */
    detail?: string;
  };

export type PlaceOrderResult = { ok: true; orderId: string; replayed: boolean } | { ok: false; problem: CheckoutProblem };

export function toCheckoutProblem(failure: Pick<CheckoutFailure, 'status' | 'code' | 'requestId' | 'retryAfterSeconds' | 'detail' | 'body'>): CheckoutProblem {
  const extras = failure.status >= 400 && failure.status < 500 ? parseCheckoutExtras(failure.code, failure.body) : null;
  return {
    status: failure.status,
    ...(failure.code ? { code: failure.code } : {}),
    errors: [],
    ...(failure.requestId ? { requestId: failure.requestId } : {}),
    ...(failure.retryAfterSeconds !== undefined ? { retryAfter: failure.retryAfterSeconds, retryAfterSeconds: failure.retryAfterSeconds } : {}),
    ...(failure.detail ? { detail: failure.detail } : {}),
    ...(extras ?? {}),
  };
}
