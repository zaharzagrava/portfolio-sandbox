import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { assertValidCost } from './cost';
import { FallbackLimiter } from './fallback-limiter';
import { LocalLease } from './local-lease';
import {
  CONCURRENCY_ACQUIRE,
  PENALIZE,
  REFUND_SLIDING_WINDOW,
  REFUND_TOKEN_BUCKET,
  RESET,
  SLIDING_WINDOW,
  TOKEN_BUCKET,
} from './lua';
import {
  concurrencyKey,
  slidingWindowBase,
  tokenBucketKey,
} from './policy-keys';
import { PolicyRegistry } from './policy-registry';
import { RateLimitConfig } from './rate-limit.config';
import {
  InvalidPenaltyError,
  UnsupportedPenaltyError,
} from './rate-limit.errors';
import { RateLimitMetrics } from './rate-limit.metrics';
import type {
  AcquireResult,
  RateLimitDecision,
  RateLimitPolicy,
  RateLimitPolicyName,
} from './rate-limit.types';
import { ScriptLoader } from './script-loader';
import { StoreGuard, StoreUnavailableError } from './store-guard';
import { TimeSource } from './time-source';

/** A decision script's raw answer, mapped to a `RateLimitDecision` plus how many tokens the call really granted. */
interface StoreAnswer {
  decision: RateLimitDecision;
  granted: number;
}

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly clock: Clock;
  private readonly fallback: FallbackLimiter;
  private readonly lease: LocalLease;

  constructor(
    private readonly registry: PolicyRegistry,
    private readonly scripts: ScriptLoader,
    private readonly guard: StoreGuard,
    private readonly time: TimeSource,
    private readonly config: RateLimitConfig,
    private readonly metrics: RateLimitMetrics,
    private readonly redis: RedisService,
    @Optional() @Inject(CLOCK) clock?: Clock,
  ) {
    this.clock = clock ?? new SystemClock();
    this.fallback = new FallbackLimiter({
      instances: config.fallbackInstances,
    });
    this.lease = new LocalLease(config.leaseTtlMs);
  }

  /**
   * One decision for `subject` under `policyName`. Never throws for a denial or an outage (the decision says which);
   * throws `InvalidRateLimitCostError` for a cost that is not a positive integer. A `cost` above the policy's limit is a
   * permanent denial (`reason: 'cost-exceeds-limit'`, `retryAfterMs: null`).
   */
  async check(
    policyName: RateLimitPolicyName,
    subject: string,
    cost = 1,
  ): Promise<RateLimitDecision> {
    assertValidCost(cost);
    const policy = this.registry.get(policyName);
    const started = process.hrtime.bigint();
    const decision = await this.decide(policyName, policy, subject, cost);
    this.record(policyName, decision, started);
    return decision;
  }

  /**
   * Concurrency policies: takes a lease, or says why not. `release()` is idempotent and frees only this lease; a holder
   * that never releases loses its lease at the end of the policy's lease length.
   */
  async acquire(
    policyName: RateLimitPolicyName,
    subject: string,
  ): Promise<AcquireResult> {
    const policy = this.registry.get(policyName);
    if (policy.algorithm !== 'concurrency')
      throw new Error(`Policy ${policyName} is not a concurrency policy`);
    const started = process.hrtime.bigint();
    let result: AcquireResult;
    try {
      result = await this.acquireInStore(policyName, policy, subject);
    } catch (error) {
      if (!(error instanceof StoreUnavailableError)) throw error;
      result = this.acquireWithoutStore(policyName, policy, subject);
    }
    this.record(policyName, result.decision, started);
    return result;
  }

  /** Gives back `units` taken earlier (a request refused by a later policy, a failed attempt that must not count). Best effort. */
  async refund(
    policyName: RateLimitPolicyName,
    subject: string,
    units = 1,
  ): Promise<void> {
    assertValidCost(units);
    const policy = this.registry.get(policyName);
    try {
      if (policy.algorithm === 'tokenBucket')
        await this.guard.run(() =>
          this.scripts.run(
            REFUND_TOKEN_BUCKET,
            [tokenBucketKey(policyName, subject)],
            [policy.limit, units],
          ),
        );
      else if (policy.algorithm === 'slidingWindow')
        await this.guard.run(() =>
          this.scripts.run(
            REFUND_SLIDING_WINDOW,
            [slidingWindowBase(policyName, subject)],
            [policy.windowMs, units, this.time.overrideMs() ?? ''],
          ),
        );
    } catch (error) {
      this.swallow(error, 'refund');
    }
  }

  /** Forgets everything stored for `subject` under the policy (a success after failures). Best effort; no key scan. */
  async reset(policyName: RateLimitPolicyName, subject: string): Promise<void> {
    const policy = this.registry.get(policyName);
    this.lease.drop(tokenBucketKey(policyName, subject));
    try {
      if (policy.algorithm === 'tokenBucket')
        await this.guard.run(() =>
          this.scripts.run(
            RESET,
            [tokenBucketKey(policyName, subject)],
            ['tb', 0, ''],
          ),
        );
      else if (policy.algorithm === 'slidingWindow')
        await this.guard.run(() =>
          this.scripts.run(
            RESET,
            [slidingWindowBase(policyName, subject)],
            ['sw', policy.windowMs, this.time.overrideMs() ?? ''],
          ),
        );
      else
        await this.guard.run(() =>
          this.redis.client.del(concurrencyKey(policyName, subject)),
        );
    } catch (error) {
      this.swallow(error, 'reset');
    }
  }

  /**
   * Token buckets only: empties the bucket and pauses it for `ms` for every instance (a provider told us to slow
   * down). Never shortens a pause; capped at `rate_limit_penalty_max_ms`. Returns `false` when the store is down.
   */
  async penalize(
    policyName: RateLimitPolicyName,
    subject: string,
    ms: number,
  ): Promise<boolean> {
    const policy = this.registry.get(policyName);
    if (policy.algorithm !== 'tokenBucket')
      throw new UnsupportedPenaltyError(policyName, policy.algorithm);
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0)
      throw new InvalidPenaltyError(ms);
    const pause = Math.min(Math.ceil(ms), this.config.penaltyMaxMs);
    const key = tokenBucketKey(policyName, subject);
    this.lease.drop(key);
    try {
      await this.guard.run(() =>
        this.scripts.run(
          PENALIZE,
          [key],
          [pause, this.time.overrideMs() ?? '', policy.windowMs],
        ),
      );
      this.metrics.penalties.add(1, { policy: policyName });
      return true;
    } catch (error) {
      this.swallow(error, 'penalize');
      return false;
    }
  }

  // ---- decisions ----

  private async decide(
    name: string,
    policy: RateLimitPolicy,
    subject: string,
    cost: number,
  ): Promise<RateLimitDecision> {
    if (cost > policy.limit) return this.costExceeded(name, policy);
    try {
      switch (policy.algorithm) {
        case 'tokenBucket':
          return await this.tokenBucket(name, policy, subject, cost);
        case 'slidingWindow':
          return await this.slidingWindow(name, policy, subject, cost);
        case 'concurrency':
          throw new Error(
            `Policy ${name} is a concurrency policy: use acquire(), not check()`,
          );
      }
    } catch (error) {
      if (error instanceof StoreUnavailableError)
        return this.withoutStore(name, policy, subject, cost);
      throw error;
    }
  }

  private async tokenBucket(
    name: string,
    policy: RateLimitPolicy,
    subject: string,
    cost: number,
  ): Promise<RateLimitDecision> {
    if (!policy.localLeaseFraction || cost !== 1)
      return (
        await this.guard.run(() =>
          this.tokenBucketInStore(name, policy, subject, cost, false),
        )
      ).decision;

    const key = tokenBucketKey(name, subject);
    for (;;) {
      const now = this.clock.nowMs();
      const left = this.lease.take(key, now);
      if (left !== null)
        return {
          allowed: true,
          policy: name,
          limit: policy.limit,
          remaining: left,
          retryAfterMs: 0,
          resetMs: 0,
          source: 'local-lease',
        };
      const denial = this.lease.recentDenial(key, now);
      if (denial) return denial;
      const pending = this.lease.pending(key);
      if (pending) {
        const outcome = await pending;
        if (!outcome.allowed) return outcome;
        continue;
      }
      return this.lease.refill(key, () =>
        this.refillLease(name, policy, subject, key),
      );
    }
  }

  /** Takes a slice of the budget from the store in one call: one token for this request, the rest as a local lease. */
  private async refillLease(
    name: string,
    policy: RateLimitPolicy,
    subject: string,
    key: string,
  ): Promise<RateLimitDecision> {
    const slice = Math.max(
      1,
      Math.floor(policy.limit * (policy.localLeaseFraction as number)),
    );
    const { decision, granted } = await this.guard.run(() =>
      this.tokenBucketInStore(name, policy, subject, slice, true),
    );
    const now = this.clock.nowMs();
    if (granted > 0) {
      this.lease.add(key, granted - 1, now);
      return { ...decision, remaining: granted - 1 };
    }
    this.lease.memo(key, decision, now);
    return decision;
  }

  private async tokenBucketInStore(
    name: string,
    policy: RateLimitPolicy,
    subject: string,
    requested: number,
    partial: boolean,
  ): Promise<StoreAnswer> {
    const [granted, remaining, retryAfterMs, resetMs, flag] =
      await this.scripts.run(
        TOKEN_BUCKET,
        [tokenBucketKey(name, subject)],
        [
          policy.limit,
          policy.limit / policy.windowMs,
          requested,
          partial ? 1 : 0,
          this.time.overrideMs() ?? '',
        ],
      );
    if (flag === 2)
      return { decision: this.costExceeded(name, policy), granted: 0 };
    return {
      granted,
      decision: {
        allowed: granted > 0,
        policy: name,
        limit: policy.limit,
        remaining,
        retryAfterMs: retryAfterMs < 0 ? null : retryAfterMs,
        resetMs,
        source: 'store',
        ...(granted > 0
          ? {}
          : {
              reason:
                flag === 1 ? ('paused' as const) : ('limit-exceeded' as const),
            }),
      },
    };
  }

  private async slidingWindow(
    name: string,
    policy: RateLimitPolicy,
    subject: string,
    cost: number,
  ): Promise<RateLimitDecision> {
    const [allowed, remaining, retryAfterMs, resetMs, flag] =
      await this.guard.run(() =>
        this.scripts.run(
          SLIDING_WINDOW,
          [slidingWindowBase(name, subject)],
          [policy.limit, policy.windowMs, cost, this.time.overrideMs() ?? ''],
        ),
      );
    if (flag === 2) return this.costExceeded(name, policy);
    return {
      allowed: allowed === 1,
      policy: name,
      limit: policy.limit,
      remaining,
      retryAfterMs: allowed === 1 ? 0 : retryAfterMs,
      resetMs,
      source: 'store',
      ...(allowed === 1 ? {} : { reason: 'limit-exceeded' as const }),
    };
  }

  private async acquireInStore(
    name: string,
    policy: RateLimitPolicy,
    subject: string,
  ): Promise<AcquireResult> {
    const key = concurrencyKey(name, subject);
    const id = randomUUID();
    const [acquired, remaining, retryAfterMs] = await this.guard.run(() =>
      this.scripts.run(
        CONCURRENCY_ACQUIRE,
        [key],
        [policy.limit, policy.windowMs, id, this.time.overrideMs() ?? ''],
      ),
    );
    const decision: RateLimitDecision = {
      allowed: acquired === 1,
      policy: name,
      limit: policy.limit,
      remaining,
      retryAfterMs: acquired === 1 ? 0 : retryAfterMs,
      resetMs: acquired === 1 ? policy.windowMs : retryAfterMs,
      source: 'store',
      ...(acquired === 1 ? {} : { reason: 'limit-exceeded' as const }),
    };
    if (acquired !== 1) return { acquired: false, decision };
    let released = false;
    return {
      acquired: true,
      decision,
      release: async () => {
        if (released) return;
        released = true;
        // Best effort: a lease that cannot be released ends with its lease length.
        await this.redis.client.zrem(key, id).catch(() => undefined);
      },
    };
  }

  // ---- no store ----

  /** The store failed or is skipped: apply the policy's fail mode (FR-020, FR-021). */
  private withoutStore(
    name: string,
    policy: RateLimitPolicy,
    subject: string,
    cost: number,
  ): RateLimitDecision {
    this.metrics.storeUnavailable.add(1, {
      policy: name,
      fail_mode: policy.failMode,
    });
    if (policy.failMode === 'closed')
      return this.unavailableDenial(name, policy);
    const local = this.fallback.check(
      name,
      policy,
      subject,
      cost,
      this.clock.nowMs(),
    );
    return {
      allowed: local.allowed,
      policy: name,
      limit: policy.limit,
      remaining: local.remaining,
      retryAfterMs: local.retryAfterMs,
      resetMs: local.resetMs,
      source: 'fallback',
      ...(local.allowed ? {} : { reason: 'limit-exceeded' as const }),
    };
  }

  private acquireWithoutStore(
    name: string,
    policy: RateLimitPolicy,
    subject: string,
  ): AcquireResult {
    this.metrics.storeUnavailable.add(1, {
      policy: name,
      fail_mode: policy.failMode,
    });
    if (policy.failMode === 'closed')
      return {
        acquired: false,
        decision: this.unavailableDenial(name, policy),
      };
    const release = this.fallback.acquire(name, policy, subject);
    const base = {
      policy: name,
      limit: policy.limit,
      resetMs: policy.windowMs,
      source: 'fallback' as const,
    };
    if (!release)
      return {
        acquired: false,
        decision: {
          ...base,
          allowed: false,
          remaining: 0,
          retryAfterMs: 1_000,
          reason: 'limit-exceeded',
        },
      };
    return {
      acquired: true,
      release: () => Promise.resolve(release()),
      decision: { ...base, allowed: true, remaining: 0, retryAfterMs: 0 },
    };
  }

  private unavailableDenial(
    name: string,
    policy: RateLimitPolicy,
  ): RateLimitDecision {
    return {
      allowed: false,
      policy: name,
      limit: policy.limit,
      remaining: 0,
      retryAfterMs: 1_000,
      resetMs: 1_000,
      source: 'store',
      reason: 'store-unavailable',
    };
  }

  private costExceeded(
    name: string,
    policy: RateLimitPolicy,
  ): RateLimitDecision {
    return {
      allowed: false,
      policy: name,
      limit: policy.limit,
      remaining: 0,
      retryAfterMs: null,
      resetMs: 0,
      source: 'store',
      reason: 'cost-exceeds-limit',
    };
  }

  private swallow(error: unknown, what: string): void {
    if (error instanceof StoreUnavailableError) {
      this.logger.debug(`rate limit ${what} skipped: store unavailable`);
      return;
    }
    throw error;
  }

  private record(
    name: string,
    decision: RateLimitDecision,
    started: bigint,
  ): void {
    this.metrics.decisions.add(1, {
      policy: name,
      allowed: String(decision.allowed),
      source: decision.source,
      reason: decision.reason ?? 'none',
    });
    this.metrics.duration.record(
      Number(process.hrtime.bigint() - started) / 1e9,
      { policy: name, source: decision.source },
    );
  }
}
