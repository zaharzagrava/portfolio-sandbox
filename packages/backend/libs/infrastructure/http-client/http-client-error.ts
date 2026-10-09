import { AppError, ErrorArea } from '@app/common/errors/error.types';

/** Failure vocabulary of the resilient client (contracts/toolkit-api.md). */
export type HttpClientErrorKind =
  | 'timeout'
  | 'aborted'
  | 'status'
  | 'network_error'
  | 'response_too_large'
  | 'invalid_response'
  | 'bulkhead_full'
  | 'circuit_open'
  | 'retry_after_exceeds_budget'
  | 'budget_exhausted';

/** What this service answers with when the failure reaches the edge. */
const ANSWER_BY_KIND: Record<
  HttpClientErrorKind,
  { status: number; code: string }
> = {
  timeout: { status: 504, code: 'dependency_timeout' },
  aborted: { status: 502, code: 'dependency_error' },
  status: { status: 502, code: 'dependency_error' },
  network_error: { status: 502, code: 'dependency_error' },
  response_too_large: { status: 502, code: 'dependency_error' },
  invalid_response: { status: 502, code: 'dependency_error' },
  bulkhead_full: { status: 503, code: 'dependency_unavailable' },
  circuit_open: { status: 503, code: 'dependency_unavailable' },
  retry_after_exceeds_budget: { status: 503, code: 'dependency_unavailable' },
  budget_exhausted: { status: 503, code: 'dependency_unavailable' },
};

export interface HttpClientErrorInit {
  /** Status the dependency answered with (kinds `status` and `retry_after_exceeds_budget`). */
  status?: number;
  attempts: number;
  retryable?: boolean;
  /** `Retry-After` the dependency asked for, or the time the caller should wait, in ms. */
  retryAfterMs?: number;
}

/**
 * Every failure of an outbound call. The message never carries a URL, header, query string or response body.
 * `status` is the dependency's own status; `toAppError()` is what the edge answers with (the exception filter
 * calls it), so an endpoint that lets the error bubble renders a 502/503/504 problem without internals.
 */
export class HttpClientError extends Error {
  readonly status?: number;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    readonly kind: HttpClientErrorKind,
    init: HttpClientErrorInit,
  ) {
    super(
      `Dependency call failed (${kind}${init.status ? ` ${init.status}` : ''})`,
    );
    this.name = 'HttpClientError';
    this.status = init.status;
    this.attempts = init.attempts;
    this.retryable = init.retryable ?? false;
    this.retryAfterMs = init.retryAfterMs;
  }

  withAttempts(attempts: number): HttpClientError {
    return new HttpClientError(this.kind, {
      status: this.status,
      attempts,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
    });
  }

  toAppError(): AppError {
    const { status, code } = ANSWER_BY_KIND[this.kind];
    return new AppError({
      code,
      status,
      title: 'Dependency call failed',
      detail: this.message,
      area: ErrorArea.TRANSIENT,
      causes: [this],
      ...(status === 503
        ? {
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((this.retryAfterMs ?? 1_000) / 1000),
            ),
          }
        : {}),
    });
  }
}
