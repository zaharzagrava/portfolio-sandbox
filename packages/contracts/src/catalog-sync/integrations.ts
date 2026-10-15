import { z } from 'zod';

/** S08 HTTP contract (specs/domains/S08-integrations/contracts/http-api.md). */

export const INTEGRATION_PROVIDERS = ['shopify', 'woocommerce'] as const;
export const integrationProviderSchema = z.enum(INTEGRATION_PROVIDERS);

export const INTEGRATION_STATUSES = [
  'ACTIVE',
  'PAUSED',
  'NEEDS_REAUTH',
  'DISCONNECTED',
] as const;
export const integrationStatusSchema = z.enum(INTEGRATION_STATUSES);

export const INTEGRATION_PAUSED_REASONS = ['seller', 'shop_offboarding'] as const;

const isoDate = z.string();

/** `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`, case-insensitive (the server lower-cases it); no scheme, port, path or user-info. */
export const SHOPIFY_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/i;
export const integrationInstallRequestSchema = z
  .object({
    shopDomain: z.string().min(1).max(255).regex(SHOPIFY_DOMAIN_PATTERN),
  })
  .strict();
export const integrationInstallResponseSchema = z.object({
  authorizeUrl: z.string(),
  expiresAt: isoDate,
});

export const wooConnectRequestSchema = z
  .object({
    provider: z.literal('woocommerce'),
    storeUrl: z.string().min(1).max(2048),
    consumerKey: z.string().min(1).max(255),
    consumerSecret: z.string().min(1).max(255),
  })
  .strict();

export const integrationSchema = z.object({
  id: z.string(),
  provider: integrationProviderSchema,
  externalShop: z.string(),
  status: integrationStatusSchema,
  pausedReason: z.enum(INTEGRATION_PAUSED_REASONS).nullable(),
  lastError: z.string().nullable(),
  lastSyncAt: isoDate.nullable(),
  watermark: isoDate.nullable(),
  lagSeconds: z.number().int().nonnegative().nullable(),
  linkedProducts: z.number().int().nonnegative(),
  openQuarantine: z.number().int().nonnegative(),
  openConflicts: z.number().int().nonnegative(),
  breakerOpenUntil: isoDate.nullable(),
  credentialsSet: z.boolean(),
  createdAt: isoDate,
});

export const integrationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});

const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const integrationPageSchema = pageOf(integrationSchema);

export const integrationSyncRequestSchema = z
  .object({ mode: z.enum(['incremental', 'backfill']) })
  .strict();
export const integrationSyncResponseSchema = z.object({
  enqueued: z.boolean(),
  reason: z.literal('breaker_open').optional(),
});
export const integrationReconcileResponseSchema = z.object({
  enqueued: z.boolean(),
});

/** Quarantine. */
export const QUARANTINE_STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;
export const QUARANTINE_RESOLUTIONS = [
  'fixed_at_provider',
  'dismissed',
  'expired',
] as const;

export const quarantineItemSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  entity: z.string(),
  externalId: z.string().nullable(),
  reasonCode: z.string(),
  message: z.string().max(500),
  payload: z.unknown(),
  status: z.enum(QUARANTINE_STATUSES),
  occurrences: z.number().int().positive(),
  firstSeenAt: isoDate,
  lastSeenAt: isoDate,
  resolution: z.enum(QUARANTINE_RESOLUTIONS).nullable(),
  resolvedAt: isoDate.nullable(),
});
export const quarantineListQuerySchema = integrationListQuerySchema.extend({
  status: z.enum(QUARANTINE_STATUSES).optional(),
});
export const quarantinePageSchema = pageOf(quarantineItemSchema);
export const quarantineRetryResponseSchema = z.object({
  outcome: z.enum(['resolved', 'still_invalid']),
  item: quarantineItemSchema,
});

/** Stock conflicts. */
export const STOCK_CONFLICT_KINDS = ['oversold', 'quantity_limit'] as const;
export const STOCK_CONFLICT_STATUSES = ['OPEN', 'DISMISSED'] as const;

export const stockConflictSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  externalId: z.string(),
  productId: z.string(),
  kind: z.enum(STOCK_CONFLICT_KINDS),
  base: z.number().int(),
  local: z.number().int(),
  remote: z.number().int(),
  merged: z.number().int(),
  resolvedTo: z.number().int(),
  status: z.enum(STOCK_CONFLICT_STATUSES),
  createdAt: isoDate,
  dismissedAt: isoDate.nullable(),
});
export const conflictListQuerySchema = integrationListQuerySchema.extend({
  status: z.enum(STOCK_CONFLICT_STATUSES).optional(),
});
export const conflictPageSchema = pageOf(stockConflictSchema);

/** Reconciliation. */
export const RECONCILIATION_OUTCOMES = [
  'completed',
  'aborted_mass_delete',
  'failed',
] as const;
export const RECONCILIATION_FINDING_KINDS = [
  'matched',
  'missing_at_provider',
  'missing_locally',
  'content_drift',
  'stock_drift',
  'list_inconsistent',
] as const;

export const reconciliationFindingSchema = z.object({
  kind: z.enum(RECONCILIATION_FINDING_KINDS),
  externalId: z.string().nullable(),
  detail: z.string().optional(),
  /** A finding carried over from the earlier run it was first reported in, with what became of it (AS-64). */
  previousRunId: z.string().optional(),
  outcome: z.enum(['fixed', 'still_open']).optional(),
});
export const reconciliationCountsSchema = z.record(z.string(), z.number().int());

export const reconciliationSummarySchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  startedAt: isoDate,
  finishedAt: isoDate.nullable(),
  outcome: z.enum(RECONCILIATION_OUTCOMES).nullable(),
  counts: reconciliationCountsSchema,
});
export const reconciliationReportSchema = reconciliationSummarySchema.extend({
  findings: z.array(reconciliationFindingSchema).max(1000),
  truncated: z.boolean(),
  previousRunId: z.string().nullable(),
});
export const reconciliationPageSchema = pageOf(reconciliationSummarySchema);

export type IntegrationInstallRequest = z.infer<typeof integrationInstallRequestSchema>;
export type IntegrationInstallResponse = z.infer<typeof integrationInstallResponseSchema>;
export type WooConnectRequest = z.infer<typeof wooConnectRequestSchema>;
export type Integration = z.infer<typeof integrationSchema>;
export type IntegrationPage = z.infer<typeof integrationPageSchema>;
export type IntegrationSyncRequest = z.infer<typeof integrationSyncRequestSchema>;
export type QuarantineItem = z.infer<typeof quarantineItemSchema>;
export type QuarantinePage = z.infer<typeof quarantinePageSchema>;
export type StockConflict = z.infer<typeof stockConflictSchema>;
export type ConflictPage = z.infer<typeof conflictPageSchema>;
export type ReconciliationReport = z.infer<typeof reconciliationReportSchema>;
export type ReconciliationPage = z.infer<typeof reconciliationPageSchema>;
