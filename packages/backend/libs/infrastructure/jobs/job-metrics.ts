import { Histogram, metrics } from '@opentelemetry/api';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * The instruments of FR-052 under the fixed names of contracts/jobs-service.md. Labels are bounded (job type, outcome,
 * schedule name); ids and shops never become labels. `job_duration_ms` is a raw OpenTelemetry histogram because the
 * contract fixes its name and the toolkit registry insists on `_seconds`/`_bytes`/`_ratio` for histograms.
 */
export type JobOutcome =
  'succeeded' | 'retry' | 'dead' | 'timeout' | 'released';

export const jobMetrics = {
  queueLagSeconds: MetricsRegistry.gauge({
    name: 'job_queue_lag_seconds',
    help: 'now - runAt of the oldest due QUEUED job, per type (series without a type label = overall)',
    labels: ['type'],
  }),
  outcomes: MetricsRegistry.counter({
    name: 'job_outcomes_total',
    help: 'Job attempts by outcome (succeeded, retry, dead, timeout, released)',
    labels: ['type', 'outcome'],
  }),
  deadJobs: MetricsRegistry.gauge({
    name: 'job_dead_jobs',
    help: 'Jobs in DEAD status per type',
    labels: ['type'],
  }),
  leaseExpired: MetricsRegistry.counter({
    name: 'job_lease_expired_total',
    help: 'RUNNING jobs found with an expired lease by the reaper',
    labels: ['type'],
  }),
  cronFires: MetricsRegistry.counter({
    name: 'cron_fires_total',
    help: 'Jobs materialised from a schedule',
    labels: ['schedule'],
  }),
  cronFiresSkipped: MetricsRegistry.counter({
    name: 'cron_fires_skipped_total',
    help: 'Schedule fires skipped because the previous job was still active',
    labels: ['schedule'],
  }),
  cronLeader: MetricsRegistry.gauge({
    name: 'cron_leader',
    help: '1 while this instance won the last materialiser tick',
    labels: [],
  }),
  defaultPartitionRows: MetricsRegistry.gauge({
    name: 'job_default_partition_rows',
    help: 'Rows in the catch-all Job partition (maintenance fell behind)',
    labels: [],
  }),
  /** Created on first use, so it binds to the meter provider the process has by then (not the no-op one of import time). */
  recordDuration(ms: number, type: string): void {
    duration ??= metrics
      .getMeter('jobs')
      .createHistogram('job_duration_ms', { unit: 'ms' });
    duration.record(ms, { type });
  },
};

let duration: Histogram | undefined;
