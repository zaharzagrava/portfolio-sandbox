import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import type { SectionOutcome } from './section-outcome';

const outcomes = () =>
  MetricsRegistry.counter({
    name: 'bff_section_outcomes_total',
    help: 'Product-page section outcomes: ok, skipped or the error code',
    labels: ['section', 'outcome'],
  });
const durations = () =>
  MetricsRegistry.histogram({
    name: 'bff_section_duration_seconds',
    help: 'Product-page section duration',
    labels: ['section'],
    buckets: [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1],
  });

export const outcomeLabel = (o: SectionOutcome): string =>
  o.status === 'error' ? o.failure.code : o.status;

/** One counter increment and one duration per section (S48 FR-052). Labels are bounded: section × outcome. */
export function recordPageMetrics(list: readonly SectionOutcome[]): void {
  for (const o of list) {
    outcomes().add(1, { section: o.name, outcome: outcomeLabel(o) });
    if (o.status !== 'skipped')
      durations().record(o.durationMs / 1000, { section: o.name });
  }
}
