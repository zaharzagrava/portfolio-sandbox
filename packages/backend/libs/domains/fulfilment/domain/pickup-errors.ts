import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/**
 * Problem codes of S19 (contracts/pickup-api.md). Every class carries a stable snake_case `code`; for any 5xx the
 * `detail` is generic and never names the store or the engine that failed (FR-051).
 */
const problem = (
  status: HttpStatus,
  code: string,
  title: string,
  detail: string,
  extra: {
    extensions?: Record<string, unknown>;
    retryAfterSeconds?: number;
  } = {},
) =>
  ({
    status,
    code,
    title,
    detail,
    area: ErrorArea.DOMAIN,
    ...extra,
  }) as ConstructorParameters<typeof AppError>[0];

/** `400 validation_failed` naming the offending fields, never their values. */
export class PickupValidationError extends AppError {
  constructor(readonly fields: string[]) {
    super(
      problem(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'Bad request',
        'The request is not valid.',
        {
          extensions: {
            errors: fields.map((field) => ({ field, code: 'invalid' })),
          },
        },
      ),
    );
  }
}

export class PickupPointNotFoundError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.NOT_FOUND,
        'pickup_point_not_found',
        'Not found',
        'Pickup point not found.',
      ),
    );
  }
}

export class ProductNotFoundError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.NOT_FOUND,
        'product_not_found',
        'Not found',
        'Product not found.',
      ),
    );
  }
}

export class PickupPointInactiveError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.CONFLICT,
        'pickup_point_inactive',
        'Conflict',
        'The pickup point is not active.',
      ),
    );
  }
}

export class PickupPointLimitReachedError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.CONFLICT,
        'pickup_point_limit_reached',
        'Conflict',
        'The shop has reached the maximum number of pickup points.',
      ),
    );
  }
}

export class StockVersionConflictError extends AppError {
  constructor(readonly currentVersion: number) {
    super(
      problem(
        HttpStatus.CONFLICT,
        'stock_version_conflict',
        'Conflict',
        'The stock was changed by someone else; reload it and retry.',
        { extensions: { currentVersion } },
      ),
    );
  }
}

export class InsufficientPickupStockError extends AppError {
  constructor(readonly available: number) {
    super(
      problem(
        HttpStatus.CONFLICT,
        'insufficient_pickup_stock',
        'Conflict',
        'The pickup point does not hold enough stock for this change.',
        { extensions: { available } },
      ),
    );
  }
}

export class StockLimitExceededError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.CONFLICT,
        'stock_limit_exceeded',
        'Conflict',
        'The change would push the stock above the maximum.',
      ),
    );
  }
}

/** Thrown by `PickupAvailabilityService.checkAvailability` for a malformed request (R1 caller error, no HTTP route). */
export class InvalidAvailabilityRequestError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.BAD_REQUEST,
        'invalid_availability_request',
        'Bad request',
        'The availability request is not valid.',
      ),
    );
  }
}

/** The search index is unreachable or over its 800 ms budget: no fallback to the exact store. */
export class SearchUnavailableError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.SERVICE_UNAVAILABLE,
        'search_unavailable',
        'Service unavailable',
        'Search is temporarily unavailable.',
        { retryAfterSeconds: 5 },
      ),
    );
  }
}

/** The exact store ran over its statement limit or failed. */
export class ServiceUnavailableError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.SERVICE_UNAVAILABLE,
        'service_unavailable',
        'Service unavailable',
        'The service is temporarily unavailable.',
        { retryAfterSeconds: 5 },
      ),
    );
  }
}
