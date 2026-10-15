import type { UsageSummaryDto } from '@marketplace-sandbox/contracts';
import type { UsageSummary } from '../application/usage-read.service';

/** The summary as the contract names it (`usageSummarySchema`): instants as ISO strings, nothing else added. */
export const toUsageSummary = (summary: UsageSummary): UsageSummaryDto => ({
  month: summary.month,
  periodStart: summary.periodStart.toISOString(),
  periodEnd: summary.periodEnd.toISOString(),
  asOf: summary.asOf.toISOString(),
  metrics: summary.metrics.map((m) => ({
    metric: m.metric,
    used: m.used,
    limit: m.limit,
    remaining: m.remaining,
  })),
});
