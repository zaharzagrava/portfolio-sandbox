import { Logger } from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of offline sync (FR-039, AS-51). Labels are closed sets (operation type and status); ids go to logs, and
 * no log line or label ever carries a product title, a description or a request body.
 */
export const offlineOpsCounter = MetricsRegistry.counter({
  name: 'catalog_sync_offline_ops_total',
  help: 'Offline sync operations by type and status',
  labels: ['type', 'status'],
});

export const offlinePushDuration = MetricsRegistry.histogram({
  name: 'catalog_sync_offline_push_duration_seconds',
  help: 'Duration of one offline sync push request',
  labels: [],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20],
});

export const offlineFeedLagGauge = MetricsRegistry.gauge({
  name: 'catalog_sync_offline_feed_lag_seconds',
  help: 'Age of the product event last applied to the offline feed, or of the oldest unprocessed one',
  labels: [],
});

export const offlineConflictsOpenGauge = MetricsRegistry.gauge({
  name: 'catalog_sync_offline_conflicts_open',
  help: 'Open offline sync conflicts over all shops, at the last evaluation',
  labels: [],
});

export const offlineOpsInFlightGauge = MetricsRegistry.gauge({
  name: 'catalog_sync_offline_ops_in_flight',
  help: 'Offline sync operations claimed and not finished, at the last evaluation',
  labels: [],
});

export const OFFLINE_METRIC_NAMES = [
  'catalog_sync_offline_ops_total',
  'catalog_sync_offline_push_duration_seconds',
  'catalog_sync_offline_feed_lag_seconds',
  'catalog_sync_offline_conflicts_open',
  'catalog_sync_offline_ops_in_flight',
] as const;

const logger = new Logger('OfflineSync');

export interface OpLogLine {
  requestId?: string;
  shopId: string;
  deviceId: string;
  opId: string | null;
  type: string;
  status: string;
  code?: string;
  durationMs: number;
}

/** One structured line per operation: identifiers, outcome and duration only. */
export function logOperation(line: OpLogLine): void {
  logger.log({ action: 'catalog-sync.offline_op', ...line });
}

export function logPush(line: {
  requestId?: string;
  shopId: string;
  deviceId: string;
  ops: number;
  durationMs: number;
}): void {
  logger.log({ action: 'catalog-sync.offline_push', ...line });
}
