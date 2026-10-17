import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * HTTP-visible errors of seller insights (specs/domains/S40-leaderboards-dashboard/contracts/http-and-events.md). Each is
 * an `AppError` with a stable problem `code` rendered by the global problem+json filter; none names a store, host,
 * command or stack in its detail (FR-044). `validation_failed`, `shop_not_found`, `rate_limited` and
 * `service_unavailable` belong to the platform, S03, S50 and the capabilities that registered them first.
 */
type Params = ConstructorParameters<typeof AppError>[0];

export const INSIGHTS_OWNED_ERROR_CODES = [
  'not_ranked',
  'period_in_future',
] as const;
export type InsightsOwnedErrorCode =
  (typeof INSIGHTS_OWNED_ERROR_CODES)[number];

const DEFINITIONS: Record<
  InsightsOwnedErrorCode,
  { status: HttpStatus; title: string; detail: string }
> = {
  not_ranked: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'The shop has no ranking on this board.',
  },
  period_in_future: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The period has not started yet.',
  },
};

export class InsightsError extends AppError {
  constructor(
    readonly insightsCode: InsightsOwnedErrorCode,
    extra: Partial<Params> = {},
  ) {
    const d = DEFINITIONS[insightsCode];
    super({
      status: d.status,
      code: insightsCode,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...extra,
    });
  }
}

export const INSIGHTS_PROBLEMS: ProblemCatalogEntry[] =
  INSIGHTS_OWNED_ERROR_CODES.map((code) => ({
    code,
    status: DEFINITIONS[code].status,
    title: DEFINITIONS[code].title,
    detail: DEFINITIONS[code].detail,
    owner: 'seller-insights',
  }));

export const notRanked = () => new InsightsError('not_ranked');
export const periodInFuture = (periodId: string) =>
  new InsightsError('period_in_future', { extensions: { periodId } });

const RETRY_AFTER_SECONDS = 5;

/** A store did not answer: a generic detail, `Retry-After: 5`, no host, command or stack. */
export const insightsUnavailable = () =>
  new AppError({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code: 'service_unavailable',
    title: 'Service Unavailable',
    detail: 'The service is temporarily unavailable. Retry shortly.',
    area: ErrorArea.TRANSIENT,
    retryAfterSeconds: RETRY_AFTER_SECONDS,
  });

/** A field-level validation failure: platform `validation_failed` with the offending fields (never their values). */
export const insightsValidationFailed = (fields: string[]) =>
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
