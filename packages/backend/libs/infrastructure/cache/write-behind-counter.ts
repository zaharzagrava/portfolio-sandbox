import { randomUUID } from 'node:crypto';
import { Clock, SystemClock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { DEFAULT_CACHE_CONFIG } from './cache.config';
import {
  CounterOverflow,
  InvalidCacheOptions,
  InvalidIncrement,
} from './cache.errors';
import { cacheMetrics } from './cache-metrics';
import {
  COUNTER_CLAIM,
  COUNTER_COMMIT,
  COUNTER_DRAIN,
  COUNTER_INCREMENT,
  COUNTER_RECLAIM,
  COUNTER_RELEASE,
  runScript,
} from './cache-scripts';
import { sharedStoreGuard } from './shared-guard';
import type { StoreGuard } from './store-guard';

const NAME = /^[a-z][a-z0-9-]*$/;
const MAX_NAME_LENGTH = 64;
const MAX_MEMBER_BYTES = 256;

export interface WriteBehindCounterOptions {
  /** Most pending members before a new one is refused; default 100,000. */
  pendingCap?: number;
  /** A claimed batch older than this is merged back by `reclaimExpired`; default 5 min. */
  claimAgeMs?: number;
  clock?: Clock;
  guard?: StoreGuard;
}

/**
 * Write-behind counters (README #22): hot, low-value increments (product
 * views, likes) go to a Redis hash - O(1), no DB write per event - and a
 * periodic job drains the hash into the database in one batch.
 * 10k views/s on one product = 1 row update per flush instead of 10k row
 * locks per second. Trade-off: up to one flush interval of counts can be lost
 * if Redis loses data (acceptable for analytics-grade counters, never money).
 *
 * `drain`/`restore` keep their semantics. `claim`/`commit`/`release`/`reclaimExpired` make a flush crash-safe: a
 * claimed batch is held under a batch id until it is committed, and comes back after the claim age if the flusher
 * died. The flusher should apply a claimed batch idempotently by `batchId`.
 */
export class WriteBehindCounter {
  private readonly pendingKey: string;
  private readonly claimsKey: string;
  private readonly claimPrefix: string;
  private readonly clock: Clock;
  private readonly guard: StoreGuard;
  private readonly pendingCap: number;
  private readonly claimAgeMs: number;

  constructor(
    private readonly redis: RedisService,
    private readonly name: string,
    options: WriteBehindCounterOptions = {},
  ) {
    if (
      typeof name !== 'string' ||
      name.length > MAX_NAME_LENGTH ||
      !NAME.test(name)
    )
      throw new InvalidCacheOptions(
        'name',
        `must match ${NAME.source} and be at most ${MAX_NAME_LENGTH} characters`,
      );
    // One hash tag per counter: its pending hash, claimed batches and claim index live on one shard.
    this.pendingKey = `counter:{${name}}:pending`;
    this.claimsKey = `counter:{${name}}:claims`;
    this.claimPrefix = `counter:{${name}}:claim:`;
    this.clock = options.clock ?? new SystemClock();
    this.guard = options.guard ?? sharedStoreGuard();
    this.pendingCap =
      options.pendingCap ?? DEFAULT_CACHE_CONFIG.counterPendingMemberCap;
    this.claimAgeMs =
      options.claimAgeMs ?? DEFAULT_CACHE_CONFIG.counterClaimAgeMs;
  }

  /** O(1). A negative amount is accepted (vote deltas); zero, fractions and non-numbers are not. */
  async increment(member: string, by = 1): Promise<void> {
    if (typeof member !== 'string' || member.length === 0)
      throw new InvalidIncrement('member must be a non-empty string');
    if (Buffer.byteLength(member, 'utf8') > MAX_MEMBER_BYTES)
      throw new InvalidIncrement(
        `member is longer than ${MAX_MEMBER_BYTES} bytes`,
      );
    if (typeof by !== 'number' || !Number.isSafeInteger(by) || by === 0)
      throw new InvalidIncrement('by must be a non-zero safe integer');

    const members = (await this.guard.run(() =>
      runScript(
        this.redis.client,
        COUNTER_INCREMENT,
        [this.pendingKey],
        [member, by, this.pendingCap],
      ),
    )) as number;
    if (members < 0) {
      cacheMetrics().counterOverflow.add(1, { counter: this.name });
      throw new CounterOverflow(this.name, this.pendingCap);
    }
    cacheMetrics().counterPending.set(members, { counter: this.name });
  }

  /** Returns the drained deltas; the caller persists them (and re-adds on failure). */
  async drain(): Promise<Map<string, number>> {
    const flat = (await this.guard.run(() =>
      runScript(this.redis.client, COUNTER_DRAIN, [this.pendingKey]),
    )) as string[];
    cacheMetrics().counterPending.set(0, { counter: this.name });
    return toDeltas(flat);
  }

  /** Puts deltas back after a failed flush so counts aren't lost. */
  async restore(deltas: Map<string, number>): Promise<void> {
    if (deltas.size === 0) return;
    await this.guard.run(async () => {
      const pipeline = this.redis.client.pipeline();
      for (const [member, by] of deltas)
        pipeline.hincrby(this.pendingKey, member, by);
      const replies = (await pipeline.exec()) ?? [];
      for (const [error] of replies) if (error) throw error;
    });
  }

  /** Moves every pending count into a batch held under `batchId` until it is committed. */
  async claim(): Promise<{ batchId: string; deltas: Map<string, number> }> {
    const batchId = randomUUID();
    const flat = (await this.guard.run(() =>
      runScript(
        this.redis.client,
        COUNTER_CLAIM,
        [this.pendingKey, this.claimsKey, this.claimPrefix + batchId],
        [this.clock.nowMs(), batchId],
      ),
    )) as string[];
    cacheMetrics().counterPending.set(0, { counter: this.name });
    return { batchId, deltas: toDeltas(flat) };
  }

  /** Deletes a claimed batch for good; unknown or already committed ids are a no-op. */
  async commit(batchId: string): Promise<{ committed: boolean }> {
    const existed = (await this.guard.run(() =>
      runScript(
        this.redis.client,
        COUNTER_COMMIT,
        [this.claimPrefix + batchId, this.claimsKey],
        [batchId],
      ),
    )) as number;
    return { committed: existed === 1 };
  }

  /** Merges a claimed batch back into the pending counts at once. */
  async release(batchId: string): Promise<void> {
    await this.guard.run(() =>
      runScript(
        this.redis.client,
        COUNTER_RELEASE,
        [this.pendingKey, this.claimPrefix + batchId, this.claimsKey],
        [batchId],
      ),
    );
  }

  /** Merges back every batch claimed longer than the claim age ago; returns how many. */
  async reclaimExpired(): Promise<number> {
    return (await this.guard.run(() =>
      runScript(
        this.redis.client,
        COUNTER_RECLAIM,
        [this.pendingKey, this.claimsKey],
        [this.clock.nowMs() - this.claimAgeMs, this.claimPrefix],
      ),
    )) as number;
  }
}

function toDeltas(flat: string[]): Map<string, number> {
  const deltas = new Map<string, number>();
  for (let i = 0; i < flat.length; i += 2)
    deltas.set(flat[i], Number(flat[i + 1]));
  return deltas;
}
