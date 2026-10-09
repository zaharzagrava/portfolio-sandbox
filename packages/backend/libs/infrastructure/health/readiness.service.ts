import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { StartupService } from './startup.service';

export interface ReadinessCheck {
  name: string;
  /**
   * `pod`: depends only on this process (warm-up done, local resources); failing it fails readiness at once.
   * `shared`: depends on something every instance shares (database, cache, a third party); it is reported but never
   * fails readiness, because a shared outage would otherwise pull the whole fleet out of the load balancer at once.
   * Default: `shared`.
   */
  scope?: 'pod' | 'shared';
  /** A shared check promoted to critical fails readiness after `failureThreshold` consecutive failures. */
  critical?: boolean;
  failureThreshold?: number;
  /** Per-check deadline; the signal is aborted when it passes. Default 500 ms. */
  timeoutMs?: number;
  check: (signal: AbortSignal) => Promise<void>;
}

export interface ReadinessReport {
  ready: boolean;
  shuttingDown: boolean;
  /** Names and `up`/`down` only: failure messages go to the log, never to the probe caller. */
  checks: Record<string, 'up' | 'down'>;
}

const CACHE_TTL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_THRESHOLD = 3;

const readyGauge = () =>
  MetricsRegistry.gauge({
    name: 'platform_ready',
    help: '1 when /health/ready would answer 200, else 0',
    labels: [],
  });
const checkGauge = () =>
  MetricsRegistry.gauge({
    name: 'health_check_up',
    help: '1 when the readiness check last passed',
    labels: ['check'],
  });

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);
  private readonly checks: ReadinessCheck[] = [];
  private readonly failures = new Map<string, number>();
  private shuttingDown = false;
  private cached?: {
    at: number;
    report: Omit<ReadinessReport, 'shuttingDown'>;
  };
  private inFlight?: Promise<Omit<ReadinessReport, 'shuttingDown'>>;
  private readonly clock: Clock;

  constructor(
    @Optional() @Inject(CLOCK) clock?: Clock,
    @Optional() private readonly startup?: StartupService,
  ) {
    this.clock = clock ?? new SystemClock();
  }

  register(check: ReadinessCheck): void {
    this.checks.push(check);
    this.cached = undefined;
  }

  /** Called first on SIGTERM so the LB stops routing new requests here while in-flight ones drain. */
  markShuttingDown(): void {
    this.shuttingDown = true;
    readyGauge().set(0);
  }

  /** Test seam. */
  resetShuttingDown(): void {
    this.shuttingDown = false;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async report(): Promise<ReadinessReport> {
    // Shutdown and warm-up are in-process facts: never served from the cache.
    if (this.shuttingDown) {
      readyGauge().set(0);
      return {
        ready: false,
        shuttingDown: true,
        checks: this.cached?.report.checks ?? {},
      };
    }
    const evaluated = await this.evaluateCached();
    const started = this.startup ? this.startup.isStarted() : true;
    const ready = started && evaluated.ready;
    readyGauge().set(ready ? 1 : 0);
    return { ready, shuttingDown: false, checks: evaluated.checks };
  }

  private evaluateCached(): Promise<Omit<ReadinessReport, 'shuttingDown'>> {
    const now = this.clock.nowMs();
    if (this.cached && now - this.cached.at < CACHE_TTL_MS)
      return Promise.resolve(this.cached.report);
    // Single flight: concurrent probes share one evaluation.
    this.inFlight ??= this.evaluate().then(
      (report) => {
        this.cached = { at: this.clock.nowMs(), report };
        this.inFlight = undefined;
        return report;
      },
      (error) => {
        this.inFlight = undefined;
        throw error;
      },
    );
    return this.inFlight;
  }

  private async evaluate(): Promise<Omit<ReadinessReport, 'shuttingDown'>> {
    const results = await Promise.all(
      this.checks.map(async (c) => {
        const ok = await this.runOne(c);
        const failures = ok ? 0 : (this.failures.get(c.name) ?? 0) + 1;
        this.failures.set(c.name, failures);
        const scope = c.scope ?? 'shared';
        const blocking =
          !ok &&
          (scope === 'pod' ||
            (c.critical === true &&
              failures >= (c.failureThreshold ?? DEFAULT_THRESHOLD)));
        return { name: c.name, ok, blocking };
      }),
    );
    const up = checkGauge();
    for (const r of results) up.set(r.ok ? 1 : 0, { check: r.name });
    return {
      ready: results.every((r) => !r.blocking),
      checks: Object.fromEntries(
        results.map((r) => [r.name, r.ok ? 'up' : 'down']),
      ),
    };
  }

  private async runOne(c: ReadinessCheck): Promise<boolean> {
    const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => c.check(controller.signal)), // also catches a synchronous throw
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`timeout after ${timeoutMs}ms`);
            controller.abort(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
      return true;
    } catch (error) {
      this.logger.warn(
        `readiness check "${c.name}" failed: ${(error as Error).message}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
