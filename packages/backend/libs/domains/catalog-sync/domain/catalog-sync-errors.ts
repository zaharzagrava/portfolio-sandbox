import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * Problem codes of the integrations capability (FR-073, contracts/http-api.md). One definition per code; every error
 * of the capability is a `CatalogSyncError` and the platform filter renders the problem document.
 * `invalid_cursor` is the shared platform code (registered by an earlier capability): it is raised here but not
 * registered again.
 */
const DEFINITIONS = {
  invalid_cursor: [
    HttpStatus.BAD_REQUEST,
    'Bad Request',
    'The cursor is not valid for this list.',
  ],
  resync_required: [
    HttpStatus.GONE,
    'Resync required',
    'The cursor is too old for this feed. Pull again without a cursor.',
  ],
  sync_unavailable: [
    HttpStatus.SERVICE_UNAVAILABLE,
    'Sync unavailable',
    'The service is temporarily unavailable. Retry the same request.',
  ],
  invalid_oauth_callback: [
    HttpStatus.BAD_REQUEST,
    'Invalid OAuth callback',
    'The authorisation callback could not be verified.',
  ],
  invalid_integration_transition: [
    HttpStatus.CONFLICT,
    'Invalid integration transition',
    'The integration is not in a state that allows this action.',
  ],
  integration_not_found: [
    HttpStatus.NOT_FOUND,
    'Integration not found',
    'No such integration.',
  ],
  quarantine_not_found: [
    HttpStatus.NOT_FOUND,
    'Quarantine item not found',
    'No such quarantine item.',
  ],
  quarantine_not_open: [
    HttpStatus.CONFLICT,
    'Quarantine item not open',
    'The quarantine item is already closed.',
  ],
  conflict_not_found: [
    HttpStatus.NOT_FOUND,
    'Stock conflict not found',
    'No such stock conflict.',
  ],
  conflict_not_open: [
    HttpStatus.CONFLICT,
    'Stock conflict not open',
    'The stock conflict is already dismissed.',
  ],
  report_not_found: [
    HttpStatus.NOT_FOUND,
    'Report not found',
    'No such reconciliation report.',
  ],
  invalid_webhook_signature: [
    HttpStatus.UNAUTHORIZED,
    'Invalid webhook signature',
    'The webhook could not be verified.',
  ],
  webhook_stale: [
    HttpStatus.UNAUTHORIZED,
    'Webhook too old',
    'The webhook is older than the accepted window.',
  ],
  store_already_connected: [
    HttpStatus.CONFLICT,
    'Store already connected',
    'This store is already connected to a shop.',
  ],
  integration_limit_reached: [
    HttpStatus.CONFLICT,
    'Integration limit reached',
    'The shop already has the maximum number of integrations.',
  ],
  currency_mismatch: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Currency mismatch',
    "The store's currency differs from the platform currency.",
  ],
  invalid_store_url: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Invalid store URL',
    'The store address is not allowed.',
  ],
  provider_credentials_rejected: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Credentials rejected',
    'The store rejected the credentials.',
  ],
  provider_unavailable: [
    HttpStatus.SERVICE_UNAVAILABLE,
    'Provider unavailable',
    'The store did not answer. Try again later.',
  ],
} as const;

export type CatalogSyncProblemCode = keyof typeof DEFINITIONS;

export class CatalogSyncError extends AppError {
  constructor(
    readonly syncCode: CatalogSyncProblemCode,
    options: { detail?: string; retryAfterSeconds?: number } = {},
  ) {
    const [status, title, detail] = DEFINITIONS[syncCode];
    super({
      status,
      code: syncCode,
      title,
      detail: options.detail ?? detail,
      area: Number(status) >= 500 ? ErrorArea.TRANSIENT : ErrorArea.DOMAIN,
      retryAfterSeconds: options.retryAfterSeconds,
    });
  }
}

export const syncProblem = (
  code: CatalogSyncProblemCode,
  options?: { detail?: string; retryAfterSeconds?: number },
) => new CatalogSyncError(code, options);

export const invalidCursor = () => syncProblem('invalid_cursor');

export const CATALOG_SYNC_PROBLEMS: ProblemCatalogEntry[] = (
  Object.keys(DEFINITIONS) as CatalogSyncProblemCode[]
)
  .filter((code) => code !== 'invalid_cursor')
  .map((code) => ({
    code,
    status: DEFINITIONS[code][0],
    title: DEFINITIONS[code][1],
    detail: DEFINITIONS[code][2],
    owner: 'catalog-sync',
  }));
