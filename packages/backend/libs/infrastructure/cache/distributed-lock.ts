import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Clock, CLOCK, SystemClock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  CACHE_TOOLKIT_CONFIG,
  CacheToolkitConfig,
  resolveCacheConfig,
} from './cache.config';
import { CacheUnavailable, LockTimeout, LockUnavailable } from './cache.errors';
import { cacheMetrics } from './cache-metrics';
import {
  validateLockResource,
  validateLockTtl,
  validateLockWait,
} from './cache-options';
import {
  LOCK_ACQUIRE,
  LOCK_EXTEND,
  RELEASE_LOCK,
  runScript,
} from './cache-scripts';
import { RANDOM_SOURCE, SystemRandom } from './random-source';
import type { RandomSource } from './random-source';
import { sharedStoreGuard } from './shared-guard';
import type { StoreGuard } from './store-guard';

/** Pause between attempts of `acquire`: 10–40 ms, jittered, so waiters neither spin nor move in lockstep. */
const POLL_MIN_MS = 10;
const POLL_SPREAD_MS = 30;

export interface Lock {
  resource: string;
  /** Owner token: only its holder can release or extend. */
  token: string;
  /** Strictly greater than every earlier fence of the resource; a protected write compares it. */
  fence: number;
  /** True if this holder still held the lock and released it. */
  release(): Promise<boolean>;
  /** True if this holder still held the lock and its lifetime was restarted. */
  extend(ttlMs: number): Promise<boolean>;
}

/**
 * A lock for correctness, not just efficiency (P0326): owner token, atomic release and extend, and a fencing
 * token the protected write checks (`isNewerFence`) so a holder that paused past its lifetime cannot overwrite the
 * next holder's work. It fails closed: when the store cannot say who holds the lock, it rejects with
 * `LockUnavailable` and never reports success.
 */
@Injectable()
export class DistributedLock {
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly config: CacheToolkitConfig;
  private readonly guard: StoreGuard;

  constructor(
    private readonly redis: RedisService,
    @Optional() @Inject(CLOCK) clock?: Clock,
    @Optional() @Inject(RANDOM_SOURCE) random?: RandomSource,
    @Optional()
    @Inject(CACHE_TOOLKIT_CONFIG)
    config?: Partial<CacheToolkitConfig>,
    // Never provided by DI: only specs pass one; everything else shares the process-wide guard.
    @Optional() guard?: StoreGuard,
  ) {
    this.clock = clock ?? new SystemClock();
    this.random = random ?? new SystemRandom();
    this.config = resolveCacheConfig(config);
    this.guard = guard ?? sharedStoreGuard();
  }

  /** One attempt: the lock, or `null` when someone else holds it. */
  async tryAcquire(
    resource: string,
    options: { ttlMs: number },
  ): Promise<Lock | null> {
    validateLockResource(resource);
    const ttlMs = validateLockTtl(options?.ttlMs);
    const token = randomUUID();
    let fence: number;
    try {
      fence = (await this.guard.run(() =>
        runScript(
          this.redis.client,
          LOCK_ACQUIRE,
          [lockKey(resource), fenceKey(resource)],
          [token, ttlMs, this.config.fenceRetentionMs],
        ),
      )) as number;
    } catch (error) {
      cacheMetrics().lockAcquisitions.add(1, { outcome: 'unavailable' });
      throw new LockUnavailable(resource, error);
    }
    if (fence === 0) {
      cacheMetrics().lockAcquisitions.add(1, { outcome: 'contended' });
      return null;
    }
    cacheMetrics().lockAcquisitions.add(1, { outcome: 'acquired' });
    return this.handle(resource, token, fence);
  }

  /** Waits up to `waitMs`, polling with jitter, then rejects with `LockTimeout`. */
  async acquire(
    resource: string,
    options: { ttlMs: number; waitMs: number },
  ): Promise<Lock> {
    validateLockResource(resource);
    validateLockTtl(options?.ttlMs);
    const waitMs = validateLockWait(options?.waitMs);
    const deadline = this.clock.nowMs() + waitMs;
    for (;;) {
      const lock = await this.tryAcquire(resource, { ttlMs: options.ttlMs });
      if (lock) return lock;
      const remaining = deadline - this.clock.nowMs();
      if (remaining <= 0) break;
      const pause =
        POLL_MIN_MS + Math.floor(this.random.next() * POLL_SPREAD_MS);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pause, remaining)),
      );
    }
    cacheMetrics().lockAcquisitions.add(1, { outcome: 'timeout' });
    throw new LockTimeout(resource, waitMs);
  }

  /**
   * Runs `fn` holding the lock and always releases it, also when `fn` throws. Without `waitMs` a held resource
   * rejects with `LockTimeout` at once; with it, waits like `acquire`.
   */
  async withLock<R>(
    resource: string,
    options: { ttlMs: number; waitMs?: number },
    fn: (lock: Lock) => Promise<R>,
  ): Promise<R> {
    const lock =
      options.waitMs === undefined
        ? await this.tryAcquire(resource, { ttlMs: options.ttlMs })
        : await this.acquire(resource, {
            ttlMs: options.ttlMs,
            waitMs: options.waitMs,
          });
    if (!lock) throw new LockTimeout(resource, 0);
    try {
      return await fn(lock);
    } finally {
      await lock.release().catch(() => false);
    }
  }

  /** Pure: a protected write accepts `presented` only if it is greater than the fence it already holds. */
  isNewerFence(current: number, presented: number): boolean {
    return presented > current;
  }

  private handle(resource: string, token: string, fence: number): Lock {
    const run = async (
      script: typeof RELEASE_LOCK,
      args: (string | number)[],
    ) => {
      try {
        return (await this.guard.run(() =>
          runScript(this.redis.client, script, [lockKey(resource)], args),
        )) as number;
      } catch (error) {
        throw error instanceof CacheUnavailable
          ? new LockUnavailable(resource, error)
          : error;
      }
    };
    return {
      resource,
      token,
      fence,
      release: async () => (await run(RELEASE_LOCK, [token])) === 1,
      extend: async (ttlMs: number) => {
        validateLockTtl(ttlMs);
        return (await run(LOCK_EXTEND, [token, ttlMs])) === 1;
      },
    };
  }
}

/** Hash-tagged on the resource, so the lock and its fence counter share a shard. */
const lockKey = (resource: string): string => `lock:{${resource}}`;
const fenceKey = (resource: string): string => `lock:{${resource}}:fence`;
