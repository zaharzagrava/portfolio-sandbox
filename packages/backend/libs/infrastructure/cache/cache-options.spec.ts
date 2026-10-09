import { InvalidCacheOptions } from './cache.errors';
import {
  GetOrLoadOptions,
  resolveGetOrLoadOptions,
  validateBatchKeys,
  validateInvalidateKeys,
  validateLockResource,
  validateLockTtl,
  validateLockWait,
  validateMinimumRetention,
  validateVersion,
} from './cache-options';
import { CacheToolkitConfig, resolveCacheConfig } from './cache.config';

const defaults = { timeoutMs: 250, maxEntryBytes: 256 * 1024 };
const resolve = (options: GetOrLoadOptions) =>
  resolveGetOrLoadOptions(options, defaults);
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const expectField = (fn: () => unknown, field: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidCacheOptions);
    expect((error as InvalidCacheOptions).field).toBe(field);
    return;
  }
  throw new Error(`expected InvalidCacheOptions for ${field}`);
};

describe('Cache option validation', () => {
  it.each<[string, GetOrLoadOptions]>([
    ['ttlMs', { ttlMs: 0 }],
    ['ttlMs', { ttlMs: -5 }],
    ['ttlMs', { ttlMs: NaN }],
    ['ttlMs', { ttlMs: 1.5 }],
    ['swrMs', { ttlMs: 1000, swrMs: -1 }],
    ['staleIfErrorMs', { ttlMs: 1000, staleIfErrorMs: -1 }],
    ['negativeTtlMs', { ttlMs: 1000, negativeTtlMs: 0 }],
    ['negativeTtlMs', { ttlMs: 1000, negativeTtlMs: 1001 }],
    ['jitter', { ttlMs: 1000, jitter: -0.01 }],
    ['jitter', { ttlMs: 1000, jitter: 0.51 }],
    ['jitter', { ttlMs: 1000, jitter: NaN }],
    ['l1TtlMs', { ttlMs: 1000, l1TtlMs: 5001 }],
    ['l1TtlMs', { ttlMs: 1000, l1TtlMs: 0 }],
    ['l1', { ttlMs: 1000, l1: 'sometimes' as 'hot' }],
    ['timeoutMs', { ttlMs: 1000, timeoutMs: 9 }],
    ['timeoutMs', { ttlMs: 1000, timeoutMs: 5001 }],
    ['maxEntryBytes', { ttlMs: 1000, maxEntryBytes: 1024 * 1024 + 1 }],
    ['maxEntryBytes', { ttlMs: 1000, maxEntryBytes: 0 }],
    ['versionOf', { ttlMs: 1000, versionOf: 'x' as unknown as () => number }],
  ])('S52 AS-10: an invalid %s is rejected with its name', (field, options) => {
    expectField(() => resolve(options), field);
  });

  it('S52 AS-10: a missing options object is rejected', () => {
    expectField(
      () => resolve(undefined as unknown as GetOrLoadOptions),
      'options',
    );
  });

  it.each<GetOrLoadOptions>([
    { ttlMs: 1 },
    { ttlMs: 60_000, jitter: 0 },
    { ttlMs: 60_000, jitter: 0.5 },
    { ttlMs: 60_000, negativeTtlMs: 60_000 },
    { ttlMs: 60_000, swrMs: 0, staleIfErrorMs: 0 },
    { ttlMs: 60_000, l1TtlMs: 5000 },
    { ttlMs: 60_000, timeoutMs: 10 },
    { ttlMs: 60_000, timeoutMs: 5000 },
    { ttlMs: 60_000, maxEntryBytes: 1024 * 1024 },
  ])('S52 AS-10: %j is accepted', (options) => {
    expect(() => resolve(options)).not.toThrow();
  });

  it('S52 AS-10: defaults are jitter 0.1, timeout 250 ms, entry cap 256 KiB, l1 hot, l1 lifetime 1 s', () => {
    expect(resolve({ ttlMs: 1000 })).toMatchObject({
      ttlMs: 1000,
      swrMs: 0,
      staleIfErrorMs: 0,
      negativeTtlMs: 0,
      jitter: 0.1,
      l1: 'hot',
      l1TtlMs: 1000,
      timeoutMs: 250,
      maxEntryBytes: 256 * 1024,
    });
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['above 2^53-1', MAX_SAFE + 1],
    ['a string', '4' as unknown as number],
    ['undefined', undefined as unknown as number],
  ])('S52 AS-41: a version that is %s is rejected', (_name, version) => {
    expectField(() => validateVersion(version), 'version');
  });

  it.each([0, 1, 4, MAX_SAFE])('S52 AS-41: version %s is accepted', (v) => {
    expect(() => validateVersion(v)).not.toThrow();
  });

  it.each([
    ['too short', 999],
    ['too long', 3_600_001],
    ['fractional', 1500.5],
    ['NaN', NaN],
  ])('S52 AS-39: a minimum retention that is %s is rejected', (_n, ms) => {
    expectField(() => validateMinimumRetention(ms), 'minimumRetentionMs');
  });

  it.each([1000, 300_000, 3_600_000])(
    'S52 AS-39: a minimum retention of %s ms is accepted',
    (ms) => {
      expect(() => validateMinimumRetention(ms)).not.toThrow();
    },
  );

  it('S52 AS-11: a batch of 500 keys is accepted and 501 is rejected', () => {
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `a:${i}`);
    expect(() => validateBatchKeys(keys(500))).not.toThrow();
    expectField(() => validateBatchKeys(keys(501)), 'keys');
  });

  it('S52 AS-32: an invalidate call of 5,000 keys is accepted and 5,001 is rejected', () => {
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `a:${i}`);
    expect(() => validateInvalidateKeys(keys(5000))).not.toThrow();
    expectField(() => validateInvalidateKeys(keys(5001)), 'keys');
  });
});

describe('Lock input rules', () => {
  it.each([
    ['below 100', 99],
    ['above 600,000', 600_001],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 100.5],
    ['NaN', NaN],
    ['a string', '1000' as unknown as number],
  ])(
    'S52 AS-63: a lock ttlMs %s is rejected naming the field',
    (_name, ttlMs) => {
      expectField(() => validateLockTtl(ttlMs), 'ttlMs');
    },
  );

  it.each([100, 5_000, 600_000])(
    'S52 AS-63: a lock ttlMs of %s is accepted',
    (ttlMs) => {
      expect(() => validateLockTtl(ttlMs)).not.toThrow();
    },
  );

  it.each([
    ['empty', ''],
    ['257 bytes', 'r'.repeat(257)],
    ['129 two-byte characters', 'é'.repeat(129)],
    ['with a space', 'seat hold'],
    ['with a tab', 'seat\thold'],
    ['with a newline', 'seat\nhold'],
    ['with a brace', 'seat{hold}'],
    ['not a string', 7 as unknown as string],
  ])(
    'S52 AS-63: a lock resource %s is rejected naming the field',
    (_name, resource) => {
      expectField(() => validateLockResource(resource), 'resource');
    },
  );

  it.each(['seat-hold:E1', 'a', 'r'.repeat(256), 'fulfilment:dispatch:v1:42'])(
    'S52 AS-63: the lock resource %s is accepted',
    (resource) => {
      expect(() => validateLockResource(resource)).not.toThrow();
    },
  );

  it.each([
    ['negative', -1],
    ['above 600,000', 600_001],
    ['fractional', 10.5],
    ['NaN', NaN],
  ])(
    'S52 AS-63: a lock waitMs %s is rejected naming the field',
    (_name, waitMs) => {
      expectField(() => validateLockWait(waitMs), 'waitMs');
    },
  );

  it.each([0, 100, 1_000, 600_000])(
    'S52 AS-63: a lock waitMs of %s is accepted',
    (waitMs) => {
      expect(() => validateLockWait(waitMs)).not.toThrow();
    },
  );
});

describe('Toolkit configuration', () => {
  it('S52 AS-10: the defaults are the spec values', () => {
    expect(resolveCacheConfig()).toEqual({
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
    });
  });

  it.each<[keyof CacheToolkitConfig, number]>([
    ['l1MaxEntries', 0],
    ['l1MaxBytes', -1],
    ['storeTimeoutMs', 9],
    ['storeTimeoutMs', 5_001],
    ['breakerMinimumCalls', 0],
    ['breakerWindowMs', 0],
    ['breakerOpenMs', 0],
    ['breakerHalfOpenCalls', 0],
    ['loaderConcurrency', 0],
    ['loaderQueueWaitMs', -1],
    ['maxEntryBytes', 1024 * 1024 + 1],
    ['minimumRetentionMs', 999],
    ['counterClaimAgeMs', 0],
    ['counterPendingMemberCap', 0],
    ['fenceRetentionMs', 0],
    ['recomputeLockMs', 99],
    ['followerWaitMs', -1],
    ['refreshShutdownWaitMs', -1],
    ['l1MaxEntries', 1.5],
    ['l1MaxEntries', NaN],
  ])(
    'S52 AS-10: an invalid %s of %s fails startup naming the field',
    (field, value) => {
      expectField(() => resolveCacheConfig({ [field]: value }), field);
    },
  );

  it('S52 AS-10: an unknown setting fails startup', () => {
    expectField(
      () =>
        resolveCacheConfig({
          typo: 1,
        } as unknown as Partial<CacheToolkitConfig>),
      'typo',
    );
  });
});
