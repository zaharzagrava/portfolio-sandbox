import { z } from 'zod';
import {
  integrationProviderSchema,
  integrationStatusSchema,
  STOCK_CONFLICT_KINDS,
  RECONCILIATION_OUTCOMES,
} from './integrations.ts';

/**
 * S08 events, key `integrationId` (contracts/events-and-messages.md). The S53 aggregate-type pattern allows no `-` in a
 * topic name and no `_` in the first segment of a type, so the spec's `catalog-sync.events` / `catalog_sync.*` are
 * `catalogsync.events` / `catalogsync.*` (recorded in the capability's gaps.md).
 */
export const CATALOG_SYNC_AGGREGATE_TYPE = 'catalogsync' as const;
export const CATALOG_SYNC_STATUS_REASONS = [
  'connected',
  'seller',
  'shop_offboarding',
  'offboarding_cancelled',
  'auth_failed',
  'uninstalled',
  'disconnected',
  'reconnected',
] as const;
export const CATALOG_SYNC_ATTENTION_REASONS = [
  'needs_reauth',
  'breaker_open',
  'schema_drift',
  'sync_lag',
  'reconcile_mass_delete',
] as const;

export const integrationConnectedPayloadSchema = z.object({
  integrationId: z.string(),
  shopId: z.string(),
  provider: integrationProviderSchema,
  externalShop: z.string(),
  connectedBy: z.string(),
});
export const integrationStatusChangedPayloadSchema = z.object({
  integrationId: z.string(),
  shopId: z.string(),
  from: integrationStatusSchema,
  to: integrationStatusSchema,
  reason: z.enum(CATALOG_SYNC_STATUS_REASONS),
});
export const integrationAttentionRequiredPayloadSchema = z.object({
  integrationId: z.string(),
  shopId: z.string(),
  reason: z.enum(CATALOG_SYNC_ATTENTION_REASONS),
  detail: z.string(),
});
export const stockConflictOpenedPayloadSchema = z.object({
  conflictId: z.string(),
  integrationId: z.string(),
  shopId: z.string(),
  productId: z.string(),
  kind: z.enum(STOCK_CONFLICT_KINDS),
  base: z.number().int(),
  local: z.number().int(),
  remote: z.number().int(),
  resolvedTo: z.number().int(),
});
export const reconciliationCompletedPayloadSchema = z.object({
  integrationId: z.string(),
  shopId: z.string(),
  runId: z.string(),
  outcome: z.enum(RECONCILIATION_OUTCOMES),
  counts: z.record(z.string(), z.number().int()),
});

/** The S53 envelope narrowed to this topic. */
const envelope = {
  eventId: z.string(),
  version: z.literal(1),
  aggregateType: z.literal(CATALOG_SYNC_AGGREGATE_TYPE),
  occurredAt: z.string(),
  aggregateId: z.string(),
  aggregateVersion: z.number().int().min(0),
};
const eventOf = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ ...envelope, type: z.literal(type), payload });

export const integrationEventSchemas = {
  'catalogsync.integration_connected': eventOf(
    'catalogsync.integration_connected',
    integrationConnectedPayloadSchema,
  ),
  'catalogsync.integration_status_changed': eventOf(
    'catalogsync.integration_status_changed',
    integrationStatusChangedPayloadSchema,
  ),
  'catalogsync.integration_attention_required': eventOf(
    'catalogsync.integration_attention_required',
    integrationAttentionRequiredPayloadSchema,
  ),
  'catalogsync.stock_conflict_opened': eventOf(
    'catalogsync.stock_conflict_opened',
    stockConflictOpenedPayloadSchema,
  ),
  'catalogsync.reconciliation_completed': eventOf(
    'catalogsync.reconciliation_completed',
    reconciliationCompletedPayloadSchema,
  ),
} as const;

export type IntegrationEventType = keyof typeof integrationEventSchemas;
