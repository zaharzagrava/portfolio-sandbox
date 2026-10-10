import type { RateLimitPolicy } from './rate-limit.types';

export interface FallbackDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetMs: number;
}

type Shape = Pick<RateLimitPolicy, 'algorithm' | 'limit' | 'windowMs'>;

/**
 * In-process limiter used while the store is unavailable under fail open (FR-021). Each instance takes its share of the
 * budget (`limit / instances`); token-bucket and sliding-window policies both use a bucket of that share. Bounded to
 * `maxSubjects` buckets, least recently used evicted (an evicted subject starts full). Time is an argument.
 */
export class FallbackLimiter {
  private readonly buckets = new Map<string, { tokens: number; ts: number }>();
  private readonly inFlight = new Map<string, number>();
  private readonly instances: number;
  private readonly maxSubjects: number;

  constructor(options: { instances: number; maxSubjects?: number }) {
    this.instances = Math.max(1, options.instances);
    this.maxSubjects = options.maxSubjects ?? 50_000;
  }

  get size(): number {
    return this.buckets.size;
  }

  private share(limit: number): number {
    return Math.max(1, Math.floor(limit / this.instances));
  }

  check(
    policyName: string,
    policy: Shape,
    subject: string,
    cost: number,
    nowMs: number,
  ): FallbackDecision {
    const capacity = this.share(policy.limit);
    const rate = capacity / policy.windowMs;
    // A cost above this instance's share would never fit; charging the whole share keeps a fail-open policy usable.
    const charge = Math.min(cost, capacity);
    const key = `${policyName}|${subject}`;
    let bucket = this.buckets.get(key);
    if (bucket) {
      this.buckets.delete(key); // re-insert: most recently used last
      bucket.tokens = Math.min(
        capacity,
        bucket.tokens + Math.max(0, nowMs - bucket.ts) * rate,
      );
      bucket.ts = nowMs;
    } else {
      if (this.buckets.size >= this.maxSubjects)
        this.buckets.delete(this.buckets.keys().next().value as string);
      bucket = { tokens: capacity, ts: nowMs };
    }
    this.buckets.set(key, bucket);

    if (bucket.tokens >= charge) {
      bucket.tokens -= charge;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs: 0,
        resetMs: Math.ceil((capacity - bucket.tokens) / rate),
      };
    }
    const retryAfterMs = Math.ceil((charge - bucket.tokens) / rate);
    return {
      allowed: false,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs,
      resetMs: retryAfterMs,
    };
  }

  /** Concurrency policies: a per-process semaphore; the returned release is idempotent. */
  acquire(
    policyName: string,
    policy: Shape,
    subject: string,
  ): (() => void) | null {
    const key = `${policyName}|${subject}`;
    const held = this.inFlight.get(key) ?? 0;
    if (held >= this.share(policy.limit)) return null;
    this.inFlight.set(key, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const now = (this.inFlight.get(key) ?? 1) - 1;
      if (now <= 0) this.inFlight.delete(key);
      else this.inFlight.set(key, now);
    };
  }
}
