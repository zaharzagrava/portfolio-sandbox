import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { OrderStatus } from './order-state';

/**
 * Problem codes of S10 (contracts/http.md). Every class carries a stable snake_case `code`. Foreign and missing
 * orders answer the same `404` so existence cannot be probed (BOLA).
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

export class PriceChangedError extends AppError {
  constructor(
    readonly currentTotalMinor: number,
    readonly lines: Array<{ productId: string; unitPriceMinor: number }>,
  ) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'price_changed',
        'Conflict',
        'The total changed since you last saw it.',
        { extensions: { currentTotalMinor, lines } },
      ),
    );
  }
}

export class CartEmptyError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'cart_empty',
        'Unprocessable Entity',
        'The cart is empty.',
      ),
    );
  }
}

export class CartLineLimitError extends AppError {
  constructor(readonly limit: number) {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'cart_line_limit',
        'Unprocessable Entity',
        `A cart holds at most ${limit} different products.`,
        { extensions: { limit } },
      ),
    );
  }
}

export class ProductUnavailableError extends AppError {
  constructor(readonly productIds: string[]) {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'product_unavailable',
        'Unprocessable Entity',
        'Some products in the cart cannot be bought.',
        { extensions: { productIds } },
      ),
    );
  }
}

export class MixedCurrencyError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'mixed_currency',
        'Unprocessable Entity',
        'The cart mixes currencies.',
      ),
    );
  }
}

/** Final per key: the idempotency facility stores and replays it. */
export class OutOfStockError extends AppError {
  constructor(readonly productIds: string[]) {
    super(
      domainError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'out_of_stock',
        'Unprocessable Entity',
        'Some products are out of stock.',
        { extensions: { productIds }, idempotencyFinal: true },
      ),
    );
  }
}

export class CheckoutInProgressError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'checkout_in_progress',
        'Conflict',
        'Another checkout of yours is running.',
        { retryAfterSeconds: 1 },
      ),
    );
  }
}

export class CheckoutUnavailableError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'checkout_unavailable',
        'Service Unavailable',
        'Checkout is temporarily unavailable; retry.',
        { area: ErrorArea.TRANSIENT, retryAfterSeconds: 2 },
      ),
    );
  }
}

export class CartUnavailableError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'cart_unavailable',
        'Service Unavailable',
        'The cart is temporarily unavailable; retry.',
        { area: ErrorArea.TRANSIENT, retryAfterSeconds: 1 },
      ),
    );
  }
}

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

export class OrderNotCancellableError extends AppError {
  constructor(readonly currentStatus: OrderStatus) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'order_not_cancellable',
        'Conflict',
        'The order can no longer be cancelled.',
        { extensions: { currentStatus } },
      ),
    );
  }
}

export class OrderNotPayableError extends AppError {
  constructor(
    readonly orderId: string,
    readonly orderStatus: OrderStatus,
    readonly reason: 'order_not_reserved' | 'hold_expired',
  ) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        reason,
        'Conflict',
        'The order cannot be paid.',
        { extensions: { orderId, orderStatus } },
      ),
    );
  }
}

export class InvalidOrderTransitionError extends AppError {
  constructor(
    readonly orderId: string,
    readonly currentStatus: OrderStatus,
    readonly command: string,
  ) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'invalid_order_transition',
        'Conflict',
        'The order is not in a state that allows this change.',
        { extensions: { orderId, currentStatus, command } },
      ),
    );
  }
}

export class TooManyIdsError extends AppError {
  constructor(readonly limit: number) {
    super(
      domainError(
        HttpStatus.BAD_REQUEST,
        'too_many_ids',
        'Bad Request',
        `At most ${limit} ids per call.`,
        { extensions: { limit } },
      ),
    );
  }
}

export class InvalidSignatureError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.BAD_REQUEST,
        'invalid_signature',
        'Bad Request',
        'The webhook signature is invalid.',
      ),
    );
  }
}

export class InvalidPayloadError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.BAD_REQUEST,
        'invalid_payload',
        'Bad Request',
        'The webhook payload is not valid.',
      ),
    );
  }
}

export class PayloadTooLargeError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'payload_too_large',
        'Payload Too Large',
        'The webhook body is too large.',
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

/** A collaborator did not answer in time or failed: the outcome of the call is unknown (retry or recovery decides). */
export class UpstreamUnavailableError extends Error {
  constructor(
    readonly upstream: 'catalog' | 'stock' | 'shops' | 'discounts' | 'payments',
  ) {
    super(`${upstream} did not answer`);
    this.name = 'UpstreamUnavailableError';
  }
}

/** Retryable: the payments capability could not confirm a payment. */
export class PaymentStatusUnavailableError extends Error {
  constructor(message = 'payment status is not available') {
    super(message);
    this.name = 'PaymentStatusUnavailableError';
  }
}
