import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { metrics } from '@opentelemetry/api';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CONCURRENCY_ACQUIRE, SLIDING_WINDOW, TOKEN_BUCKET } from './lua';
import { InMemoryTokenBucket } from './in-memory-token-bucket';
import { RATE_LIMIT_POLICIES, RateLimitDecision, RateLimitPolicy, RateLimitPolicyName } from './rate-limit.types';

/** Local leases expire quickly so an idle instance can't hoard budget that other instances need. */
const LEASE_TTL_MS = 1_000;
/** Fail-open fallback assumes the fleet splits the budget roughly evenly. */
const ASSUMED_INSTANCES = 4;

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly leases = new Map<string, { tokens: number; expiresAt: number }>();
  /** One lease refill per hot key at a time: concurrent misses wait for it instead of stampeding Redis. */
  private readonly refills = new Map<string, Promise<RateLimitDecision>>();
  private readonly fallbacks = new Map<string, InMemoryTokenBucket>();
  private consecutiveRedisFailures = 0;
  private redisSkipUntil = 0;
  private readonly decisions = metrics.getMeter('rate-limit').createCounter('rate_limit_decisions_total');

  constructor(private readonly redis: RedisService) {}

  /** `cost` > 1 takes several tokens at once (token-weighted budgets, e.g. LLM tokens/min); token buckets only. */
  async check(policyName: RateLimitPolicyName, subject: string, cost = 1): Promise<RateLimitDecision> {
    const policy: RateLimitPolicy = RATE_LIMIT_POLICIES[policyName];
    const key = `rl:{${policyName}:${subject}}`;
    const decision = await this.decide(policyName, policy, key, cost);
    this.decisions.add(1, { policy: policyName, allowed: String(decision.allowed), source: decision.source });
    return decision;
  }

  /** Concurrency policies: returns a release function, or null when the limit is reached. */
  async acquire(policyName: RateLimitPolicyName, subject: string): Promise<(() => Promise<void>) | null> {
    const policy: RateLimitPolicy = RATE_LIMIT_POLICIES[policyName];
    const key = `rl:{${policyName}:${subject}}`;
    const leaseId = randomUUID();
    try {
      const ok = await this.withBreaker(() => this.redis.client.eval(CONCURRENCY_ACQUIRE, 1, key, policy.limit, policy.windowMs, leaseId));
      if (ok !== 1) return null;
      return async () => void (await this.redis.client.zrem(key, leaseId).catch(() => undefined));
    } catch {
      return policy.failMode === 'open' ? async () => undefined : null;
    }
  }

  private takeLease(policy: RateLimitPolicy, key: string): RateLimitDecision | null {
    const lease = this.leases.get(key);
    if (!lease || lease.tokens <= 0 || lease.expiresAt <= Date.now()) return null;
    lease.tokens--;
    return { allowed: true, limit: policy.limit, remaining: lease.tokens, retryAfterMs: 0, resetMs: 0, source: 'local-lease' };
  }

  private async decide(name: string, policy: RateLimitPolicy, key: string, cost: number): Promise<RateLimitDecision> {
    if (policy.algorithm === 'tokenBucket' && policy.localLeaseFraction && cost === 1) {
      for (;;) {
        const leased = this.takeLease(policy, key);
        if (leased) return leased;
        const inFlight = this.refills.get(key);
        if (!inFlight) break;
        // Someone is already refilling this key: share its outcome - a lease to draw from, or its denial.
        const outcome = await inFlight;
        if (!outcome.allowed) return outcome;
      }
      const refill = this.decideOrFallback(name, policy, key, cost);
      this.refills.set(key, refill);
      try {
        return await refill;
      } finally {
        if (this.refills.get(key) === refill) this.refills.delete(key);
      }
    }
    return this.decideOrFallback(name, policy, key, cost);
  }

  private async decideOrFallback(name: string, policy: RateLimitPolicy, key: string, cost: number): Promise<RateLimitDecision> {
    try {
      return await this.withBreaker(() => this.decideInRedis(policy, key, cost));
    } catch (error) {
      this.logger.warn(`rate limiter falling back (${policy.failMode}) for ${name}: ${(error as Error).message}`);
      if (policy.failMode === 'closed') {
        return { allowed: false, limit: policy.limit, remaining: 0, retryAfterMs: 1_000, resetMs: 1_000, source: 'fail-closed' };
      }
      let bucket = this.fallbacks.get(name);
      if (!bucket) {
        const perInstance = Math.max(1, Math.floor(policy.limit / ASSUMED_INSTANCES));
        bucket = new InMemoryTokenBucket(perInstance, perInstance / policy.windowMs);
        this.fallbacks.set(name, bucket);
      }
      const local = bucket.take(key);
      return { allowed: local.granted, limit: policy.limit, remaining: local.remaining, retryAfterMs: local.retryAfterMs, resetMs: local.retryAfterMs, source: 'fallback' };
    }
  }

  private async decideInRedis(policy: RateLimitPolicy, key: string, cost: number): Promise<RateLimitDecision> {
    switch (policy.algorithm) {
      case 'tokenBucket': {
        if (cost > 1) {
          const [granted, remaining, retryAfterMs] = (await this.redis.client.eval(TOKEN_BUCKET, 1, key, policy.limit, policy.limit / policy.windowMs, cost, 0)) as [number, number, number];
          return { allowed: granted > 0, limit: policy.limit, remaining, retryAfterMs, resetMs: retryAfterMs, source: 'redis' };
        }
        const leaseSize = policy.localLeaseFraction ? Math.max(1, Math.floor(policy.limit * policy.localLeaseFraction)) : 1;
        const [granted, remaining, retryAfterMs] = (await this.redis.client.eval(
          TOKEN_BUCKET,
          1,
          key,
          policy.limit,
          policy.limit / policy.windowMs,
          leaseSize,
          leaseSize > 1 ? 1 : 0,
        )) as [number, number, number];
        if (granted > 1) {
          // Add to (never overwrite) a still-valid lease, so no granted token is lost.
          const current = this.leases.get(key);
          const carried = current && current.expiresAt > Date.now() ? current.tokens : 0;
          this.leases.set(key, { tokens: carried + granted - 1, expiresAt: Date.now() + LEASE_TTL_MS });
        }
        return {
          allowed: granted > 0,
          limit: policy.limit,
          remaining,
          retryAfterMs,
          resetMs: Math.ceil(((policy.limit - remaining) * policy.windowMs) / policy.limit),
          source: 'redis',
        };
      }
      case 'slidingWindow': {
        const now = Date.now();
        const window = Math.floor(now / policy.windowMs);
        const base = key.slice(0, -1); // `rl:{name:subject` → keep the hash tag for both windows
        const [allowed, remaining, resetMs] = (await this.redis.client.eval(
          SLIDING_WINDOW,
          2,
          `${base}}:${window}`,
          `${base}}:${window - 1}`,
          policy.limit,
          policy.windowMs,
          now % policy.windowMs,
        )) as [number, number, number];
        return { allowed: allowed === 1, limit: policy.limit, remaining, retryAfterMs: allowed ? 0 : resetMs, resetMs, source: 'redis' };
      }
      case 'concurrency':
        throw new Error('use acquire() for concurrency policies');
    }
  }

  /** Tiny circuit breaker: after 3 consecutive Redis failures skip Redis for 2 s instead of paying a timeout per request. */
  private async withBreaker<T>(fn: () => Promise<T>): Promise<T> {
    if (Date.now() < this.redisSkipUntil) throw new Error('redis circuit open');
    try {
      const result = await fn();
      this.consecutiveRedisFailures = 0;
      return result;
    } catch (error) {
      if (++this.consecutiveRedisFailures >= 3) this.redisSkipUntil = Date.now() + 2_000;
      throw error;
    }
  }
}
