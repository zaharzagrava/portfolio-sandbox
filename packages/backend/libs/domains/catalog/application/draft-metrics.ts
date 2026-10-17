import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CLOSE } from '../domain/close-codes';

/**
 * Instruments of the collaborative editor (S06 AS-54). Labels are bounded outcomes only (`reason`, `code`, `outcome`,
 * `operation`): never a draft, shop or user id (the registry refuses those labels); ids go to the structured logs.
 */
export const collabRoomsGauge = MetricsRegistry.gauge({
  name: 'collab_rooms_open',
  help: 'Rooms loaded on this instance',
  labels: [],
});

export const collabConnectionsGauge = MetricsRegistry.gauge({
  name: 'collab_connections_open',
  help: 'Editing connections open on this instance',
  labels: [],
});

export const collabRingGauge = MetricsRegistry.gauge({
  name: 'collab_ring_size',
  help: 'Editing instances in the ring as this process sees it',
  labels: [],
});

export const collabUpdateCounter = MetricsRegistry.counter({
  name: 'collab_updates_total',
  help: 'Document updates received by result (accepted, denied, duplicate_or_held, too_large)',
  labels: ['result'],
});

export const collabDeniedWriteCounter = MetricsRegistry.counter({
  name: 'collab_denied_writes_total',
  help: 'Writes refused by reason (read_only, frozen)',
  labels: ['reason'],
});

export const collabFlushSeconds = MetricsRegistry.histogram({
  name: 'collab_flush_seconds',
  help: 'Seconds to persist one batch of updates',
  labels: [],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
});

export const collabBroadcastSeconds = MetricsRegistry.histogram({
  name: 'collab_broadcast_seconds',
  help: 'Seconds to fan one update out to the other editors of a room',
  labels: [],
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1],
});

export const collabCloseCounter = MetricsRegistry.counter({
  name: 'collab_closes_total',
  help: 'Connections closed by the server by close code',
  labels: ['code'],
});

export const collabSequenceConflictCounter = MetricsRegistry.counter({
  name: 'collab_sequence_conflicts_total',
  help: 'Log writes that found their sequence number held by another writer',
  labels: [],
});

export const collabStoreErrorCounter = MetricsRegistry.counter({
  name: 'collab_store_errors_total',
  help: 'Store calls that failed or timed out by operation (flush, compact, load)',
  labels: ['operation'],
});

export const collabSnapshotReadCounter = MetricsRegistry.counter({
  name: 'collab_snapshot_reads_total',
  help: 'Room loads that read a snapshot and the log',
  labels: [],
});

export const draftPublishCounter = MetricsRegistry.counter({
  name: 'drafts_publish_total',
  help: 'Publish attempts by outcome (published, unchanged, conflict, invalid, failed, unavailable)',
  labels: ['outcome'],
});

export const draftVersionUnavailableCounter = MetricsRegistry.counter({
  name: 'drafts_version_unavailable_total',
  help: 'Version reads that failed because the snapshot could not be read',
  labels: [],
});

export const draftJobCounter = MetricsRegistry.counter({
  name: 'drafts_job_total',
  help: 'Rows handled by the draft jobs by kind (stale_lease_released, superseded_deleted, orphan_deleted)',
  labels: ['kind'],
});

/** Series every instance exposes from the start, so a dashboard sees zeros instead of gaps (S06 AS-54). */
export function initDraftMetrics(): void {
  collabRoomsGauge.set(0);
  collabConnectionsGauge.set(0);
  collabRingGauge.set(0);
  collabSequenceConflictCounter.add(0);
  collabSnapshotReadCounter.add(0);
  collabVersionZero();
  for (const close of Object.values(CLOSE))
    collabCloseCounter.add(0, { code: `${close.code}` });
  for (const result of ['accepted', 'denied', 'duplicate_or_held', 'too_large'])
    collabUpdateCounter.add(0, { result });
  for (const reason of ['read_only', 'frozen'])
    collabDeniedWriteCounter.add(0, { reason });
  for (const outcome of [
    'published',
    'unchanged',
    'conflict',
    'invalid',
    'failed',
    'unavailable',
  ])
    draftPublishCounter.add(0, { outcome });
}

function collabVersionZero(): void {
  draftVersionUnavailableCounter.add(0);
}
