import type { RateLimitDecision } from './rate-limit.types';

interface Lease {
  tokens: number;
  expiresAt: number;
}
interface Memo {
  at: number;
  until: number;
  decision: RateLimitDecision;
}

/** Past this many entries, expired ones are swept on the next write: a key that is never asked again must not stay. */
const SWEEP_AT = 10_000;

/**
 * In-process budget for hot token-bucket keys (FR-014 to FR-017): a slice of tokens taken from the store in one call
 * and spent locally for at most `ttlMs`, plus a short memo of a recent denial. Time is passed in.
 */
export class LocalLease {
  private readonly leases = new Map<string, Lease>();
  private readonly memos = new Map<string, Memo>();
  private readonly refills = new Map<string, Promise<RateLimitDecision>>();

  constructor(private readonly ttlMs: number) {}

  /** Spends one leased token; returns the tokens left, or `null` when there is no usable lease. */
  take(key: string, nowMs: number): number | null {
    const lease = this.leases.get(key);
    if (!lease) return null;
    if (lease.expiresAt <= nowMs) {
      this.leases.delete(key);
      return null;
    }
    if (lease.tokens <= 0) return null;
    lease.tokens--;
    return lease.tokens;
  }

  /** Adds to a still-valid lease (never overwrites it, so no granted token is lost) and renews its lifetime. */
  add(key: string, tokens: number, nowMs: number): void {
    if (tokens <= 0) return;
    if (this.leases.size >= SWEEP_AT) this.sweep(nowMs);
    const current = this.leases.get(key);
    const carried = current && current.expiresAt > nowMs ? current.tokens : 0;
    this.leases.set(key, {
      tokens: carried + tokens,
      expiresAt: nowMs + this.ttlMs,
    });
  }

  memo(key: string, decision: RateLimitDecision, nowMs: number): void {
    if (this.memos.size >= SWEEP_AT) this.sweep(nowMs);
    const wait = Math.min(decision.retryAfterMs ?? 0, 1_000);
    if (wait <= 0) return;
    this.memos.set(key, { at: nowMs, until: nowMs + wait, decision });
  }

  /** A denial still in force for this key, with its wait shortened by the time passed. */
  recentDenial(key: string, nowMs: number): RateLimitDecision | null {
    const memo = this.memos.get(key);
    if (!memo) return null;
    if (memo.until <= nowMs) {
      this.memos.delete(key);
      return null;
    }
    const original = memo.decision.retryAfterMs ?? 0;
    return {
      ...memo.decision,
      source: 'local-lease',
      retryAfterMs: Math.max(1, original - (nowMs - memo.at)),
    };
  }

  /** The refill already in flight for this key, if any: concurrent misses wait for it and share its outcome. */
  pending(key: string): Promise<RateLimitDecision> | undefined {
    return this.refills.get(key);
  }

  /** Runs a store refill as the one in flight for the key. */
  refill(
    key: string,
    start: () => Promise<RateLimitDecision>,
  ): Promise<RateLimitDecision> {
    const promise = start();
    this.refills.set(key, promise);
    const clear = () => {
      if (this.refills.get(key) === promise) this.refills.delete(key);
    };
    promise.then(clear, clear);
    return promise;
  }

  /** Forget the key (a penalty or reset made the lease wrong). */
  drop(key: string): void {
    this.leases.delete(key);
    this.memos.delete(key);
  }

  private sweep(nowMs: number): void {
    for (const [k, v] of this.leases)
      if (v.expiresAt <= nowMs) this.leases.delete(k);
    for (const [k, v] of this.memos) if (v.until <= nowMs) this.memos.delete(k);
  }
}
