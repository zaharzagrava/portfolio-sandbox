import { AppError, ErrorArea } from '@app/common/errors/error.types';
import { PlatformCodes } from '@app/common/errors/platform-codes';
import type { ProblemCatalogEntry } from '@app/common/errors/problem-catalog.module';

const OWNER = 'infrastructure:idempotency';

export const IDEMPOTENCY_PROBLEMS: ProblemCatalogEntry[] = [
  {
    code: PlatformCodes.idempotency_key_required,
    status: 422,
    title: 'Idempotency key required',
    detail: 'This request needs an Idempotency-Key header.',
    owner: OWNER,
  },
  {
    code: PlatformCodes.idempotency_key_invalid,
    status: 422,
    title: 'Idempotency key invalid',
    detail:
      'Idempotency-Key must be one header of 8 to 128 characters: letters, digits, "_" or "-".',
    owner: OWNER,
  },
  {
    code: PlatformCodes.idempotency_key_reuse,
    status: 422,
    title: 'Idempotency key reused',
    detail: 'This Idempotency-Key was already used with a different request.',
    owner: OWNER,
  },
  {
    code: PlatformCodes.idempotency_in_flight,
    status: 409,
    title: 'Request in progress',
    detail:
      'A request with this Idempotency-Key is still being processed. Retry shortly.',
    owner: OWNER,
  },
  {
    code: PlatformCodes.idempotency_replay_unavailable,
    status: 409,
    title: 'Replay unavailable',
    detail:
      'The original response is too large to replay. The operation was already performed.',
    owner: OWNER,
  },
  {
    code: PlatformCodes.idempotency_unavailable,
    status: 503,
    title: 'Idempotency unavailable',
    detail: 'Idempotency protection is temporarily unavailable. Retry shortly.',
    owner: OWNER,
  },
];

type IdempotencyCode = (typeof IDEMPOTENCY_PROBLEMS)[number]['code'];

export function idempotencyError(
  code: IdempotencyCode,
  extra: { retryAfterSeconds?: number } = {},
): AppError {
  const entry = IDEMPOTENCY_PROBLEMS.find((p) => p.code === code)!;
  return new AppError({
    code: entry.code,
    status: entry.status,
    title: entry.title,
    detail: entry.detail,
    area: ErrorArea.DOMAIN,
    ...extra,
  });
}
