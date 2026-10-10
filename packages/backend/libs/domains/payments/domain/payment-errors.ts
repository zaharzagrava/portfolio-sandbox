import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * Problem codes of S13 (contracts/http.md). Foreign and missing orders and payments answer the same `404`, so
 * existence cannot be probed (BOLA).
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

export class OrderNotFoundError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'order_not_found',
        'Not found',
        'Order not found.',
      ),
    );
  }
}

export class OrderNotPayableError extends AppError {
  constructor(
    readonly reason: 'order_cancelled' | 'order_paid' | 'hold_expired',
  ) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'order_not_payable',
        'Conflict',
        'The order cannot be paid.',
        { extensions: { reason } },
      ),
    );
  }
}

export class PaymentAlreadyExistsError extends AppError {
  constructor(readonly existingPaymentId: string) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'payment_already_exists',
        'Conflict',
        'This order already has a payment.',
        { extensions: { existingPaymentId } },
      ),
    );
  }
}

export class AmountOutOfRangeError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'amount_out_of_range',
        'Unprocessable Entity',
        'The order total is outside the range that can be paid.',
      ),
    );
  }
}

export class CurrencyUnsupportedError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'currency_unsupported',
        'Unprocessable Entity',
        'The order currency cannot be paid.',
      ),
    );
  }
}

export class PaymentNotFoundError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'payment_not_found',
        'Not found',
        'Payment not found.',
      ),
    );
  }
}

export class InvalidCursorError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.BAD_REQUEST,
        'invalid_cursor',
        'Bad Request',
        'The cursor is not valid.',
      ),
    );
  }
}

const entry = (
  code: string,
  status: number,
  title: string,
  detail: string,
): ProblemCatalogEntry => ({ code, status, title, detail, owner: 'payments' });

/**
 * Registered at module definition so a clash with another owner fails startup. `idempotency_*`, `rate_limited` and
 * `validation_failed` belong to the platform; `invalid_cursor` is shared with orders and not registered here.
 */
export const PAYMENTS_PROBLEMS: ProblemCatalogEntry[] = [
  entry('order_not_found', 404, 'Not found', 'Order not found.'),
  entry('order_not_payable', 409, 'Conflict', 'The order cannot be paid.'),
  entry(
    'payment_already_exists',
    409,
    'Conflict',
    'This order already has a payment.',
  ),
  entry(
    'amount_out_of_range',
    422,
    'Unprocessable Entity',
    'The order total is outside the range that can be paid.',
  ),
  entry(
    'currency_unsupported',
    422,
    'Unprocessable Entity',
    'The order currency cannot be paid.',
  ),
  entry('payment_not_found', 404, 'Not found', 'Payment not found.'),
];
