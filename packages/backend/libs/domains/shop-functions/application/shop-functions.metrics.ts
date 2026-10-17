import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of the seller discount functions (S45 FR-033, AS-35/36). Labels are closed sets of outcomes: never a
 * shop, function or product id, never source, test data or a discount message.
 */
export const EVALUATION_OUTCOMES = [
  'applied',
  'no_discount',
  'timeout',
  'memory',
  'runtime',
  'invalid_output',
  'breaker_open',
  'not_entitled',
  'entitlement_unavailable',
  'definitions_unavailable',
  'budget_exceeded',
  'invalid_cart',
] as const;
export type EvaluationOutcome = (typeof EVALUATION_OUTCOMES)[number];
export type JudgeVerdict = 'active' | 'rejected' | 'superseded' | 'unavailable';

const evaluations = MetricsRegistry.counter({
  name: 'shop_functions_evaluations_total',
  help: 'Function evaluations at checkout by outcome',
  labels: ['outcome'],
});
// The platform registry requires a unit suffix on histograms (`_seconds`); the spec names this `..._duration_ms`.
const duration = MetricsRegistry.histogram({
  name: 'shop_functions_evaluation_duration_seconds',
  help: 'Duration of one evaluateDiscounts call',
  labels: [],
  buckets: [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5],
});
const judged = MetricsRegistry.counter({
  name: 'shop_functions_judge_total',
  help: 'Judged versions by verdict',
  labels: ['verdict'],
});
const breakerOpened = MetricsRegistry.counter({
  name: 'shop_functions_breaker_open_total',
  help: 'Times a function breaker opened',
  labels: [],
});
const backlog = MetricsRegistry.gauge({
  name: 'shop_functions_judge_backlog',
  help: 'Versions waiting in QUEUED',
  labels: [],
});
const oldestQueued = MetricsRegistry.gauge({
  name: 'shop_functions_judge_oldest_queued_age_seconds',
  help: 'Age in seconds of the oldest QUEUED version (0 = none)',
  labels: [],
});

const value = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

export const shopFunctionsMetrics = {
  evaluation: (outcome: EvaluationOutcome) => evaluations.add(1, { outcome }),
  evaluationDuration: (ms: number) => duration.record(ms / 1000, {}),
  judge: (verdict: JudgeVerdict) => judged.add(1, { verdict }),
  breakerOpened: () => breakerOpened.add(1, {}),
  backlog: (count: number, oldestSeconds: number) => {
    backlog.set(count, {});
    oldestQueued.set(oldestSeconds, {});
  },
  /** Spec reads. */
  value: {
    evaluation: (outcome: EvaluationOutcome) =>
      value('shop_functions_evaluations_total', { outcome }),
    judge: (verdict: JudgeVerdict) =>
      value('shop_functions_judge_total', { verdict }),
    breakerOpened: () => value('shop_functions_breaker_open_total'),
    backlog: () => value('shop_functions_judge_backlog'),
    oldestQueuedAge: () =>
      value('shop_functions_judge_oldest_queued_age_seconds'),
  },
};
