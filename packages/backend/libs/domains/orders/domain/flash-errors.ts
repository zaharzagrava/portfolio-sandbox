import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/**
 * Problem codes of S11 (contracts/http.md). Same idiom as `order-errors.ts`: a stable snake_case `code`, the status
 * mapped by the platform exception filter, `Retry-After` from `retryAfterSeconds`. A foreign sale answers the same
 * `404` as a missing one so existence cannot be probed (BOLA).
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

/** Admission held the request back; `retryAfterSeconds` is 1..3 (random, so a crowd does not return in step). */
export class FlashSaleBusyError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    readonly flashSaleId?: string,
  ) {
    super(
      domainError(
        HttpStatus.TOO_MANY_REQUESTS,
        'flash_sale_busy',
        'Too Many Requests',
        'The sale is very busy right now; retry shortly.',
        {
          area: ErrorArea.TRANSIENT,
          retryAfterSeconds,
          extensions: { flashSaleId },
        },
      ),
    );
  }
}

/** The fast store did not answer in time: fail closed, nothing was reserved. */
export class FlashSaleUnavailableError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'flash_sale_unavailable',
        'Service Unavailable',
        'The sale is temporarily unavailable; retry.',
        { area: ErrorArea.TRANSIENT, retryAfterSeconds: 2 },
      ),
    );
  }
}

export class FlashSaleLimitExceededError extends AppError {
  constructor(
    readonly limit: number,
    readonly flashSaleId?: string,
  ) {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'flash_sale_limit_exceeded',
        'Unprocessable Entity',
        `At most ${limit} units per buyer in this sale.`,
        { extensions: { limit, flashSaleId } },
      ),
    );
  }
}

export class FlashSaleNotFoundError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'flash_sale_not_found',
        'Not found',
        'Flash sale not found.',
      ),
    );
  }
}

export class FlashSaleOverlapError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'flash_sale_overlap',
        'Conflict',
        'Another sale of this product overlaps the window.',
      ),
    );
  }
}

export class FlashSaleNotCancellableError extends AppError {
  constructor(readonly currentStatus?: string) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'flash_sale_not_cancellable',
        'Conflict',
        'The sale can no longer be cancelled.',
        { extensions: { currentStatus } },
      ),
    );
  }
}

/** The sale asks for more units than the product holds now. */
export class InsufficientStockError extends AppError {
  constructor(readonly available: number) {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'insufficient_stock',
        'Unprocessable Entity',
        'The product does not have that many units.',
        { extensions: { available } },
      ),
    );
  }
}

export class DropPriceAboveRegularError extends AppError {
  constructor(readonly regularPriceMinor: number) {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'drop_price_above_regular',
        'Unprocessable Entity',
        'The drop price must not be above the regular price.',
        { extensions: { regularPriceMinor } },
      ),
    );
  }
}

/** A field-level validation failure (platform `validation_failed`): names the fields, never their values. */
export class FlashValidationError extends AppError {
  constructor(fields: string[]) {
    super(
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
  }
}
