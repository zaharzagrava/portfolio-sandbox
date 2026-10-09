import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/** Where lag windows come from. The default samples the real event loop; specs inject a source they drive by hand. */
export interface LagSource {
  /** Calls `onWindow(p99Ms)` once per window; throws when sampling cannot start. */
  start(onWindow: (p99Ms: number) => void): void;
  stop(): void;
}
export const LAG_SOURCE = Symbol('LAG_SOURCE');

const WINDOW_MS = 1_000;
const SAMPLE_INTERVAL_MS = 20;

/**
 * Measures how late a 20 ms timer fires. A synchronous block of 400 ms shows up as one ~380 ms sample. Samples are
 * collected in a plain array that is swapped at every window, so a late sample can never be lost by a reset and
 * nothing accumulates across windows. (`perf_hooks.monitorEventLoopDelay` resets its own baseline on `reset()`, which
 * drops exactly the sample that straddles a window boundary.) Monotonic `hrtime`, not wall-clock time.
 */
export class RealLagSource implements LagSource {
  private sampler?: NodeJS.Timeout;
  private window?: NodeJS.Timeout;

  start(onWindow: (p99Ms: number) => void): void {
    let samples: number[] = [];
    let last = process.hrtime.bigint();
    this.sampler = setInterval(() => {
      const now = process.hrtime.bigint();
      samples.push(Math.max(0, Number(now - last) / 1e6 - SAMPLE_INTERVAL_MS));
      last = now;
    }, SAMPLE_INTERVAL_MS);
    this.window = setInterval(() => {
      const done = samples;
      samples = [];
      onWindow(percentile99(done));
    }, WINDOW_MS);
    this.sampler.unref();
    this.window.unref();
  }

  stop(): void {
    if (this.sampler) clearInterval(this.sampler);
    if (this.window) clearInterval(this.window);
  }
}

function percentile99(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)];
}

/**
 * Publishes the p99 event-loop delay of the latest window (`nodejs_eventloop_lag_p99_ms`). Event-loop lag is the
 * earliest, most honest overload signal for a Node service - CPU % can look fine while every request queues behind a
 * long synchronous task. If sampling cannot start the monitor reports `available() === false` and consumers fail open.
 */
@Injectable()
export class EventLoopMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventLoopMonitor.name);
  private readonly source: LagSource;
  private readonly listeners: ((p99Ms: number) => void)[] = [];
  private lastP99Ms = 0;
  private ok = false;

  constructor(@Optional() @Inject(LAG_SOURCE) source?: LagSource) {
    this.source = source ?? new RealLagSource();
  }

  onModuleInit(): void {
    try {
      const gauge = MetricsRegistry.gauge({
        name: 'nodejs_eventloop_lag_p99_ms',
        help: 'p99 event-loop delay over the last 1s window',
        labels: [],
      });
      this.source.start((p99Ms) => {
        this.lastP99Ms = p99Ms;
        gauge.set(p99Ms);
        for (const listener of this.listeners) listener(p99Ms);
      });
      this.ok = true;
    } catch (error) {
      this.ok = false;
      this.logger.error(
        `event-loop monitor unavailable, load shedding fails open: ${(error as Error).message}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.source.stop();
  }

  /** p99 of the latest window, in ms. */
  p99Ms(): number {
    return this.lastP99Ms;
  }

  available(): boolean {
    return this.ok;
  }

  /** Called with every new window. */
  onWindow(listener: (p99Ms: number) => void): void {
    this.listeners.push(listener);
  }
}
