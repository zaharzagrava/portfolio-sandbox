import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * HTTP-visible errors of the competitor monitor (specs/domains/S41-competitor-monitor/contracts/api.md). Each is an
 * `AppError` with a stable problem `code` that the global problem+json filter renders; none names a resolved address,
 * resolver message, store or stack in its detail. `product_not_found` and `product_archived` are catalog's,
 * `entitlements_unavailable` billing's, `shop_not_found` / `permission_denied` / `shop_suspended` / `shop_offboarding`
 * tenancy's, `rate_limited` and `validation_failed` the platform's.
 */
type Params = ConstructorParameters<typeof AppError>[0];

export const COMPETITOR_OWNED_ERROR_CODES = [
  'url_not_allowed',
  'url_unresolvable',
  'watch_limit_reached',
  'watch_not_found',
  'history_unavailable',
] as const;
export type CompetitorOwnedErrorCode =
  (typeof COMPETITOR_OWNED_ERROR_CODES)[number];

const DEFINITIONS: Record<
  CompetitorOwnedErrorCode,
  { status: HttpStatus; title: string; detail: string }
> = {
  url_not_allowed: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'This URL cannot be watched.',
  },
  url_unresolvable: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The host of this URL could not be found.',
  },
  watch_limit_reached: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The limit of competitor watches is reached.',
  },
  watch_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'Competitor watch not found.',
  },
  history_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The price history is temporarily unavailable.',
  },
};

export class CompetitorError extends AppError {
  constructor(
    readonly competitorCode: CompetitorOwnedErrorCode,
    extra: Partial<Params> = {},
  ) {
    const d = DEFINITIONS[competitorCode];
    super({
      status: d.status,
      code: competitorCode,
      title: d.title,
      detail: d.detail,
      area:
        competitorCode === 'history_unavailable'
          ? ErrorArea.TRANSIENT
          : ErrorArea.DOMAIN,
      ...extra,
    });
  }
}

export const COMPETITOR_PROBLEMS: ProblemCatalogEntry[] =
  COMPETITOR_OWNED_ERROR_CODES.map((code) => ({
    code,
    status: DEFINITIONS[code].status,
    title: DEFINITIONS[code].title,
    detail: DEFINITIONS[code].detail,
    owner: 'seller-insights',
  }));

export const urlNotAllowed = () => new CompetitorError('url_not_allowed');
export const urlUnresolvable = () => new CompetitorError('url_unresolvable');
export const watchNotFound = () => new CompetitorError('watch_not_found');
export const watchLimitReached = (scope: 'shop' | 'product', limit: number) =>
  new CompetitorError('watch_limit_reached', { extensions: { scope, limit } });
export const historyUnavailable = () =>
  new CompetitorError('history_unavailable', { retryAfterSeconds: 5 });

/** The history store did not answer; the port raises it, the service maps it to `history_unavailable`. */
export class ObservationHistoryUnavailable extends Error {
  constructor(cause?: unknown) {
    super('observation history unavailable', { cause });
    this.name = 'ObservationHistoryUnavailable';
  }
}

/** A field-level validation failure: platform `validation_failed` with the offending fields (never their values). */
export const competitorValidationFailed = (fields: string[]) =>
  new AppError({
    status: HttpStatus.BAD_REQUEST,
    code: 'validation_failed',
    title: 'Bad Request',
    detail: 'The request is not valid.',
    area: ErrorArea.DOMAIN,
    extensions: {
      errors: fields.map((field) => ({ field, code: 'invalid' })),
    },
  });
