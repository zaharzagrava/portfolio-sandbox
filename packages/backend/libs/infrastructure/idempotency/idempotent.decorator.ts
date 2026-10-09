import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IDEMPOTENT_METADATA, IdempotentOptions } from './idempotent.metadata';

const MAX_TTL_SECONDS = 7 * 24 * 3600;

/**
 * Declares a route idempotent (FR-063): the `Idempotency-Key` header is checked, the first request runs and its
 * answer is stored, a retry replays it. The route's module imports `IdempotencyModule`.
 */
export function Idempotent(options: IdempotentOptions = {}): MethodDecorator {
  const { ttlSeconds } = options;
  if (
    ttlSeconds !== undefined &&
    (!Number.isInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > MAX_TTL_SECONDS)
  ) {
    throw new Error(
      `Idempotent ttlSeconds must be an integer between 1 and ${MAX_TTL_SECONDS}`,
    );
  }
  return applyDecorators(
    SetMetadata(IDEMPOTENT_METADATA, options),
    UseInterceptors(IdempotencyInterceptor),
  );
}
