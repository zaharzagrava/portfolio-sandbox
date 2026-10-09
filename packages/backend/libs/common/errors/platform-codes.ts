/** Problem `code` values owned by the platform toolkit (S54). Domain codes live in their own domains. */
export const PlatformCodes = {
  validation_failed: 'validation_failed',
  malformed_body: 'malformed_body',
  payload_too_large: 'payload_too_large',
  unsupported_media_type: 'unsupported_media_type',
  not_found: 'not_found',
  method_not_allowed: 'method_not_allowed',
  unauthenticated: 'unauthenticated',
  forbidden: 'forbidden',
  conflict: 'conflict',
  internal_error: 'internal_error',
  service_overloaded: 'service_overloaded',
  database_timeout: 'database_timeout',
  db_lock_timeout: 'db_lock_timeout',
  transaction_conflict: 'transaction_conflict',
  database_unavailable: 'database_unavailable',
  idempotency_key_required: 'idempotency_key_required',
  idempotency_key_invalid: 'idempotency_key_invalid',
  idempotency_key_reuse: 'idempotency_key_reuse',
  idempotency_in_flight: 'idempotency_in_flight',
  idempotency_replay_unavailable: 'idempotency_replay_unavailable',
  idempotency_unavailable: 'idempotency_unavailable',
} as const;

export type PlatformCode = (typeof PlatformCodes)[keyof typeof PlatformCodes];
