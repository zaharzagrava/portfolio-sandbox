import { AppError, ErrorArea } from '@app/common/errors/error.types';

/**
 * Problem codes of the webhook dashboard API (S43 FR-050, contracts/http.md; `WEBHOOK_ERROR_CODES` of the contract package
 * lists the same names). Every error of the capability is a `WebhookError` or an `ApiError` (`validation_failed`, the
 * idempotency codes): the platform filter turns it into problem+json with `code` and `requestId`, no controller builds an
 * error body. A cross-shop id and an unknown id are the same `404` (FR-009).
 */
export const WEBHOOK_ERROR_CATALOGUE = {
  webhook_endpoint_not_found: [404, 'Webhook endpoint not found'],
  webhook_event_not_found: [404, 'Webhook event not found'],
  duplicate_endpoint_url: [409, 'Duplicate endpoint URL'],
  endpoint_state_conflict: [409, 'Endpoint state conflict'],
  rotation_in_progress: [409, 'Rotation in progress'],
  no_previous_secret: [409, 'No previous secret'],
  endpoint_disabled: [409, 'Endpoint disabled'],
  endpoint_url_rejected: [422, 'Endpoint URL rejected'],
  endpoint_limit_reached: [422, 'Endpoint limit reached'],
  invalid_cursor: [400, 'Invalid cursor'],
  service_unavailable: [503, 'Service unavailable'],
} as const;

export type WebhookErrorCodeName = keyof typeof WEBHOOK_ERROR_CATALOGUE;

export class WebhookError extends AppError {
  declare code: WebhookErrorCodeName;

  constructor(
    code: WebhookErrorCodeName,
    detail?: string,
    options: {
      details?: Record<string, unknown>;
      retryAfterSeconds?: number;
    } = {},
  ) {
    const [status, title] = WEBHOOK_ERROR_CATALOGUE[code];
    super({
      code,
      status,
      title,
      detail: detail ?? title,
      area: status >= 500 ? ErrorArea.TRANSIENT : ErrorArea.DOMAIN,
      extensions: options.details ? { details: options.details } : undefined,
      retryAfterSeconds: options.retryAfterSeconds,
    });
  }
}

export const endpointNotFound = (): WebhookError =>
  new WebhookError('webhook_endpoint_not_found', 'No such webhook endpoint.');

export const endpointUrlRejected = (reason: string): WebhookError =>
  new WebhookError(
    'endpoint_url_rejected',
    'This address cannot receive webhooks.',
    { details: { reason } },
  );

export const endpointStateConflict = (status: string): WebhookError =>
  new WebhookError(
    'endpoint_state_conflict',
    `The endpoint is already ${status}.`,
    { details: { status } },
  );

/** Unknown, expired, and another endpoint's event are one answer (FR-009, AS-61, AS-64). */
export const eventNotFound = (): WebhookError =>
  new WebhookError('webhook_event_not_found', 'No such webhook event.');

export const endpointDisabled = (): WebhookError =>
  new WebhookError(
    'endpoint_disabled',
    'The endpoint is disabled; enable it first.',
  );

export const serviceUnavailable = (): WebhookError =>
  new WebhookError(
    'service_unavailable',
    'The webhook service cannot take this request now; try again shortly.',
    { retryAfterSeconds: 1 },
  );
