import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';

/**
 * Instruments of `chat` (S24 FR-052). Labels are bounded enumerations only: never a channel, user or message id.
 */
export const PUSH_KINDS = [
  'message',
  'message_deleted',
  'channel_archived',
  'moderation',
  'receipt',
  'presence',
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export const chatPushFailedCounter = MetricsRegistry.counter({
  name: 'chat_push_failed_total',
  help: 'Best-effort live pushes that failed after the commit, by kind',
  labels: ['kind'],
});

export const chatPresenceUnavailableCounter = MetricsRegistry.counter({
  name: 'chat_presence_unavailable_total',
  help: 'Presence store failures (heartbeat, query, offline check)',
  labels: [],
});

export const chatEscalationFailedCounter = MetricsRegistry.counter({
  name: 'chat_escalation_failed_total',
  help: 'Offline escalations that could not be appended and were retried or dead-lettered',
  labels: [],
});

export const chatPartitionMissingCounter = MetricsRegistry.counter({
  name: 'chat_history_partition_missing_total',
  help: 'Messages stored in the default partition because their month had no partition',
  labels: [],
});

export const chatDefaultPartitionRowsGauge = MetricsRegistry.gauge({
  name: 'chat_default_partition_rows',
  help: 'Messages parked in the default partition because their month had no partition (the maintenance job reports it)',
  labels: [],
});

export const chatReceiptsSuppressedCounter = MetricsRegistry.counter({
  name: 'chat_receipts_suppressed_total',
  help: 'Read receipts and presence broadcasts not published because the channel is huge (G-22)',
  labels: ['kind'],
});

export const chatBackfillSkippedCounter = MetricsRegistry.counter({
  name: 'chat_backfill_skipped_total',
  help: 'Channels the shop backfill could not place (their product is gone): left for review, the batch goes on',
  labels: [],
});

export const chatPurgeNoopCounter = MetricsRegistry.counter({
  name: 'chat_purge_noop_total',
  help: 'Shop purges that found nothing left to delete',
  labels: [],
});

export const OFFLINE_CHECK_OUTCOMES = [
  'notified',
  'read',
  'online',
  'deleted',
  'ineligible',
  'coalesced',
] as const;

export const chatOfflineCheckCounter = MetricsRegistry.counter({
  name: 'chat_offline_check_total',
  help: 'Offline checks by outcome (notified, read, online, deleted, ineligible, coalesced)',
  labels: ['outcome'],
});

/**
 * `chat_limiter_unavailable_total` (S50 follow-up) is not a counter of its own: it is derived from the limiter's
 * `rate_limit_store_unavailable_total` by the policy prefix `chat.`. Dashboards and alerts use
 * `sum(rate_limit_store_unavailable_total{policy=~"chat\\..*"})`; specs call this.
 */
export function chatLimiterUnavailable(): number {
  let total = 0;
  for (const labels of MetricsRegistry.labelSets(
    'rate_limit_store_unavailable_total',
  )) {
    if (String(labels.policy ?? '').startsWith('chat.')) {
      total +=
        MetricsRegistry.value('rate_limit_store_unavailable_total', labels) ??
        0;
    }
  }
  return total;
}
