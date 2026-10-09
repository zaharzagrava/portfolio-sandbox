import { AppError, ErrorArea } from '@app/common/errors/error.types';

/** A key given to the toolkit is not a valid cache key (FR-007). */
export class InvalidCacheKey extends AppError {
  constructor(reason: string) {
    super({
      code: 'invalid_cache_key',
      status: 500,
      title: 'Invalid cache key',
      detail: `Invalid cache key: ${reason}`,
      area: ErrorArea.FATAL,
    });
  }
}

/** An option, version, size or configuration value is out of range; `field` names it (FR-008). */
export class InvalidCacheOptions extends AppError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super({
      code: 'invalid_cache_options',
      status: 500,
      title: 'Invalid cache options',
      detail: `Invalid cache option "${field}": ${reason}`,
      area: ErrorArea.FATAL,
      data: { field },
    });
  }
}

/** A loader returned `undefined` or a value that cannot be written as JSON (FR-005). */
export class InvalidLoaderResult extends AppError {
  constructor(reason: string) {
    super({
      code: 'invalid_loader_result',
      status: 500,
      title: 'Invalid loader result',
      detail: `Invalid loader result: ${reason}`,
      area: ErrorArea.FATAL,
    });
  }
}

/** The shared store did not answer in time, refused, or the breaker is open. */
export class CacheUnavailable extends AppError {
  constructor(reason: string, cause?: unknown) {
    super({
      code: 'cache_unavailable',
      status: 500,
      title: 'Cache unavailable',
      detail: `Cache store unavailable: ${reason}`,
      area: ErrorArea.TRANSIENT,
      causes: cause instanceof Error ? [cause] : undefined,
    });
  }
}

/** No loader slot became free within the queue wait (FR-026). Maps to 503 + Retry-After. */
export class CacheLoaderBusy extends AppError {
  constructor(retryAfterSeconds = 1) {
    super({
      code: 'cache_loader_busy',
      status: 503,
      title: 'Service busy',
      detail: 'Too many loads are running; retry shortly.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds,
    });
  }
}

/** A counter already holds its maximum number of pending members (FR-031). */
export class CounterOverflow extends AppError {
  constructor(counter: string, cap: number) {
    super({
      code: 'counter_overflow',
      status: 500,
      title: 'Counter overflow',
      detail: `Counter "${counter}" already holds ${cap} pending members.`,
      area: ErrorArea.TRANSIENT,
    });
  }
}

/** `increment` was called with a bad member or amount (FR-028). */
export class InvalidIncrement extends AppError {
  constructor(reason: string) {
    super({
      code: 'invalid_increment',
      status: 500,
      title: 'Invalid increment',
      detail: `Invalid increment: ${reason}`,
      area: ErrorArea.FATAL,
    });
  }
}

/** `acquire` waited its whole budget without getting the lock. Maps to 503 + Retry-After. */
export class LockTimeout extends AppError {
  constructor(resource: string, waitMs: number) {
    super({
      code: 'lock_timeout',
      status: 503,
      title: 'Lock timeout',
      detail: `Could not acquire the lock on "${resource}" within ${waitMs} ms.`,
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds: 1,
    });
  }
}

/** The store cannot prove who holds the lock; a correctness lock fails closed (FR-027). */
export class LockUnavailable extends AppError {
  constructor(resource: string, cause?: unknown) {
    super({
      code: 'lock_unavailable',
      status: 500,
      title: 'Lock unavailable',
      detail: `The lock on "${resource}" cannot be acquired: the store is unavailable.`,
      area: ErrorArea.TRANSIENT,
      causes: cause instanceof Error ? [cause] : undefined,
    });
  }
}
