import { z } from 'zod';

/**
 * S42 problem-code catalogue of the public API and its dashboard routes (specs/domains/S42-public-api/contracts/http.md).
 * The backend keeps the same list with each code's status; a unit spec compares the two.
 */
export const PUBLIC_API_ERROR_CODES = [
  'validation_failed',
  'malformed_body',
  'invalid_version',
  'invalid_cursor',
  'invalid_expand',
  'invalid_fields',
  'invalid_api_key',
  'insufficient_scope',
  'shop_suspended',
  'mfa_required',
  'resource_missing',
  'not_found',
  'method_not_allowed',
  'not_acceptable',
  'shop_offboarding',
  'request_in_progress',
  'product_archived',
  'key_revoked',
  'key_expired',
  'key_already_rotating',
  'endpoint_retired',
  'version_retired',
  'endpoint_brownout',
  'version_conflict',
  'payload_too_large',
  'unsupported_media_type',
  'idempotency_key_required',
  'idempotency_key_reused',
  'unsupported_operation',
  'key_limit_reached',
  'rate_limit_cost_exceeded',
  'stock_below_zero',
  'operation_conflict',
  'precondition_required',
  'rate_limited',
  'quota_exceeded',
  'internal_error',
  'service_unavailable',
  'rate_limiter_unavailable',
  'batch_deadline_exceeded',
] as const;

export const publicApiErrorCodeSchema = z.enum(PUBLIC_API_ERROR_CODES);
export type PublicApiErrorCode = z.infer<typeof publicApiErrorCodeSchema>;

/** Problem document of every error answer (RFC 9457), with the members the public API adds. */
export const publicApiProblemSchema = z.looseObject({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string(),
  requestId: z.string().min(1),
  code: z.string(),
  errors: z
    .array(z.object({ field: z.string(), code: z.string() }))
    .optional(),
  retryable: z.boolean().optional(),
});
export type PublicApiProblem = z.infer<typeof publicApiProblemSchema>;
