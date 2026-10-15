import {
  CATALOG_SYNC_AGGREGATE_TYPE,
  integrationAttentionRequiredPayloadSchema,
  integrationConnectedPayloadSchema,
  integrationStatusChangedPayloadSchema,
  reconciliationCompletedPayloadSchema,
  stockConflictOpenedPayloadSchema,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * Topic `catalogsync.events`, key `integrationId` (contracts/events-and-messages.md). The spec names the topic
 * `catalog-sync.events` and the types `catalog_sync.*`; the S53 patterns allow neither a `-` in an aggregate type nor a
 * `_` in the first segment of a type, so the registered names are `catalogsync.*` (gaps.md, sibling follow-ups).
 * Integrations are not versioned aggregates: `aggregateVersion` is 0 on every event, no consumer guards on it.
 */
export const CATALOG_SYNC_AGGREGATE = {
  aggregateType: CATALOG_SYNC_AGGREGATE_TYPE,
  retention: 'full-history',
} as const;

export const IntegrationConnected = defineEvent(
  'catalogsync.integration_connected',
  CATALOG_SYNC_AGGREGATE_TYPE,
  1,
  integrationConnectedPayloadSchema,
);

export const IntegrationStatusChanged = defineEvent(
  'catalogsync.integration_status_changed',
  CATALOG_SYNC_AGGREGATE_TYPE,
  1,
  integrationStatusChangedPayloadSchema,
);

export const IntegrationAttentionRequired = defineEvent(
  'catalogsync.integration_attention_required',
  CATALOG_SYNC_AGGREGATE_TYPE,
  1,
  integrationAttentionRequiredPayloadSchema,
);

export const StockConflictOpened = defineEvent(
  'catalogsync.stock_conflict_opened',
  CATALOG_SYNC_AGGREGATE_TYPE,
  1,
  stockConflictOpenedPayloadSchema,
);

export const ReconciliationCompleted = defineEvent(
  'catalogsync.reconciliation_completed',
  CATALOG_SYNC_AGGREGATE_TYPE,
  1,
  reconciliationCompletedPayloadSchema,
);
