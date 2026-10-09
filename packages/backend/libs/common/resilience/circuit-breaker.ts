import { Clock } from '@app/common/core/clock';
import { AppError, ErrorArea } from '@app/common/errors/error.types';
import {
  CounterHandle,
  GaugeHandle,
  MetricsRegistry,
} from '@app/common/telemetry/metrics-registry';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Dependency name; the only label on the breaker metrics. */
  name: string;
  clock: Clock;
  /** Rolling window the failure rate is computed over. */
  windowMs: number;
  /** Calls inside the window before the rate is looked at. */
  minimumCalls: number;
  /** 0..1; the circuit opens when `failures / calls` reaches it. */
  failureRateThreshold: number;
  /** A call that takes at least this long counts as a failure even if it succeeded. */
  slowCallMs?: number;
  openDurationMs: number;
  /** Trial calls admitted while HALF_OPEN; all must succeed to close the circuit. */
  halfOpenCalls: number;
  /** Decides whether a thrown error counts as a failure. Default: every error does (the client excludes `4xx`). */
  isFailure?: (error: unknown) => boolean;
}

/** Raised for a call refused because the circuit is open; carries how long the caller should wait. */
export class CircuitOpenError extends AppError {
  readonly kind = 'circuit_open' as const;

  constructor(
    readonly dependency: string,
    readonly retryAfterMs: number,
  ) {
    super({
      code: 'dependency_unavailable',
      status: 503,
      title: 'Dependency unavailable',
      detail:
        'A service this request depends on is temporarily unavailable. Retry shortly.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    });
  }
}

export interface ExecuteOptions<T> {
  /** Used instead of failing when the circuit is open; its result comes back flagged `degraded`. */
  fallback?: () => Promise<T>;
}

const STATE_VALUE: Record<CircuitState, number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

/**
 * Per-dependency circuit breaker (FR-059): CLOSED counts calls in a rolling window and opens at a failure rate;
 * OPEN refuses calls until the open duration has passed; HALF_OPEN admits a bounded number of trial calls, all of
 * which must succeed to close again. Time comes from the injected clock only.
 */
export class CircuitBreaker {
  private current: CircuitState = 'CLOSED';
  private openedAt = 0;
  private outcomes: { at: number; failure: boolean }[] = [];
  private trialsStarted = 0;
  private trialsSucceeded = 0;
  private readonly stateGauge: GaugeHandle;
  private readonly transitions: CounterHandle;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.stateGauge = MetricsRegistry.gauge({
      name: 'circuit_breaker_state',
      help: 'Circuit state: 0 closed, 1 half-open, 2 open',
      labels: ['dependency'],
    });
    this.transitions = MetricsRegistry.counter({
      name: 'circuit_breaker_transitions_total',
      help: 'Circuit state transitions',
      labels: ['dependency', 'to'],
    });
    this.stateGauge.set(0, { dependency: options.name });
  }

  /** Current state; an OPEN circuit becomes HALF_OPEN once its open duration has passed. */
  state(): CircuitState {
    if (
      this.current === 'OPEN' &&
      this.options.clock.nowMs() - this.openedAt >= this.options.openDurationMs
    ) {
      this.transition('HALF_OPEN');
      this.trialsStarted = 0;
      this.trialsSucceeded = 0;
    }
    return this.current;
  }

  async execute<T>(
    fn: () => Promise<T>,
    options: ExecuteOptions<T> = {},
  ): Promise<{ value: T; degraded: boolean }> {
    const state = this.state();
    if (state === 'OPEN')
      return this.refuse(
        options,
        this.openedAt +
          this.options.openDurationMs -
          this.options.clock.nowMs(),
      );
    if (state === 'HALF_OPEN') {
      if (this.trialsStarted >= this.options.halfOpenCalls)
        return this.refuse(options, 1_000);
      this.trialsStarted++;
    }

    const startedAt = this.options.clock.nowMs();
    let value: T;
    try {
      value = await fn();
    } catch (error) {
      this.record(
        this.options.isFailure ? this.options.isFailure(error) : true,
        state,
      );
      throw error;
    }
    const slow =
      this.options.slowCallMs !== undefined &&
      this.options.clock.nowMs() - startedAt >= this.options.slowCallMs;
    this.record(slow, state);
    return { value, degraded: false };
  }

  private async refuse<T>(
    options: ExecuteOptions<T>,
    retryAfterMs: number,
  ): Promise<{ value: T; degraded: boolean }> {
    if (options.fallback)
      return { value: await options.fallback(), degraded: true };
    throw new CircuitOpenError(this.options.name, Math.max(0, retryAfterMs));
  }

  private record(failure: boolean, startedIn: CircuitState): void {
    const now = this.options.clock.nowMs();
    if (startedIn === 'HALF_OPEN') {
      // A straggler from before the circuit changed state says nothing about the trial.
      if (this.current !== 'HALF_OPEN') return;
      if (failure) return this.open(now);
      if (++this.trialsSucceeded >= this.options.halfOpenCalls) {
        this.outcomes = [];
        this.transition('CLOSED');
      }
      return;
    }
    if (this.current !== 'CLOSED') return;
    this.outcomes.push({ at: now, failure });
    this.outcomes = this.outcomes.filter(
      (o) => now - o.at < this.options.windowMs,
    );
    const calls = this.outcomes.length;
    const failures = this.outcomes.filter((o) => o.failure).length;
    if (
      calls >= this.options.minimumCalls &&
      failures / calls >= this.options.failureRateThreshold
    )
      this.open(now);
  }

  private open(now: number): void {
    this.openedAt = now;
    this.outcomes = [];
    this.transition('OPEN');
  }

  private transition(to: CircuitState): void {
    this.current = to;
    this.stateGauge.set(STATE_VALUE[to], { dependency: this.options.name });
    this.transitions.add(1, { dependency: this.options.name, to });
  }
}
