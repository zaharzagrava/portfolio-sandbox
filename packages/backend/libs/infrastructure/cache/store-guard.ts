import { Clock } from '@app/common/core/clock';
import { CacheUnavailable } from './cache.errors';
import { CacheToolkitConfig } from './cache.config';
import { CacheLog } from './cache-log';
import { cacheMetrics } from './cache-metrics';

export type GuardState = 'closed' | 'open' | 'half-open';

const GAUGE: Record<GuardState, number> = {
  closed: 0,
  open: 1,
  'half-open': 2,
};

/** A Redis server reply error means the store is alive and answered; it is not an outage. */
const isOutage = (error: unknown): boolean =>
  !(error instanceof Error && error.name === 'ReplyError');

/**
 * Every store call goes through here: a per-call timeout (the late reply is discarded) and a circuit breaker
 * (5 consecutive failures within 10 s open it for 5 s, then one probe call decides). Any failure surfaces as
 * `CacheUnavailable`. The breaker is O(1) per call: the shared `CircuitBreaker` keeps every outcome of its window,
 * which is too slow for a call made on every cache read (R-03).
 */
export class StoreGuard {
  private current: GuardState = 'closed';
  private consecutiveFailures = 0;
  private firstFailureAt = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly clock: Clock,
    private readonly config: CacheToolkitConfig,
    private readonly log: CacheLog,
  ) {
    cacheMetrics().breakerState.set(GAUGE.closed);
  }

  state(): GuardState {
    if (
      this.current === 'open' &&
      this.clock.nowMs() - this.openedAt >= this.config.breakerOpenMs
    ) {
      this.transition('half-open');
      this.probing = false;
    }
    return this.current;
  }

  async run<T>(
    fn: () => Promise<T>,
    timeoutMs: number = this.config.storeTimeoutMs,
  ): Promise<T> {
    const state = this.state();
    if (state === 'open') throw new CacheUnavailable('circuit open');
    let probe = false;
    if (state === 'half-open') {
      if (this.probing)
        throw new CacheUnavailable('circuit half-open, probe running');
      this.probing = true;
      probe = true;
    }

    let value: T;
    try {
      value = await this.withTimeout(fn, timeoutMs);
    } catch (error) {
      if (isOutage(error)) this.onFailure(probe);
      else this.onSuccess(probe);
      throw error instanceof CacheUnavailable
        ? error
        : new CacheUnavailable(
            error instanceof Error ? error.message : String(error),
            error,
          );
    }
    this.onSuccess(probe);
    return value;
  }

  private onSuccess(probe: boolean): void {
    this.consecutiveFailures = 0;
    if (probe) {
      this.probing = false;
      if (this.current === 'half-open') this.transition('closed');
    }
  }

  private onFailure(probe: boolean): void {
    const now = this.clock.nowMs();
    if (probe) {
      this.probing = false;
      this.open(now);
      return;
    }
    if (this.current !== 'closed') return; // a straggler from before the circuit opened
    if (
      this.consecutiveFailures === 0 ||
      now - this.firstFailureAt > this.config.breakerWindowMs
    ) {
      this.consecutiveFailures = 0;
      this.firstFailureAt = now;
    }
    if (++this.consecutiveFailures >= this.config.breakerMinimumCalls)
      this.open(now);
  }

  private open(now: number): void {
    this.openedAt = now;
    this.consecutiveFailures = 0;
    this.transition('open');
  }

  private transition(to: GuardState): void {
    if (to === this.current) return;
    this.log.info(`store breaker ${this.current} -> ${to}`);
    this.current = to;
    cacheMetrics().breakerState.set(GAUGE[to]);
  }

  private withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new CacheUnavailable(`timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      let call: Promise<T>;
      try {
        call = fn();
      } catch (error) {
        clearTimeout(timer);
        reject(toError(error));
        return;
      }
      call.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(toError(error));
        },
      );
    });
  }
}

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));
