export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Breaker for the catalog source (FR-011): `failureThreshold` consecutive failures open it for `openMs`; then exactly one
 * probe call is let through (half open) while every other call is skipped; the probe's result closes or reopens it.
 * Time is injected, so the machine is pure.
 */
export class CatalogCircuit {
  private failures = 0;
  private openedUntil = 0;
  private probing = false;
  private current: CircuitState = 'closed';

  constructor(
    private readonly options: {
      failureThreshold: number;
      openMs: number;
      now: () => number;
    },
  ) {}

  get state(): CircuitState {
    return this.current;
  }

  /** Whether the caller may call the source now; a `true` must be followed by `recordSuccess` or `recordFailure`. */
  tryAcquire(): boolean {
    if (this.current === 'closed') return true;
    if (this.current === 'open') {
      if (this.options.now() < this.openedUntil) return false;
      this.current = 'half_open';
      this.probing = true;
      return true;
    }
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.probing = false;
    this.current = 'closed';
  }

  recordFailure(): void {
    this.probing = false;
    if (this.current === 'half_open') return this.open();
    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) this.open();
  }

  private open(): void {
    this.current = 'open';
    this.openedUntil = this.options.now() + this.options.openMs;
  }
}
