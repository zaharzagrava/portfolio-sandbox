/**
 * Caps retries to a fraction of recent requests (Finagle/gRPC "retry budget").
 * Per-call retry limits alone multiply load during an outage: 3 retries at
 * every layer of a 3-deep call chain = 64× traffic on the failing service.
 * With a budget, retries stop once they exceed e.g. 10% of traffic.
 */
export class RetryBudget {
  private requests = 0;
  private retries = 0;
  private windowStart: number;

  constructor(
    private readonly ratio = 0.1,
    private readonly minRetriesPerWindow = 10,
    private readonly windowMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {
    this.windowStart = now();
  }

  recordRequest(): void {
    this.roll();
    this.requests++;
  }

  tryAcquireRetry(): boolean {
    this.roll();
    const allowed = Math.max(this.minRetriesPerWindow, Math.floor(this.requests * this.ratio));
    if (this.retries >= allowed) return false;
    this.retries++;
    return true;
  }

  private roll(): void {
    if (this.now() - this.windowStart >= this.windowMs) {
      this.windowStart = this.now();
      this.requests = 0;
      this.retries = 0;
    }
  }
}
