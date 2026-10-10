export interface GateConfig {
  perUpstream: number;
  perRequest: number;
}

export type Release = () => void;

/** The in-flight calls of one inbound request; created by `ConcurrencyGate.forRequest()`. */
export class RequestSlots {
  inFlight = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async enter(): Promise<void> {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  leave(): void {
    const next = this.waiting.shift();
    if (next)
      next(); // the slot passes straight to the next waiter
    else this.inFlight--;
  }
}

/**
 * Bounded concurrency (S48 FR-010): at most `perUpstream` calls in flight to one upstream from this instance (a call
 * beyond it is refused, the caller reports `UPSTREAM_OVERLOADED`), and at most `perRequest` in flight for one inbound
 * request (an extra call waits for a slot). Pure bookkeeping, no I/O.
 */
export class ConcurrencyGate {
  private readonly counts = new Map<string, number>();

  constructor(private readonly config: GateConfig) {}

  forRequest(): RequestSlots {
    return new RequestSlots(this.config.perRequest);
  }

  inFlight(upstream: string): number {
    return this.counts.get(upstream) ?? 0;
  }

  /** `null` when the upstream is at its cap. The returned release is idempotent. */
  async acquire(
    upstream: string,
    request: RequestSlots,
  ): Promise<Release | null> {
    await request.enter();
    if (this.inFlight(upstream) >= this.config.perUpstream) {
      request.leave();
      return null;
    }
    this.counts.set(upstream, this.inFlight(upstream) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.counts.set(upstream, this.inFlight(upstream) - 1);
      request.leave();
    };
  }
}
