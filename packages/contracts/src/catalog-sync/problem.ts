/** S08 problem codes (specs/domains/S08-integrations FR-073, contracts/http-api.md). */
export const CATALOG_SYNC_PROBLEM_CODES = [
  'invalid_oauth_callback',
  'invalid_integration_transition',
  'integration_not_found',
  'quarantine_not_found',
  'quarantine_not_open',
  'conflict_not_found',
  'conflict_not_open',
  'report_not_found',
  'invalid_cursor',
  'invalid_webhook_signature',
  'webhook_stale',
  'store_already_connected',
  'integration_limit_reached',
  'currency_mismatch',
  'invalid_store_url',
  'provider_credentials_rejected',
  'provider_unavailable',
  // S09 offline sync (`validation_failed`, `payload_too_large` and `invalid_cursor` are platform codes).
  'resync_required',
  'sync_unavailable',
] as const;
export type CatalogSyncProblemCode = (typeof CATALOG_SYNC_PROBLEM_CODES)[number];
