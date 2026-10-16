import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Counters and histograms of the bulk import (S07 D-24, AS-68). Labels are closed sets (outcome, final status, failure
 * code); an import or a shop id is a log field, never a label (S54 FR-080).
 */
export const importMetrics = {
  rows: MetricsRegistry.counter({
    name: 'catalog_import_rows_total',
    help: 'Rows of imports by outcome (created, updated, unchanged, failed)',
    labels: ['outcome'],
  }),
  finished: MetricsRegistry.counter({
    name: 'catalog_import_finished_total',
    help: 'Imports by final status (DONE, FAILED, CANCELLED, EXPIRED)',
    labels: ['status'],
  }),
  batchSeconds: MetricsRegistry.histogram({
    name: 'catalog_import_batch_seconds',
    help: 'Time to write one batch of rows through the catalog and commit its checkpoint',
    labels: [],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  }),
  scanSeconds: MetricsRegistry.histogram({
    name: 'catalog_import_scan_seconds',
    help: 'Time the malware scan of an import took',
    labels: [],
    buckets: [0.5, 1, 5, 15, 60, 300, 900, 1800],
  }),
  bytesRead: MetricsRegistry.counter({
    name: 'catalog_import_bytes_read_total',
    help: 'Bytes of import files read by the pipeline',
    labels: [],
  }),
  queueToStartSeconds: MetricsRegistry.histogram({
    name: 'catalog_import_queue_to_start_seconds',
    help: 'Time from the completed upload to the start of the run',
    labels: [],
    buckets: [1, 5, 15, 60, 300, 900, 3600],
  }),
  checkpointAgeSeconds: MetricsRegistry.gauge({
    name: 'catalog_import_checkpoint_age_seconds',
    help: 'Age of the oldest checkpoint of a running import (0 when none runs); a stalled worker shows here',
    labels: [],
  }),
  deliveries: MetricsRegistry.counter({
    name: 'catalog_import_deliveries_total',
    help: 'Queue deliveries of imports by result (ran, held, busy, final, retry)',
    labels: ['result'],
  }),
};
