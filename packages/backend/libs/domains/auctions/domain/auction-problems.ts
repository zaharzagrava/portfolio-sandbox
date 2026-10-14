import type { ProblemCatalogEntry } from '@app/common/errors';

const entry = (
  code: string,
  status: number,
  title: string,
  detail: string,
): ProblemCatalogEntry => ({ code, status, title, detail, owner: 'auctions' });

/**
 * The stable problem codes of S21 that no other owner defines, registered at module definition so a clash with
 * another owner fails startup. `validation_failed`, `invalid_cursor`, `rate_limited`, `idempotency_*`,
 * `product_not_found`, `product_unavailable` and `insufficient_stock` belong to the platform or to the catalog and are
 * not registered here (the classes in `auction-errors.ts` still carry them).
 */
export const AUCTION_PROBLEMS: ProblemCatalogEntry[] = [
  entry(
    'bid_too_low',
    422,
    'Unprocessable Entity',
    'The maximum is below the minimum allowed bid.',
  ),
  entry(
    'bid_not_increasing',
    422,
    'Unprocessable Entity',
    'A new maximum must be above your current maximum.',
  ),
  entry(
    'auction_closed',
    409,
    'Conflict',
    'The auction is not accepting bids.',
  ),
  entry('auction_not_started', 409, 'Conflict', 'The auction has not started.'),
  entry(
    'shill_bid_forbidden',
    403,
    'Forbidden',
    'Members of the selling shop cannot bid.',
  ),
  entry(
    'bid_unavailable',
    503,
    'Service Unavailable',
    'Bidding is temporarily unavailable; retry.',
  ),
  entry('auction_not_found', 404, 'Not Found', 'Auction not found.'),
  entry(
    'auction_exists_for_product',
    409,
    'Conflict',
    'The product already has a live auction.',
  ),
  entry(
    'auction_has_bids',
    409,
    'Conflict',
    'An auction with bids cannot be cancelled.',
  ),
  entry(
    'auction_not_cancellable',
    409,
    'Conflict',
    'The auction can no longer be cancelled.',
  ),
  entry(
    'reserve_below_starting',
    422,
    'Unprocessable Entity',
    'The reserve price must be at least the starting price.',
  ),
  entry(
    'starts_too_soon',
    422,
    'Unprocessable Entity',
    'The auction must start later.',
  ),
  entry(
    'duration_out_of_range',
    422,
    'Unprocessable Entity',
    'The auction must last between 10 minutes and 30 days.',
  ),
];
