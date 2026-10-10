import { ZodError } from 'zod';
import type { SectionCode } from '@marketplace-sandbox/contracts';
import { HttpClientError } from '@app/infrastructure/http-client';

/**
 * A failed upstream call, already in the closed vocabulary of the spec (FR-005). `unauthorized` is the one answer that
 * is not a degraded section: an upstream `401` on a credentialed call rejects the credential (FR-022).
 */
export class UpstreamFailure extends Error {
  constructor(
    readonly code: SectionCode,
    readonly retryable: boolean,
    readonly init: {
      status?: number;
      retryAfterMs?: number;
      /** The upstream's problem `code` (identity relays switch on it; sections ignore it). */
      problemCode?: string;
      unauthorized?: boolean;
      /** The caller cancelled the call: not a verdict on the upstream. */
      aborted?: boolean;
    } = {},
  ) {
    super(`Upstream call failed (${code})`);
    this.name = 'UpstreamFailure';
  }

  get status(): number | undefined {
    return this.init.status;
  }
  get retryAfterMs(): number | undefined {
    return this.init.retryAfterMs;
  }
  get problemCode(): string | undefined {
    return this.init.problemCode;
  }
  get unauthorized(): boolean {
    return this.init.unauthorized === true;
  }
  get aborted(): boolean {
    return this.init.aborted === true;
  }
  /** Says something about the upstream's health (feeds the breaker). */
  get countsAgainstUpstream(): boolean {
    return (
      !this.aborted &&
      !this.unauthorized &&
      this.code !== 'UPSTREAM_NOT_FOUND' &&
      this.code !== 'UPSTREAM_OVERLOADED' &&
      this.code !== 'BUDGET_EXCEEDED' &&
      this.code !== 'CIRCUIT_OPEN'
    );
  }
}

/**
 * The one mapping from any failure to the closed code set (plan: "Outcome vocabulary"). The same function feeds the
 * page `errors` and the GraphQL `extensions.code`.
 */
export function classify(error: unknown): UpstreamFailure {
  if (error instanceof UpstreamFailure) return error;
  if (error instanceof ZodError)
    return new UpstreamFailure('UPSTREAM_INVALID', false);
  if (error instanceof HttpClientError) {
    const status = error.status;
    switch (error.kind) {
      case 'timeout':
        return new UpstreamFailure('UPSTREAM_TIMEOUT', true);
      case 'aborted':
        return new UpstreamFailure('UPSTREAM_UNAVAILABLE', true, {
          aborted: true,
        });
      case 'network_error':
        return new UpstreamFailure('UPSTREAM_UNAVAILABLE', true);
      case 'invalid_response':
      case 'response_too_large':
        return new UpstreamFailure('UPSTREAM_INVALID', false);
      case 'bulkhead_full':
        return new UpstreamFailure('UPSTREAM_OVERLOADED', true);
      case 'circuit_open':
        return new UpstreamFailure('CIRCUIT_OPEN', true);
      case 'status':
        break;
      default:
        return new UpstreamFailure('UPSTREAM_UNAVAILABLE', true);
    }
    const init = {
      status,
      retryAfterMs: error.retryAfterMs,
      problemCode: error.problemCode,
    };
    if (status === 401 || status === 403)
      return new UpstreamFailure('UPSTREAM_UNAVAILABLE', false, {
        ...init,
        unauthorized: status === 401,
      });
    if (status === 404)
      return new UpstreamFailure('UPSTREAM_NOT_FOUND', false, init);
    if (status === 429)
      return new UpstreamFailure('UPSTREAM_RATE_LIMITED', true, init);
    if (status !== undefined && status >= 500)
      return new UpstreamFailure('UPSTREAM_UNAVAILABLE', true, init);
    if (status !== undefined && status >= 300 && status < 400)
      return new UpstreamFailure('UPSTREAM_UNAVAILABLE', true, init); // redirects are not followed
    return new UpstreamFailure('UPSTREAM_INVALID', false, init);
  }
  return new UpstreamFailure('UPSTREAM_UNAVAILABLE', true);
}
