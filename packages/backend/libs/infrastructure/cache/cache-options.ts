import { InvalidCacheOptions } from './cache.errors';

export const MAX_ENTRY_BYTES_LIMIT = 1024 * 1024;
export const MAX_L1_TTL_MS = 5_000;
export const MAX_BATCH_KEYS = 500;
export const MAX_INVALIDATE_KEYS = 5_000;
export const MIN_RETENTION_MS = 1_000;
export const MAX_RETENTION_MS = 3_600_000;
export const DEFAULT_MINIMUM_RETENTION_MS = 300_000;

export interface GetOrLoadOptions<T = unknown> {
  /** Fresh lifetime. */
  ttlMs: number;
  /** Serve stale for this long after expiry while one caller refreshes in the background. */
  swrMs?: number;
  /** Serve a stale value for this long after expiry when the loader fails. */
  staleIfErrorMs?: number;
  /** Lifetime of "not found" results; unset means `null` is not stored. */
  negativeTtlMs?: number;
  /** Relative TTL spread, 0–0.5, default 0.1. */
  jitter?: number;
  /** In-process L1: always, only for detected hot keys (default), or never. */
  l1?: 'always' | 'hot' | 'never';
  l1TtlMs?: number;
  /** Per store call, default 250 ms. */
  timeoutMs?: number;
  maxEntryBytes?: number;
  /** Stamps entries with an integer version for `invalidateIfOlder`. */
  versionOf?: (value: T) => number;
}

export interface ResolvedOptions<T = unknown> {
  ttlMs: number;
  swrMs: number;
  staleIfErrorMs: number;
  negativeTtlMs: number;
  jitter: number;
  l1: 'always' | 'hot' | 'never';
  l1TtlMs: number;
  timeoutMs: number;
  maxEntryBytes: number;
  versionOf?: (value: T) => number;
}

const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

function integerIn(
  field: string,
  value: unknown,
  min: number,
  max: number,
): number {
  if (!isNumber(value) || !Number.isInteger(value))
    throw new InvalidCacheOptions(field, 'must be an integer');
  if (value < min || value > max)
    throw new InvalidCacheOptions(field, `must be between ${min} and ${max}`);
  return value;
}

/** Validates the options of one call and fills the defaults; throws `InvalidCacheOptions` naming the field (AS-10). */
export function resolveGetOrLoadOptions<T>(
  options: GetOrLoadOptions<T>,
  defaults: { timeoutMs: number; maxEntryBytes: number },
): ResolvedOptions<T> {
  if (!options || typeof options !== 'object')
    throw new InvalidCacheOptions('options', 'is required');

  const ttlMs = integerIn('ttlMs', options.ttlMs, 1, Number.MAX_SAFE_INTEGER);
  const swrMs =
    options.swrMs === undefined
      ? 0
      : integerIn('swrMs', options.swrMs, 0, Number.MAX_SAFE_INTEGER);
  const staleIfErrorMs =
    options.staleIfErrorMs === undefined
      ? 0
      : integerIn(
          'staleIfErrorMs',
          options.staleIfErrorMs,
          0,
          Number.MAX_SAFE_INTEGER,
        );
  const negativeTtlMs =
    options.negativeTtlMs === undefined
      ? 0
      : integerIn('negativeTtlMs', options.negativeTtlMs, 1, ttlMs);

  let jitter = 0.1;
  if (options.jitter !== undefined) {
    if (!isNumber(options.jitter) || options.jitter < 0 || options.jitter > 0.5)
      throw new InvalidCacheOptions('jitter', 'must be between 0 and 0.5');
    jitter = options.jitter;
  }

  const l1 = options.l1 ?? 'hot';
  if (l1 !== 'always' && l1 !== 'hot' && l1 !== 'never')
    throw new InvalidCacheOptions('l1', 'must be always, hot or never');

  const l1TtlMs =
    options.l1TtlMs === undefined
      ? 1_000
      : integerIn('l1TtlMs', options.l1TtlMs, 1, MAX_L1_TTL_MS);
  const timeoutMs =
    options.timeoutMs === undefined
      ? defaults.timeoutMs
      : integerIn('timeoutMs', options.timeoutMs, 10, 5_000);
  const maxEntryBytes =
    options.maxEntryBytes === undefined
      ? defaults.maxEntryBytes
      : integerIn(
          'maxEntryBytes',
          options.maxEntryBytes,
          1,
          MAX_ENTRY_BYTES_LIMIT,
        );
  if (
    options.versionOf !== undefined &&
    typeof options.versionOf !== 'function'
  )
    throw new InvalidCacheOptions('versionOf', 'must be a function');

  return {
    ttlMs,
    swrMs,
    staleIfErrorMs,
    negativeTtlMs,
    jitter,
    l1,
    l1TtlMs,
    timeoutMs,
    maxEntryBytes,
    versionOf: options.versionOf,
  };
}

/** A version is a non-negative safe integer (FR-023). */
export function validateVersion(version: unknown, field = 'version'): number {
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    throw new InvalidCacheOptions(field, 'must be a non-negative safe integer');
  return version;
}

export function validateMinimumRetention(ms: unknown): number {
  return integerIn(
    'minimumRetentionMs',
    ms,
    MIN_RETENTION_MS,
    MAX_RETENTION_MS,
  );
}

export function validateBatchKeys(keys: readonly unknown[]): void {
  if (!Array.isArray(keys))
    throw new InvalidCacheOptions('keys', 'must be an array');
  if (keys.length > MAX_BATCH_KEYS)
    throw new InvalidCacheOptions(
      'keys',
      `at most ${MAX_BATCH_KEYS} keys per batch`,
    );
}

export function validateInvalidateKeys(keys: readonly unknown[]): void {
  if (!Array.isArray(keys))
    throw new InvalidCacheOptions('keys', 'must be an array');
  if (keys.length > MAX_INVALIDATE_KEYS)
    throw new InvalidCacheOptions(
      'keys',
      `at most ${MAX_INVALIDATE_KEYS} keys per call`,
    );
}

export const MIN_LOCK_TTL_MS = 100;
export const MAX_LOCK_TTL_MS = 600_000;
export const MAX_LOCK_WAIT_MS = 600_000;
const MAX_RESOURCE_BYTES = 256;

/** A lock lifetime is 100–600,000 ms (FR-035). */
export function validateLockTtl(ttlMs: unknown): number {
  return integerIn('ttlMs', ttlMs, MIN_LOCK_TTL_MS, MAX_LOCK_TTL_MS);
}

/** How long `acquire` may wait, 0–600,000 ms. */
export function validateLockWait(waitMs: unknown): number {
  return integerIn('waitMs', waitMs, 0, MAX_LOCK_WAIT_MS);
}

/** Non-empty, at most 256 bytes, no whitespace, control characters or braces (a brace would move the fence's shard). */
export function validateLockResource(resource: unknown): string {
  if (typeof resource !== 'string' || resource.length === 0)
    throw new InvalidCacheOptions('resource', 'must be a non-empty string');
  if (Buffer.byteLength(resource, 'utf8') > MAX_RESOURCE_BYTES)
    throw new InvalidCacheOptions(
      'resource',
      `must be at most ${MAX_RESOURCE_BYTES} bytes`,
    );
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\s\u0000-\u001f\u007f-\u009f{}]/u.test(resource))
    throw new InvalidCacheOptions(
      'resource',
      'must not contain whitespace, control characters or braces',
    );
  return resource;
}
