import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/**
 * Problem codes of S20 (FR-048, contracts/delivery-api.md). Every class carries a stable snake_case `code`; for any 5xx
 * the `detail` is generic and never names the store that failed. No free-text framework exceptions in this capability.
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

const conflict = (
  code: string,
  detail: string,
  extensions?: Record<string, unknown>,
) => problem(HttpStatus.CONFLICT, code, 'Conflict', detail, { extensions });

const notFound = (code: string, detail: string) =>
  problem(HttpStatus.NOT_FOUND, code, 'Not found', detail);

/** `400 validation_failed` naming the offending fields (dotted paths), never their values. */
export class DeliveryValidationError extends AppError {
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

/** A `BUSY` courier or one holding a live offer cannot change profile or shift. */
export class CourierBusyError extends AppError {
  constructor() {
    super(
      conflict(
        'courier_busy',
        'The courier is busy with a delivery or an offer.',
      ),
    );
  }
}

export class CourierProfileRequiredError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.FORBIDDEN,
        'courier_profile_required',
        'Forbidden',
        'Register as a courier first.',
      ),
    );
  }
}

/** Also the answer to every caller who may not know the delivery exists (V.4). */
export class DeliveryNotFoundError extends AppError {
  constructor() {
    super(notFound('delivery_not_found', 'Delivery not found.'));
  }
}

export class OfferNotActiveError extends AppError {
  constructor() {
    super(conflict('offer_not_active', 'The offer is no longer active.'));
  }
}

export class OfferExpiredError extends AppError {
  constructor() {
    super(conflict('offer_expired', 'The offer has expired.'));
  }
}

export class InvalidDeliveryTransitionError extends AppError {
  constructor(
    readonly currentStatus: string,
    readonly command: string,
  ) {
    super(
      conflict(
        'invalid_delivery_transition',
        'The delivery cannot make this move in its current status.',
        { currentStatus, command },
      ),
    );
  }
}

export class OrderNotFoundForDeliveryError extends AppError {
  constructor() {
    super(notFound('order_not_found', 'Order not found.'));
  }
}

export class OrderNotDeliverableError extends AppError {
  constructor() {
    super(conflict('order_not_deliverable', 'The order cannot be delivered.'));
  }
}

export class DeliveryAlreadyOpenError extends AppError {
  constructor() {
    super(
      conflict(
        'delivery_already_open',
        'An open delivery exists for this order and shop.',
      ),
    );
  }
}

export class DeliveryAlreadyCompletedError extends AppError {
  constructor() {
    super(
      conflict(
        'delivery_already_completed',
        'This order was already delivered by this shop.',
      ),
    );
  }
}

export class OpenDeliveryLimitError extends AppError {
  constructor() {
    super(
      conflict(
        'open_delivery_limit',
        'The shop has reached the maximum number of open deliveries.',
      ),
    );
  }
}

export class RouteTooLongError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'route_too_long',
        'Unprocessable entity',
        'Pickup and drop-off are too far apart for same-day delivery.',
      ),
    );
  }
}

export class CityNotServedError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'city_not_served',
        'Unprocessable entity',
        'No courier is registered in this city.',
      ),
    );
  }
}

/** The history message could not be produced; the live position was applied and a resend is safe. */
export class LocationHistoryUnavailableError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.SERVICE_UNAVAILABLE,
        'location_history_unavailable',
        'Service unavailable',
        'The service is temporarily unavailable.',
        { retryAfterSeconds: 5 },
      ),
    );
  }
}

/** A store the request depends on failed or timed out (the live index): generic, retryable, no store named. */
export class DeliveryUnavailableError extends AppError {
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

export class PayloadTooLargeError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'payload_too_large',
        'Payload too large',
        'The request body is too large.',
      ),
    );
  }
}

/** Thrown by pure domain code that was handed a status or command outside the unions (a programming error). */
export class UnknownDeliveryInputError extends Error {
  constructor(what: string, value: unknown) {
    super(`unhandled ${what} ${JSON.stringify(value)}`);
    this.name = 'UnknownDeliveryInputError';
  }
}
