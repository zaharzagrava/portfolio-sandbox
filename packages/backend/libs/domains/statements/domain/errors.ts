import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * HTTP-visible errors of the statements (specs/domains/S16-seller-statements/contracts/http.md). Each is an `AppError`
 * with a stable problem `code`; none echoes SQL, a store name or a stack. `validation_failed` and `invalid_cursor`
 * are raised with the platform's wording and are not registered again.
 */
type Params = ConstructorParameters<typeof AppError>[0];

const domainError = (
  status: HttpStatus,
  code: string,
  title: string,
  detail: string,
  extra: Partial<Params> = {},
): Params => ({
  status,
  code,
  title,
  detail,
  area: ErrorArea.DOMAIN,
  ...extra,
});

const withDetails = (details: Record<string, unknown>): Partial<Params> => ({
  extensions: { details },
});

export const validationFailed = (fields: string[]) =>
  new AppError(
    domainError(
      HttpStatus.BAD_REQUEST,
      'validation_failed',
      'Bad Request',
      'The request is not valid.',
      {
        extensions: {
          errors: fields.map((field) => ({ field, code: 'invalid' })),
        },
      },
    ),
  );

export const invalidCursor = () =>
  new AppError(
    domainError(
      HttpStatus.BAD_REQUEST,
      'invalid_cursor',
      'Bad Request',
      'The cursor is not valid for this list.',
    ),
  );

export const permissionDenied = () =>
  new AppError(
    domainError(
      HttpStatus.FORBIDDEN,
      'permission_denied',
      'Forbidden',
      'You do not have permission to do this.',
    ),
  );

export const rateRangeInvalid = () =>
  new AppError(
    domainError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'rate_range_invalid',
      'Unprocessable Entity',
      'The validity range is empty: validTo must be after validFrom.',
    ),
  );

export const defaultRateGap = () =>
  new AppError(
    domainError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'default_rate_gap',
      'Unprocessable Entity',
      'The default rate for all categories must cover all time.',
    ),
  );

/** Same definition as tenancy's: a shop that tenancy does not know. */
export const shopNotFound = () =>
  new AppError(
    domainError(
      HttpStatus.NOT_FOUND,
      'shop_not_found',
      'Not found',
      'Shop not found.',
    ),
  );

export const monthNotAvailable = () =>
  new AppError(
    domainError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'month_not_available',
      'Unprocessable Entity',
      'The month is outside the range that statements cover.',
    ),
  );

export const knownAtInFuture = () =>
  new AppError(
    domainError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'known_at_in_future',
      'Unprocessable Entity',
      'knownAt must not be in the future.',
    ),
  );

export const periodNotEnded = () =>
  new AppError(
    domainError(
      HttpStatus.CONFLICT,
      'period_not_ended',
      'Conflict',
      'The month has not ended yet.',
    ),
  );

export const periodNotReady = (stream: string, watermark: string | null) =>
  new AppError(
    domainError(
      HttpStatus.CONFLICT,
      'period_not_ready',
      'Conflict',
      'The facts of the month are not complete yet.',
      withDetails({ stream, watermark }),
    ),
  );

export const previousPeriodOpen = (month: string) =>
  new AppError(
    domainError(
      HttpStatus.CONFLICT,
      'previous_period_open',
      'Conflict',
      'The previous month is not closed yet.',
      withDetails({ month }),
    ),
  );

export const periodClosed = () =>
  new AppError(
    domainError(
      HttpStatus.CONFLICT,
      'period_closed',
      'Conflict',
      'The month is already closed.',
    ),
  );

export const periodClosing = () =>
  new AppError(
    domainError(
      HttpStatus.CONFLICT,
      'period_closing',
      'Conflict',
      'The month is being closed.',
    ),
  );

const entry = (
  code: string,
  status: number,
  title: string,
  detail: string,
): ProblemCatalogEntry => ({ code, status, title, detail, owner: 'statements' });

export const STATEMENTS_PROBLEMS: ProblemCatalogEntry[] = [
  entry(
    'rate_range_invalid',
    422,
    'Unprocessable Entity',
    'The validity range is empty: validTo must be after validFrom.',
  ),
  entry(
    'default_rate_gap',
    422,
    'Unprocessable Entity',
    'The default rate for all categories must cover all time.',
  ),
  entry('shop_not_found', 404, 'Not found', 'Shop not found.'),
  entry(
    'month_not_available',
    422,
    'Unprocessable Entity',
    'The month is outside the range that statements cover.',
  ),
  entry(
    'known_at_in_future',
    422,
    'Unprocessable Entity',
    'knownAt must not be in the future.',
  ),
  entry('period_not_ended', 409, 'Conflict', 'The month has not ended yet.'),
  entry(
    'period_not_ready',
    409,
    'Conflict',
    'The facts of the month are not complete yet.',
  ),
  entry(
    'previous_period_open',
    409,
    'Conflict',
    'The previous month is not closed yet.',
  ),
  entry('period_closed', 409, 'Conflict', 'The month is already closed.'),
  entry('period_closing', 409, 'Conflict', 'The month is being closed.'),
];

/** `CommissionRateQueryService.getRatesAsOf` was given more queries than one batch allows (R1 contract). */
export class TooManyQueriesError extends Error {
  constructor(readonly max: number) {
    super(`at most ${max} queries per call`);
    this.name = 'TooManyQueriesError';
  }
}

/** A close run that cannot succeed (a job-level outcome, never an HTTP problem). */
export class CloseRunFailed extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'CloseRunFailed';
  }
}
