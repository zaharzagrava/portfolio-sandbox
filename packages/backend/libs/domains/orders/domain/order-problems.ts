import type { ProblemCatalogEntry } from '@app/common/errors';

const entry = (
  code: string,
  status: number,
  title: string,
  detail: string,
): ProblemCatalogEntry => ({ code, status, title, detail, owner: 'orders' });

/**
 * The stable problem codes of S10, registered at module definition so a clash with another owner fails startup.
 * `idempotency_*`, `payload_too_large`, `too_many_ids` and `invalid_cursor` belong to the platform or are shared and
 * are not registered here.
 */
export const ORDERS_PROBLEMS: ProblemCatalogEntry[] = [
  entry(
    'price_changed',
    409,
    'Conflict',
    'The total changed since you last saw it.',
  ),
  entry('cart_empty', 422, 'Unprocessable Entity', 'The cart is empty.'),
  entry(
    'cart_line_limit',
    422,
    'Unprocessable Entity',
    'A cart holds a limited number of different products.',
  ),
  entry(
    'product_unavailable',
    422,
    'Unprocessable Entity',
    'Some products in the cart cannot be bought.',
  ),
  entry(
    'mixed_currency',
    422,
    'Unprocessable Entity',
    'The cart mixes currencies.',
  ),
  entry(
    'out_of_stock',
    422,
    'Unprocessable Entity',
    'Some products are out of stock.',
  ),
  entry(
    'checkout_in_progress',
    409,
    'Conflict',
    'Another checkout of yours is running.',
  ),
  entry(
    'checkout_unavailable',
    503,
    'Service Unavailable',
    'Checkout is temporarily unavailable; retry.',
  ),
  entry(
    'cart_unavailable',
    503,
    'Service Unavailable',
    'The cart is temporarily unavailable; retry.',
  ),
  entry('order_not_found', 404, 'Not found', 'Order not found.'),
  entry(
    'order_not_cancellable',
    409,
    'Conflict',
    'The order can no longer be cancelled.',
  ),
  entry('order_not_reserved', 409, 'Conflict', 'The order cannot be paid.'),
  entry('hold_expired', 409, 'Conflict', 'The order cannot be paid.'),
  entry(
    'invalid_order_transition',
    409,
    'Conflict',
    'The order is not in a state that allows this change.',
  ),
  entry(
    'invalid_signature',
    400,
    'Bad Request',
    'The webhook signature is invalid.',
  ),
  entry(
    'invalid_payload',
    400,
    'Bad Request',
    'The webhook payload is not valid.',
  ),
];
