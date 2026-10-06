import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { monitorEventLoopDelay, IntervalHistogram } from 'node:perf_hooks';
import { metrics } from '@opentelemetry/api';

/**
 * Samples event-loop delay continuously and publishes the p99 of the last
 * window. Event-loop lag is the earliest, most honest overload signal for a
 * Node service - CPU % can look fine while every request queues behind a
 * long synchronous task.
 */
@Injectable()
export class EventLoopMonitor implements OnModuleInit, OnModuleDestroy {
  private histogram?: IntervalHistogram;
  private timer?: NodeJS.Timeout;
  private lastP99Ms = 0;

  onModuleInit() {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();

    const gauge = metrics.getMeter('platform').createObservableGauge('nodejs_eventloop_lag_p99_ms', {
      description: 'p99 event-loop delay over the last 1s window',
    });
    gauge.addCallback((result) => result.observe(this.lastP99Ms));

    this.timer = setInterval(() => {
      this.lastP99Ms = this.histogram!.percentile(99) / 1e6;
      this.histogram!.reset();
    }, 1_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.histogram?.disable();
    if (this.timer) clearInterval(this.timer);
  }

  p99Ms(): number {
    return this.lastP99Ms;
  }
}
