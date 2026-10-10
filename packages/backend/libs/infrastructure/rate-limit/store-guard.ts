import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { RateLimitConfig } from './rate-limit.config';
import { RateLimitMetrics } from './rate-limit.metrics';

/** A store call failed, timed out, or was skipped because the breaker is open. Never carries the driver's text. */
export class StoreUnavailableError extends Error {
  constructor(readonly cause_: 'error' | 'timeout' | 'breaker-open') {
    super(`rate limit store unavailable (${cause_})`);
    this.name = 'StoreUnavailableError';
  }
}

type BreakerState = 'closed' | 'open' | 'half-open';
/** AS-74: 1 while the breaker is not closed (open, or letting its probe through), 0 otherwise. */
const STATE_VALUE: Record<BreakerState, number> = {
  closed: 0,
  'half-open': 1,
  open: 1,
};

/**
 * Per-call timeout and a consecutive-failure breaker around every store call (FR-019, FR-022). No retry inside a
 * decision (IV.6). After `breakerFailures` failures in a row the store is skipped for `breakerOpenMs`; then exactly
 * one probe is let through, whose success closes the breaker and whose failure reopens it.
 */
@Injectable()
export class StoreGuard {
  private readonly logger = new Logger('RateLimitStore');
  private readonly clock: Clock;
  private state: BreakerState = 'closed';
  private failures = 0;
  private openUntil = 0;
  private probing = false;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly metrics: RateLimitMetrics,
    @Optional() @Inject(CLOCK) clock?: Clock,
  ) {
    this.clock = clock ?? new SystemClock();
    this.metrics.breakerState.set(0);
  }

  get breaker(): BreakerState {
    return this.state;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let probe = false;
    if (this.state === 'open') {
      if (this.clock.nowMs() < this.openUntil)
        throw new StoreUnavailableError('breaker-open');
      this.transition('half-open');
    }
    if (this.state === 'half-open') {
      if (this.probing) throw new StoreUnavailableError('breaker-open');
      this.probing = true;
      probe = true;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new StoreUnavailableError('timeout')),
            this.config.storeTimeoutMs,
          );
        }),
      ]);
      this.failures = 0;
      if (probe) this.transition('closed');
      return result;
    } catch (error) {
      if (this.state !== 'open') {
        this.failures++;
        if (probe || this.failures >= this.config.breakerFailures) {
          this.openUntil = this.clock.nowMs() + this.config.breakerOpenMs;
          this.transition('open');
        }
      }
      throw error instanceof StoreUnavailableError
        ? error
        : new StoreUnavailableError('error');
    } finally {
      if (timer) clearTimeout(timer);
      if (probe) this.probing = false;
    }
  }

  private transition(next: BreakerState): void {
    if (this.state === next) return;
    const line = `rate limit store breaker ${this.state} -> ${next}`;
    if (next === 'open') this.logger.warn(line);
    else this.logger.log(line);
    this.state = next;
    this.metrics.breakerState.set(STATE_VALUE[next]);
  }
}
