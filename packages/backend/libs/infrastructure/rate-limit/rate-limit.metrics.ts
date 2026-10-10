import { Injectable } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/** The limiter's instruments (AS-74). Labels are policy names and enumerated values only: never a subject or an address. */
@Injectable()
export class RateLimitMetrics {
  readonly decisions = MetricsRegistry.counter({
    name: 'rate_limit_decisions_total',
    help: 'Rate limit decisions',
    labels: ['policy', 'allowed', 'source', 'reason'],
  });
  readonly duration = MetricsRegistry.histogram({
    name: 'rate_limit_check_duration_seconds',
    help: 'Time to decide a rate limit check',
    labels: ['policy', 'source'],
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  });
  readonly storeUnavailable = MetricsRegistry.counter({
    name: 'rate_limit_store_unavailable_total',
    help: 'Decisions made while the rate limit store was unavailable',
    labels: ['policy', 'fail_mode'],
  });
  readonly breakerState = MetricsRegistry.gauge({
    name: 'rate_limit_breaker_state',
    help: 'Store breaker: 1 while open (or probing), 0 when closed',
    labels: [],
  });
  readonly subjectFallback = MetricsRegistry.counter({
    name: 'rate_limit_subject_fallback_total',
    help: 'Requests counted against the client address for lack of an identity',
    labels: ['policy'],
  });
  readonly penalties = MetricsRegistry.counter({
    name: 'rate_limit_penalties_total',
    help: 'Penalties applied with penalize()',
    labels: ['policy'],
  });
}
