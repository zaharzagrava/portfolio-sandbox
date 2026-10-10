import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/** Details are generic on purpose: no policy name, no subject (FR-029). */
export class Domain_RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number, headers?: Record<string, string>) {
    super({
      status: HttpStatus.TOO_MANY_REQUESTS,
      code: 'rate_limited',
      title: 'Too Many Requests',
      detail: `Too many requests. Retry in ${retryAfterSeconds}s.`,
      area: ErrorArea.DOMAIN,
      retryAfterSeconds,
      extensions: { retryAfterSeconds },
      headers,
    });
  }
}

export class Domain_RateLimiterUnavailableError extends AppError {
  constructor(headers?: Record<string, string>) {
    super({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'rate_limiter_unavailable',
      title: 'Service Unavailable',
      detail: 'The request could not be checked right now. Retry shortly.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds: 1,
      headers,
    });
  }
}

export class Domain_RateLimitCostExceededError extends AppError {
  constructor(headers?: Record<string, string>) {
    super({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'rate_limit_cost_exceeded',
      title: 'Request too expensive',
      detail: 'This request costs more than the allowed budget.',
      area: ErrorArea.DOMAIN,
      headers,
    });
  }
}

export class InvalidRateLimitCostError extends Error {
  constructor(cost: unknown) {
    super(`Rate limit cost must be a positive integer, got ${String(cost)}`);
    this.name = 'InvalidRateLimitCostError';
  }
}

export class InvalidPenaltyError extends Error {
  constructor(ms: unknown) {
    super(`Penalty must be a positive finite number of ms, got ${String(ms)}`);
    this.name = 'InvalidPenaltyError';
  }
}

export class UnsupportedPenaltyError extends Error {
  constructor(policy: string, algorithm: string) {
    super(
      `Policy ${policy} (${algorithm}) cannot be penalized: token bucket only`,
    );
    this.name = 'UnsupportedPenaltyError';
  }
}
