import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * The seven series of S04 AS-66 through the S54 registry (names and bounded labels are checked at registration). No shop,
 * document or user identifier is ever a label; those belong in logs and traces.
 */
export const onboardingMetrics = {
  /** Applications submitted, verified and rejected (J02 AS-32); one count per decision event appended. */
  applicationDecisions: MetricsRegistry.counter({
    name: 'onboarding_decisions_total',
    help: 'Onboarding application decisions by decision (submitted, verified, rejected)',
    labels: ['decision'],
  }),
  outcomes: MetricsRegistry.counter({
    name: 'kyc_extraction_outcomes_total',
    help: 'Extraction attempts by document kind, attempt number and outcome',
    labels: ['kind', 'attempt', 'outcome'],
  }),
  corrections: MetricsRegistry.counter({
    name: 'kyc_field_corrections_total',
    help: 'Fields a reviewer changed, by document kind and field',
    labels: ['kind', 'field'],
  }),
  decisions: MetricsRegistry.counter({
    name: 'kyc_review_decisions_total',
    help: 'Review decisions by document kind and decision',
    labels: ['kind', 'decision'],
  }),
  duration: MetricsRegistry.histogram({
    name: 'kyc_extraction_duration_seconds',
    help: 'Wall time of one extraction run by document kind and outcome',
    labels: ['kind', 'outcome'],
    buckets: [1, 2, 5, 10, 20, 45, 90, 180],
  }),
  tokens: MetricsRegistry.counter({
    name: 'kyc_llm_tokens_total',
    help: 'Model tokens used for extraction by model and direction (input, output)',
    labels: ['model', 'direction'],
  }),
  failures: MetricsRegistry.counter({
    name: 'kyc_extraction_failures_total',
    help: 'Documents that could not be read by the pipeline, by reason',
    labels: ['reason'],
  }),
  queueOldestAge: MetricsRegistry.gauge({
    name: 'kyc_review_queue_oldest_age_seconds',
    help: 'Age of the oldest open review task (0 when the queue is empty)',
    labels: [],
  }),
};
