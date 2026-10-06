/**
 * Per-instance token bucket used as (a) the fail-open safety net when Redis
 * is down and (b) the reference implementation the Lua script mirrors.
 * Bounded number of keys (LRU-ish eviction of the oldest) so an attacker
 * rotating keys can't grow memory without limit.
 */
export class InMemoryTokenBucket {
  private readonly buckets = new Map<string, { tokens: number; ts: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string, requested = 1): { granted: boolean; remaining: number; retryAfterMs: number } {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
      bucket = { tokens: this.capacity, ts: now };
    } else {
      this.buckets.delete(key); // re-insert → most recently used at the end
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.ts) * this.refillPerMs);
    bucket.ts = now;
    this.buckets.set(key, bucket);

    if (bucket.tokens >= requested) {
      bucket.tokens -= requested;
      return { granted: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    return { granted: false, remaining: Math.floor(bucket.tokens), retryAfterMs: Math.ceil((requested - bucket.tokens) / this.refillPerMs) };
  }
}
