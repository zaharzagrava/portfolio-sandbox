import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/**
 * The problem documents this capability answers with (contracts/http.md). Details are generic on purpose: no field
 * name, upstream message, URL or identifier (V.3). The global filter renders them as RFC 9457 with `requestId`.
 */
const CATALOG = {
  validation_failed: [400, 'Bad Request', 'The request is not valid.'],
  ambiguous_credentials: [
    400,
    'Bad Request',
    'Send either the session cookie or an Authorization header, not both.',
  ],
  origin_not_allowed: [403, 'Forbidden', 'The request origin is not allowed.'],
  csrf_invalid: [403, 'Forbidden', 'The CSRF token is missing or invalid.'],
  mfa_not_pending: [
    409,
    'Conflict',
    'There is no pending second-factor challenge.',
  ],
  unauthenticated: [401, 'Unauthorized', 'No valid session.'],
  session_expired: [
    401,
    'Unauthorized',
    'The session has ended. Sign in again.',
  ],
  invalid_token: [401, 'Unauthorized', 'The credential was rejected.'],
  not_found: [404, 'Not Found', 'The resource was not found.'],
  upstream_invalid: [
    502,
    'Bad Gateway',
    'A service answered with an unusable response.',
  ],
  bad_gateway: [502, 'Bad Gateway', 'The service could not be reached.'],
  upstream_unavailable: [
    503,
    'Service Unavailable',
    'A required service is unavailable. Retry shortly.',
  ],
  overloaded: [
    503,
    'Service Unavailable',
    'The service is busy. Retry shortly.',
  ],
  session_unavailable: [
    503,
    'Service Unavailable',
    'The session could not be loaded right now. Retry shortly.',
  ],
  persisted_query_required: [
    400,
    'Bad Request',
    'Only registered documents are accepted.',
  ],
  persisted_query_mismatch: [
    400,
    'Bad Request',
    'The document does not match its hash.',
  ],
  batching_not_supported: [
    400,
    'Bad Request',
    'Send one operation per request.',
  ],
  payload_too_large: [413, 'Payload Too Large', 'The request is too large.'],
  unsupported_media_type: [
    415,
    'Unsupported Media Type',
    'Send application/json.',
  ],
} as const satisfies Record<string, readonly [number, string, string]>;

export type BffProblemCode = keyof typeof CATALOG;

export class BffProblem extends AppError {
  constructor(
    code: BffProblemCode,
    options: {
      retryAfterSeconds?: number;
      headers?: Record<string, string>;
      /** Machine-readable members for clients (never free text from an upstream). */
      extensions?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    const [status, title, detail] = CATALOG[code];
    super({
      code,
      status: status as HttpStatus,
      title,
      detail,
      area: status >= 500 ? ErrorArea.TRANSIENT : ErrorArea.DOMAIN,
      retryAfterSeconds: options.retryAfterSeconds,
      headers: { 'Cache-Control': 'no-store', ...options.headers },
      extensions: options.extensions,
      causes: options.cause instanceof Error ? [options.cause] : [],
    });
  }
}
