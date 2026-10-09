import { Clock } from '@app/common/core/clock';

interface HostWindow {
  startedAt: number;
  requests: number;
  retries: number;
}

export interface RetryBudgetOptions {
  /** Time source; the window is measured on it, never on the wall clock. */
  clock: Clock;
  /** Retries allowed as a fraction of requests in the window. */
  ratio?: number;
  /** Retries always allowed per window, so a quiet host can still retry. */
  minRetriesPerWindow?: number;
  windowMs?: number;
  /** Called with the host each time a retry is refused for lack of budget. */
  onExhausted?: (host: string) => void;
}

/**
 * Caps retries to a fraction of recent requests (Finagle/gRPC "retry budget"), per host.
 * Per-call retry limits alone multiply load during an outage: 3 retries at
 * every layer of a 3-deep call chain = 64x traffic on the failing service.
 * With a budget, retries stop once they exceed 10 % of traffic (floor 10) in a 10 s window.
 */
export class RetryBudget {
  private readonly hosts = new Map<string, HostWindow>();
  private readonly clock: Clock;
  private readonly ratio: number;
  private readonly minRetries: number;
  private readonly windowMs: number;
  private readonly onExhausted?: (host: string) => void;

  constructor(options: RetryBudgetOptions) {
    this.clock = options.clock;
    this.ratio = options.ratio ?? 0.1;
    this.minRetries = options.minRetriesPerWindow ?? 10;
    this.windowMs = options.windowMs ?? 10_000;
    this.onExhausted = options.onExhausted;
  }

  recordRequest(host: string): void {
    this.window(host).requests++;
  }

  tryAcquireRetry(host: string): boolean {
    const w = this.window(host);
    const allowed = Math.max(
      this.minRetries,
      Math.floor(w.requests * this.ratio),
    );
    if (w.retries >= allowed) {
      this.onExhausted?.(host);
      return false;
    }
    w.retries++;
    return true;
  }

  private window(host: string): HostWindow {
    const now = this.clock.nowMs();
    let w = this.hosts.get(host);
    if (!w || now - w.startedAt >= this.windowMs) {
      w = { startedAt: now, requests: 0, retries: 0 };
      this.hosts.set(host, w);
    }
    return w;
  }
}
