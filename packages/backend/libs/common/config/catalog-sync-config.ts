import * as joi from 'joi';
import { ConfigRules, type RuleCheck } from './config-rules';

/**
 * Validated settings of the `catalog-sync` integrations (S08 T005, A34). The Shopify app credentials, the pinned API
 * version and the cursor key are required: a missing or invalid value fails startup naming the key. Run budgets and
 * breaker thresholds are optional; unset keys take the defaults of `resolveCatalogSyncSettings`.
 */
export interface CatalogSyncConfig {
  shopify_app_key: string;
  shopify_app_secret: string;
  /** Pinned Shopify Admin API version, `YYYY-MM`. */
  shopify_api_version: string;
  /** HMAC key of the opaque keyset cursors; at least 32 bytes, distinct from every other secret. */
  integration_cursor_key: string;
  /** Pages one sync run may fetch (default 40; tests set 3). */
  integration_sync_max_pages?: number;
  /** Wall-clock budget of an incremental run (default 4 min). */
  integration_incremental_budget_ms?: number;
  /** Wall-clock budget of a backfill run (default 12 min). */
  integration_backfill_budget_ms?: number;
  /** Consecutive provider failures that open the breaker (default 5). */
  integration_breaker_failures?: number;
  /** How long the breaker stays open (default 5 min). */
  integration_breaker_open_ms?: number;
  /** S09 offline sync numbers (defaults in the capability's `domain/sync-config.ts`); all optional. */
  offline_sync_max_ops?: number;
  offline_sync_body_limit_bytes?: number;
  offline_sync_push_budget_ms?: number;
  offline_sync_claim_lease_ms?: number;
  offline_sync_recovery_after_ms?: number;
  offline_sync_clock_drift_ms?: number;
  offline_sync_max_op_age_ms?: number;
  offline_sync_retention_ms?: number;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: any) => any;
};

const required = (name: string): Key => ({
  name,
  verify: joi.string().trim().min(1).required(),
});

const positiveInt = (name: string): Key => ({
  name,
  verify: joi.number().integer().min(1).optional().empty(''),
  postProcess: (v: string) => (v ? Number(v) : undefined),
});

const OTHER_SECRETS = [
  'jwt_secret',
  'share_link_code_key',
  'share_link_edge_secret',
  'cart_cookie_secret',
  'notification_secret',
  'ledger_cursor_secret',
  'payments_cursor_secret',
  'discussions_cursor_secret',
  'revalidate_secret',
  'ads_click_secret',
  'api_key_pepper',
  'widget_token_key',
  'shopify_app_secret',
];

/** The cursor key is its own secret: at least 32 bytes and different from every other configured secret. */
export const integrationCursorKeyRule: RuleCheck = (ctx) => {
  const value = ctx.get('integration_cursor_key');
  if (value === undefined || value === null || value === '') return [];
  const found: string[] = [];
  if (
    Buffer.byteLength(
      typeof value === 'string' ? value : JSON.stringify(value),
    ) < 32
  )
    found.push('integration_cursor_key must be at least 32 bytes');
  for (const other of OTHER_SECRETS)
    if (ctx.get(other) === value)
      found.push(`integration_cursor_key must differ from ${other}`);
  return found;
};

ConfigRules.register({
  owner: 'catalog-sync',
  keys: ['integration_cursor_key', ...OTHER_SECRETS],
  validate: integrationCursorKeyRule,
});

export const catalogSyncConfigKeys: Record<keyof CatalogSyncConfig, Key> = {
  shopify_app_key: required('SHOPIFY_APP_KEY'),
  shopify_app_secret: required('SHOPIFY_APP_SECRET'),
  shopify_api_version: {
    name: 'SHOPIFY_API_VERSION',
    verify: joi
      .string()
      .pattern(/^\d{4}-(01|04|07|10)$/)
      .required(),
  },
  integration_cursor_key: required('INTEGRATION_CURSOR_KEY'),
  integration_sync_max_pages: positiveInt('INTEGRATION_SYNC_MAX_PAGES'),
  integration_incremental_budget_ms: positiveInt(
    'INTEGRATION_INCREMENTAL_BUDGET_MS',
  ),
  integration_backfill_budget_ms: positiveInt('INTEGRATION_BACKFILL_BUDGET_MS'),
  integration_breaker_failures: positiveInt('INTEGRATION_BREAKER_FAILURES'),
  integration_breaker_open_ms: positiveInt('INTEGRATION_BREAKER_OPEN_MS'),
  offline_sync_max_ops: positiveInt('OFFLINE_SYNC_MAX_OPS'),
  offline_sync_body_limit_bytes: positiveInt('OFFLINE_SYNC_BODY_LIMIT_BYTES'),
  offline_sync_push_budget_ms: positiveInt('OFFLINE_SYNC_PUSH_BUDGET_MS'),
  offline_sync_claim_lease_ms: positiveInt('OFFLINE_SYNC_CLAIM_LEASE_MS'),
  offline_sync_recovery_after_ms: positiveInt('OFFLINE_SYNC_RECOVERY_AFTER_MS'),
  offline_sync_clock_drift_ms: positiveInt('OFFLINE_SYNC_CLOCK_DRIFT_MS'),
  offline_sync_max_op_age_ms: positiveInt('OFFLINE_SYNC_MAX_OP_AGE_MS'),
  offline_sync_retention_ms: positiveInt('OFFLINE_SYNC_RETENTION_MS'),
};

export interface CatalogSyncSettings {
  shopifyAppKey: string;
  shopifyAppSecret: string;
  shopifyApiVersion: string;
  cursorKey: string;
  maxPagesPerRun: number;
  incrementalBudgetMs: number;
  backfillBudgetMs: number;
  breakerFailures: number;
  breakerOpenMs: number;
}

/** Applies the defaults (40 pages, 4 min incremental, 12 min backfill, 5 failures, 5 min open) to a config reader. */
export function resolveCatalogSyncSettings(
  get: <K extends keyof CatalogSyncConfig>(key: K) => CatalogSyncConfig[K],
): CatalogSyncSettings {
  return {
    shopifyAppKey: get('shopify_app_key'),
    shopifyAppSecret: get('shopify_app_secret'),
    shopifyApiVersion: get('shopify_api_version'),
    cursorKey: get('integration_cursor_key'),
    maxPagesPerRun: get('integration_sync_max_pages') ?? 40,
    incrementalBudgetMs: get('integration_incremental_budget_ms') ?? 4 * 60_000,
    backfillBudgetMs: get('integration_backfill_budget_ms') ?? 12 * 60_000,
    breakerFailures: get('integration_breaker_failures') ?? 5,
    breakerOpenMs: get('integration_breaker_open_ms') ?? 5 * 60_000,
  };
}
