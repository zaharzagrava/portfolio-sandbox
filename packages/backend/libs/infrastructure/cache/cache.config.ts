import { InvalidCacheOptions } from './cache.errors';
import { MAX_ENTRY_BYTES_LIMIT } from './cache-options';

/** Injection token for the validated toolkit configuration. */
export const CACHE_TOOLKIT_CONFIG = Symbol('CACHE_TOOLKIT_CONFIG');

/** Every number the toolkit is allowed to tune; the defaults are the spec's (Assumptions). */
export interface CacheToolkitConfig {
  l1MaxEntries: number;
  l1MaxBytes: number;
  storeTimeoutMs: number;
  breakerMinimumCalls: number;
  breakerWindowMs: number;
  breakerOpenMs: number;
  breakerHalfOpenCalls: number;
  loaderConcurrency: number;
  loaderQueueWaitMs: number;
  maxEntryBytes: number;
  minimumRetentionMs: number;
  counterClaimAgeMs: number;
  counterPendingMemberCap: number;
  fenceRetentionMs: number;
  recomputeLockMs: number;
  followerWaitMs: number;
  refreshShutdownWaitMs: number;
}

export const DEFAULT_CACHE_CONFIG: Readonly<CacheToolkitConfig> = {
  l1MaxEntries: 10_000,
  l1MaxBytes: 64 * 1024 * 1024,
  storeTimeoutMs: 250,
  breakerMinimumCalls: 5,
  breakerWindowMs: 10_000,
  breakerOpenMs: 5_000,
  breakerHalfOpenCalls: 1,
  loaderConcurrency: 100,
  loaderQueueWaitMs: 2_000,
  maxEntryBytes: 256 * 1024,
  minimumRetentionMs: 300_000,
  counterClaimAgeMs: 300_000,
  counterPendingMemberCap: 100_000,
  fenceRetentionMs: 30 * 24 * 3_600_000,
  recomputeLockMs: 5_000,
  followerWaitMs: 500,
  refreshShutdownWaitMs: 5_000,
};

/** Inclusive [min, max] per setting. */
const RANGES: Record<keyof CacheToolkitConfig, [number, number]> = {
  l1MaxEntries: [1, 1_000_000],
  l1MaxBytes: [1, 4 * 1024 * 1024 * 1024],
  storeTimeoutMs: [10, 5_000],
  breakerMinimumCalls: [1, 1_000],
  breakerWindowMs: [1, 3_600_000],
  breakerOpenMs: [1, 3_600_000],
  breakerHalfOpenCalls: [1, 100],
  loaderConcurrency: [1, 10_000],
  loaderQueueWaitMs: [0, 60_000],
  maxEntryBytes: [1, MAX_ENTRY_BYTES_LIMIT],
  minimumRetentionMs: [1_000, 3_600_000],
  counterClaimAgeMs: [1, 24 * 3_600_000],
  counterPendingMemberCap: [1, 10_000_000],
  fenceRetentionMs: [1, 365 * 24 * 3_600_000],
  recomputeLockMs: [100, 600_000],
  followerWaitMs: [0, 60_000],
  refreshShutdownWaitMs: [0, 60_000],
};

/** Merges overrides over the defaults and rejects anything out of range, so a bad setting fails boot (VIII.5). */
export function resolveCacheConfig(
  overrides: Partial<CacheToolkitConfig> = {},
): CacheToolkitConfig {
  const config: CacheToolkitConfig = { ...DEFAULT_CACHE_CONFIG };
  for (const [field, value] of Object.entries(overrides)) {
    const range = RANGES[field as keyof CacheToolkitConfig];
    if (!range)
      throw new InvalidCacheOptions(field, 'is not a toolkit setting');
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value))
      throw new InvalidCacheOptions(field, 'must be an integer');
    if (value < range[0] || value > range[1])
      throw new InvalidCacheOptions(
        field,
        `must be between ${range[0]} and ${range[1]}`,
      );
    config[field as keyof CacheToolkitConfig] = value;
  }
  return config;
}
