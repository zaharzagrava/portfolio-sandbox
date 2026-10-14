import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { AuctionStatus } from './auction-state';

/**
 * Problem codes of S21 (contracts/http.md). One class per stable snake_case `code`; the platform exception filter
 * renders problem+json from `AppError`, so controllers never branch on errors (II.1, A13). A foreign auction answers
 * the same `404` as a missing one so existence cannot be probed (BOLA).
 */
type Params = ConstructorParameters<typeof AppError>[0];

const problem = (
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

const unprocessable = (
  code: string,
  detail: string,
  extensions?: Record<string, unknown>,
) =>
  problem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    code,
    'Unprocessable Entity',
    detail,
    {
      extensions,
    },
  );
const conflict = (
  code: string,
  detail: string,
  extensions?: Record<string, unknown>,
) => problem(HttpStatus.CONFLICT, code, 'Conflict', detail, { extensions });
const notFound = (code: string, detail: string) =>
  problem(HttpStatus.NOT_FOUND, code, 'Not Found', detail);

export class BidTooLowError extends AppError {
  constructor(readonly minimumMaxAmountMinor: number) {
    super(
      unprocessable(
        'bid_too_low',
        'The maximum is below the minimum allowed bid.',
        {
          minimumMaxAmountMinor,
        },
      ),
    );
  }
}

export class BidNotIncreasingError extends AppError {
  constructor(readonly currentMaxAmountMinor: number) {
    super(
      unprocessable(
        'bid_not_increasing',
        'A new maximum must be above your current maximum.',
        { currentMaxAmountMinor },
      ),
    );
  }
}

export class AuctionClosedError extends AppError {
  constructor(readonly auctionStatus: AuctionStatus) {
    super(
      // `status` is the problem document's own HTTP status member (RFC 7807): the auction's goes by another name
      conflict('auction_closed', 'The auction is not accepting bids.', {
        auctionStatus,
      }),
    );
  }
}

export class AuctionNotStartedError extends AppError {
  constructor(readonly startsAt: Date) {
    super(
      conflict('auction_not_started', 'The auction has not started.', {
        startsAt: startsAt.toISOString(),
      }),
    );
  }
}

export class ShillBidForbiddenError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.FORBIDDEN,
        'shill_bid_forbidden',
        'Forbidden',
        'Members of the selling shop cannot bid.',
      ),
    );
  }
}

/** A check that must not be skipped could not be made (tenancy, limiter store): fail closed. */
export class BidUnavailableError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.SERVICE_UNAVAILABLE,
        'bid_unavailable',
        'Service Unavailable',
        'Bidding is temporarily unavailable; retry.',
        { area: ErrorArea.TRANSIENT, retryAfterSeconds: 2 },
      ),
    );
  }
}

/** `400 validation_failed` naming the offending fields, never their values. */
export class AuctionValidationError extends AppError {
  constructor(fields: string[]) {
    super(
      problem(
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

export class InvalidCursorError extends AppError {
  constructor() {
    super(
      problem(
        HttpStatus.BAD_REQUEST,
        'invalid_cursor',
        'Bad Request',
        'The cursor is not valid.',
      ),
    );
  }
}

export class AuctionNotFoundError extends AppError {
  constructor() {
    super(notFound('auction_not_found', 'Auction not found.'));
  }
}

export class ProductNotFoundError extends AppError {
  constructor() {
    super(notFound('product_not_found', 'Product not found.'));
  }
}

export class AuctionExistsForProductError extends AppError {
  constructor() {
    super(
      conflict(
        'auction_exists_for_product',
        'The product already has a live auction.',
      ),
    );
  }
}

export class AuctionHasBidsError extends AppError {
  constructor() {
    super(
      conflict('auction_has_bids', 'An auction with bids cannot be cancelled.'),
    );
  }
}

export class AuctionNotCancellableError extends AppError {
  constructor(readonly auctionStatus: AuctionStatus) {
    super(
      conflict(
        'auction_not_cancellable',
        'The auction can no longer be cancelled.',
        {
          auctionStatus,
        },
      ),
    );
  }
}

export class ReserveBelowStartingError extends AppError {
  constructor() {
    super(
      unprocessable(
        'reserve_below_starting',
        'The reserve price must be at least the starting price.',
      ),
    );
  }
}

export class StartsTooSoonError extends AppError {
  constructor() {
    super(unprocessable('starts_too_soon', 'The auction must start later.'));
  }
}

export class DurationOutOfRangeError extends AppError {
  constructor() {
    super(
      unprocessable(
        'duration_out_of_range',
        'The auction must last between 10 minutes and 30 days.',
      ),
    );
  }
}

export class ProductUnavailableError extends AppError {
  constructor() {
    super(
      unprocessable('product_unavailable', 'The product cannot be auctioned.'),
    );
  }
}

export class InsufficientStockError extends AppError {
  constructor() {
    super(
      unprocessable(
        'insufficient_stock',
        'There is no unit in stock to auction.',
      ),
    );
  }
}

/** A collaborator (catalog, stock, orders) did not answer in time: the outcome is unknown, the caller retries. */
export class UpstreamUnavailableError extends AppError {
  constructor(readonly upstream: string) {
    super(
      problem(
        HttpStatus.SERVICE_UNAVAILABLE,
        'upstream_unavailable',
        'Service Unavailable',
        'A dependency is temporarily unavailable; retry.',
        { area: ErrorArea.TRANSIENT, retryAfterSeconds: 2 },
      ),
    );
  }
}

/** A tenancy lookup failed or timed out (internal; the bid path maps it to `BidUnavailableError`). */
export class MembershipUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('membership lookup unavailable');
    this.cause = cause;
  }
}
