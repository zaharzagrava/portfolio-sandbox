import { AppError, ErrorArea } from '@app/common/errors/error.types';

/**
 * The public API's problem-code catalogue (contracts/http.md). Every error of the capability is an `ApiError` carrying
 * one of these codes; the S54 filter turns it into the problem document, no controller builds an error body.
 */
export const API_ERROR_CATALOGUE = {
  validation_failed: [400, 'Validation failed'],
  malformed_body: [400, 'Malformed body'],
  invalid_version: [400, 'Invalid API version'],
  invalid_cursor: [400, 'Invalid cursor'],
  invalid_expand: [400, 'Invalid expand'],
  invalid_fields: [400, 'Invalid fields'],
  invalid_api_key: [401, 'Invalid API key'],
  insufficient_scope: [403, 'Insufficient scope'],
  shop_suspended: [403, 'Shop suspended'],
  mfa_required: [403, 'Multi-factor authentication required'],
  resource_missing: [404, 'Resource missing'],
  not_found: [404, 'Not found'],
  method_not_allowed: [405, 'Method not allowed'],
  not_acceptable: [406, 'Not acceptable'],
  shop_offboarding: [409, 'Shop offboarding'],
  request_in_progress: [409, 'Request in progress'],
  product_archived: [409, 'Product archived'],
  key_revoked: [409, 'Key revoked'],
  key_expired: [409, 'Key expired'],
  key_already_rotating: [409, 'Key already rotating'],
  endpoint_retired: [410, 'Endpoint retired'],
  version_retired: [410, 'Version retired'],
  endpoint_brownout: [410, 'Endpoint brownout'],
  version_conflict: [412, 'Version conflict'],
  payload_too_large: [413, 'Payload too large'],
  unsupported_media_type: [415, 'Unsupported media type'],
  idempotency_key_required: [422, 'Idempotency-Key required'],
  idempotency_key_reused: [422, 'Idempotency-Key reused'],
  unsupported_operation: [422, 'Unsupported operation'],
  key_limit_reached: [422, 'Key limit reached'],
  rate_limit_cost_exceeded: [422, 'Rate limit cost exceeded'],
  stock_below_zero: [422, 'Stock below zero'],
  operation_conflict: [422, 'Operation id reused'],
  precondition_required: [428, 'Precondition required'],
  rate_limited: [429, 'Rate limited'],
  quota_exceeded: [429, 'Quota exceeded'],
  internal_error: [500, 'Internal error'],
  service_unavailable: [503, 'Service unavailable'],
  rate_limiter_unavailable: [503, 'Rate limiter unavailable'],
  batch_deadline_exceeded: [503, 'Batch deadline exceeded'],
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CATALOGUE;

export interface ApiErrorOptions {
  /** A route may answer a catalogue code with another status (`version_retired` is 410 on a call and 422 on the pin route). */
  status?: number;
  errors?: { field: string; code: string }[];
  retryAfterSeconds?: number;
  retryable?: boolean;
  headers?: Record<string, string>;
  extensions?: Record<string, unknown>;
}

export class ApiError extends AppError {
  declare code: ApiErrorCode;

  constructor(
    code: ApiErrorCode,
    detail?: string,
    options: ApiErrorOptions = {},
  ) {
    const [catalogueStatus, title] = API_ERROR_CATALOGUE[code];
    const status = options.status ?? catalogueStatus;
    super({
      code,
      status,
      title,
      detail: detail ?? title,
      area: status >= 500 ? ErrorArea.TRANSIENT : ErrorArea.DOMAIN,
      retryAfterSeconds: options.retryAfterSeconds,
      headers: options.headers,
      extensions: {
        ...options.extensions,
        ...(options.errors && { errors: options.errors }),
        ...(options.retryable !== undefined && {
          retryable: options.retryable,
        }),
      },
    });
  }
}

export const invalidApiKey = (): ApiError =>
  new ApiError('invalid_api_key', 'The API key is missing or invalid.', {
    headers: { 'WWW-Authenticate': 'Bearer' },
  });

export const insufficientScope = (required: readonly string[]): ApiError =>
  new ApiError(
    'insufficient_scope',
    `This key lacks the required scope: ${required.join(', ')}.`,
    { extensions: { required: [...required] } },
  );

export const resourceMissing = (): ApiError =>
  new ApiError('resource_missing', 'No such resource.');

export const serviceUnavailable = (): ApiError =>
  new ApiError(
    'service_unavailable',
    'The service is temporarily unavailable.',
    {
      retryAfterSeconds: 5,
      retryable: true,
    },
  );

export const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
};
