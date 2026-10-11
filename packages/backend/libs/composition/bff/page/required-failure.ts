import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import { BffProblem } from '../problem';
import type { UpstreamFailure } from '../upstream/upstream-error';

/** Only a stable machine code of the owning domain is passed on, never free text. */
const PROBLEM_CODE = /^[a-z][a-z0-9_]{0,63}$/;

const passThrough = (
  failure: UpstreamFailure,
  status: HttpStatus,
  title: string,
  fallbackCode: string,
  retryAfterSeconds?: number,
): AppError =>
  new AppError({
    code:
      failure.problemCode && PROBLEM_CODE.test(failure.problemCode)
        ? failure.problemCode
        : fallbackCode,
    status,
    title,
    detail:
      status === HttpStatus.NOT_FOUND
        ? 'The resource was not found.'
        : 'The request was refused.',
    area: ErrorArea.DOMAIN,
    retryAfterSeconds,
    headers: { 'Cache-Control': 'no-store' },
  });

/**
 * The answer when a required upstream call failed (W03 B-3, B-4): a `401` rejects the credential; `404`, `400` and
 * `429` keep their status, stable problem code and `Retry-After`; everything else is the BFF's own `502`/`503`.
 */
export function requiredFailureProblem(failure: UpstreamFailure): AppError {
  if (failure.unauthorized) return new BffProblem('invalid_token');
  switch (failure.code) {
    case 'UPSTREAM_NOT_FOUND':
      return passThrough(
        failure,
        HttpStatus.NOT_FOUND,
        'Not Found',
        'not_found',
      );
    case 'UPSTREAM_RATE_LIMITED':
      return passThrough(
        failure,
        HttpStatus.TOO_MANY_REQUESTS,
        'Too Many Requests',
        'rate_limited',
        Math.max(1, Math.ceil((failure.retryAfterMs ?? 1_000) / 1_000)),
      );
    case 'UPSTREAM_INVALID':
      return failure.status === 400
        ? passThrough(
            failure,
            HttpStatus.BAD_REQUEST,
            'Bad Request',
            'validation_failed',
          )
        : new BffProblem('upstream_invalid');
    case 'UPSTREAM_OVERLOADED':
      return new BffProblem('overloaded', { retryAfterSeconds: 1 });
    default:
      return new BffProblem('upstream_unavailable', {
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((failure.retryAfterMs ?? 1_000) / 1_000),
        ),
      });
  }
}
