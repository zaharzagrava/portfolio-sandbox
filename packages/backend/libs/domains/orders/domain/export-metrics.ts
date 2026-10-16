import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Counters and histograms of the order export (S12 FR-037, AS-58). Labels are closed sets (final status, failure
 * code); an export or a shop id is a log field, never a label (S54 FR-080).
 */
export const exportFinishedCounter = MetricsRegistry.counter({
  name: 'order_export_finished_total',
  help: 'Order exports by final status (DONE, FAILED, CANCELLED)',
  labels: ['status'],
});

export const exportLinesCounter = MetricsRegistry.counter({
  name: 'order_export_lines_total',
  help: 'Order lines written to finished exports',
  labels: [],
});

export const exportBytesCounter = MetricsRegistry.counter({
  name: 'order_export_bytes_total',
  help: 'Bytes written to finished exports',
  labels: [],
});

export const exportDurationHistogram = MetricsRegistry.histogram({
  name: 'order_export_duration_seconds',
  help: 'Duration of an export run that ended in a final status (DONE or FAILED), from claim to its end',
  labels: [],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200],
});

export const exportQueueWaitHistogram = MetricsRegistry.histogram({
  name: 'order_export_queue_wait_seconds',
  help: 'Time an export waited in the queue before a worker claimed it',
  labels: [],
  buckets: [1, 5, 15, 30, 60, 120, 300, 900, 3600],
});

export const exportRetriesCounter = MetricsRegistry.counter({
  name: 'order_export_retries_total',
  help: 'Exports returned to the queue after a transient failure, by failure code',
  labels: ['code'],
});

export const exportDownloadsCounter = MetricsRegistry.counter({
  name: 'order_export_downloads_total',
  help: 'Download links issued for finished exports',
  labels: [],
});
