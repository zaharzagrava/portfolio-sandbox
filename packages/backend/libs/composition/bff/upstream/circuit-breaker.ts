export interface BreakerConfig {
  /** Consecutive failures that open the breaker. */
  failures: number;
  /** The failures must all fall inside this span. */
  windowMs: number;
  /** How long it stays open before one probe is allowed. */
  openMs: number;
}

export type BreakerState = 'closed' | 'open' | 'half-open';
export type Admission = 'allow' | 'probe' | 'reject';

/**
 * Per-upstream, per-instance breaker (S48 FR-009). Pure: the clock is injected. The shared HTTP client's rate-based
 * breaker is switched off so this is the only breaker layer (IV.6). Consecutive failures, not a rate, because the spec
 * fixes "5 in a row within 10 s", a single probe while half-open, and one verdict per section.
 */
export class UpstreamBreaker {
  private failureTimes: number[] = [];
  private openedAt = 0;
  private current: BreakerState = 'closed';
  private probing = false;

  constructor(
    private readonly config: BreakerConfig,
    private readonly now: () => number,
  ) {}

  get state(): BreakerState {
    return this.current;
  }

  /** Call before every upstream call. `probe` and `allow` must be followed by `onSuccess` / `onFailure` / `onAbandoned`. */
  tryAcquire(): Admission {
    if (this.current === 'closed') return 'allow';
    if (this.current === 'open') {
      if (this.now() - this.openedAt < this.config.openMs) return 'reject';
      this.current = 'half-open';
    }
    if (this.probing) return 'reject';
    this.probing = true;
    return 'probe';
  }

  onSuccess(): void {
    this.failureTimes = [];
    this.probing = false;
    this.current = 'closed';
  }

  onFailure(): void {
    const now = this.now();
    if (this.current === 'half-open') return this.open(now);
    if (this.current === 'open') return; // a late answer of a call that started before it opened
    this.failureTimes.push(now);
    this.failureTimes = this.failureTimes.filter(
      (at) => now - at < this.config.windowMs,
    );
    if (this.failureTimes.length >= this.config.failures) this.open(now);
  }

  /** The call was cancelled by the caller: it says nothing about the upstream. A cancelled probe frees the probe slot. */
  onAbandoned(): void {
    this.probing = false;
  }

  private open(now: number): void {
    this.current = 'open';
    this.openedAt = now;
    this.probing = false;
    this.failureTimes = [];
  }
}
