import { describe, expect, it } from 'vitest';
import type { Problem } from './errors';
import { problemFromError } from './errors';
import { problemCopy, type Surface } from './problem-copy';

const problem = (status: number, code?: string, extra: Partial<Problem> = {}): Problem => ({ status, ...(code ? { code } : {}), errors: [], ...extra });

const GENERIC = 'Something went wrong. Try again.';
const SESSION = 'Your session ended. Sign in again to continue.';

type Row = [Surface, Problem, string];

/** W03 FR-081: the visible form per (surface, status, code). */
const rows: Row[] = [
  // cart (AS-07)
  ['cart', problem(422, 'cart_line_limit'), 'Your cart is full (50 different items). Remove one to add another.'],
  ['cart', problem(429, 'rate_limited', { retryAfterSeconds: 30 }), "You're changing the cart too fast. Try again in 30 seconds."],
  ['cart', problem(429, 'rate_limited'), "You're changing the cart too fast. Try again later."],
  ['cart', problem(0), "You're offline. The change wasn't saved."],
  ['cart', problem(400, 'validation_failed'), GENERIC],
  ['cart', problem(500), GENERIC],
  ['cart', problem(503), GENERIC],
  ['cart', problem(418, 'teapot'), GENERIC],
  ['cart', problem(401, 'session_expired'), SESSION],
  // checkout (AS-22..AS-31)
  ['checkout', problem(422, 'cart_empty'), 'Your cart is empty.'],
  ['checkout', problem(422, 'mixed_currency'), 'Your cart has items priced in different currencies. Remove the items of one currency to continue.'],
  ['checkout', problem(409, 'price_changed'), 'Prices changed since you added these items.'],
  ['checkout', problem(409, 'idempotency_in_flight'), "We're still processing your order. Check Your orders before trying again."],
  ['checkout', problem(409, 'checkout_in_progress'), 'Another checkout for your cart is in progress. Check Your orders or try again in a moment.'],
  ['checkout', problem(429, 'rate_limited', { retryAfterSeconds: 45 }), 'Too many attempts. Try again in 45 seconds.'],
  ['checkout', problem(503, 'checkout_unavailable', { retryAfterSeconds: 2 }), 'Checkout is temporarily unavailable. Nothing was charged. Try again in a moment.'],
  ['checkout', problem(0), 'Checkout is temporarily unavailable. Nothing was charged. Try again in a moment.'],
  ['checkout', problem(422, 'flash_sale_limit_exceeded'), "You've reached the purchase limit for this sale item."],
  ['checkout', problem(429, 'flash_sale_busy', { retryAfterSeconds: 5 }), 'This sale is very busy. Try again in 5 seconds.'],
  ['checkout', problem(503, 'flash_sale_busy', { retryAfterSeconds: 5 }), 'This sale is very busy. Try again in 5 seconds.'],
  ['checkout', problem(503, 'flash_sale_unavailable'), 'This sale is temporarily unavailable. Try again shortly.'],
  ['checkout', problem(422, 'idempotency_key_reuse'), GENERIC],
  ['checkout', problem(422, 'idempotency_key_required'), GENERIC],
  ['checkout', problem(422, 'idempotency_key_invalid'), GENERIC],
  ['checkout', problem(400, 'validation_failed'), GENERIC],
  ['checkout', problem(500), GENERIC],
  ['checkout', problem(502), GENERIC],
  ['checkout', problem(401, 'unauthenticated'), SESSION],
  // pay (AS-44)
  ['pay', problem(404, 'order_not_found'), "We couldn't start the payment yet. Try again."],
  ['pay', problem(404, 'payment_not_found'), "We couldn't find that payment."],
  ['pay', problem(409, 'order_not_payable'), "This order can't be paid any more."],
  ['pay', problem(409, 'payment_already_exists'), 'A payment for this order is already in progress.'],
  ['pay', problem(409, 'idempotency_in_flight'), "We're still processing your payment. Try again in a moment."],
  ['pay', problem(429, 'rate_limited', { retryAfterSeconds: 10 }), 'Too many attempts. Try again in 10 seconds.'],
  ['pay', problem(422, 'amount_out_of_range'), GENERIC],
  ['pay', problem(422, 'currency_unsupported'), GENERIC],
  ['pay', problem(422, 'idempotency_key_reuse'), GENERIC],
  ['pay', problem(400, 'validation_failed'), GENERIC],
  ['pay', problem(500), GENERIC],
  ['pay', problem(0), "You're offline. Check your connection and try again."],
  // orders (AS-52..AS-54)
  ['orders', problem(404, 'order_not_found'), "We couldn't find that order."],
  ['orders', problem(409, 'order_not_cancellable'), "This order can't be cancelled any more."],
  ['orders', problem(400, 'invalid_cursor'), 'This page of orders is no longer available.'],
  ['orders', problem(429, 'rate_limited', { retryAfterSeconds: 60 }), 'Too many requests. Try again in 1 minute.'],
  ['orders', problem(500), GENERIC],
  ['orders', problem(0), "You're offline. Check your connection and try again."],
  // notifications (AS-63..AS-65)
  ['notifications', problem(400, 'invalid_cursor'), "We couldn't load notifications."],
  ['notifications', problem(429, 'rate_limited', { retryAfterSeconds: 20 }), 'Try again in 20 seconds.'],
  ['notifications', problem(429, 'rate_limited'), 'Try again later.'],
  ['notifications', problem(400, 'validation_failed'), GENERIC],
  ['notifications', problem(500), GENERIC],
  ['notifications', problem(401, 'invalid_token'), SESSION],
];

describe('problemCopy for the W03 surfaces', () => {
  it.each(rows)('W03 FR-081: %s %j gives the catalogue text', (surface, input, text) => {
    expect(problemCopy(surface, input).text).toBe(text);
  });

  it('W03 FR-081: the lead sentences take the product titles of the checkout problem', () => {
    expect(problemCopy('checkout', problem(422, 'out_of_stock'), { titles: ['Headphones', 'Case'] }).text).toBe('Not enough stock for: Headphones, Case. Nothing was reserved.');
    expect(problemCopy('checkout', problem(422, 'out_of_stock')).text).toBe('Not enough stock for some items. Nothing was reserved.');
    expect(problemCopy('checkout', problem(422, 'product_unavailable'), { titles: ['Headphones'] }).text).toBe("Some items can't be bought any more: Headphones.");
    expect(problemCopy('checkout', problem(422, 'product_unavailable')).text).toBe("Some items can't be bought any more.");
  });

  it('W03 FR-081: order_not_cancellable names the current status when the caller has its text', () => {
    expect(problemCopy('orders', problem(409, 'order_not_cancellable'), { statusText: 'Paid' }).text).toBe("This order can't be cancelled any more (it is now Paid).");
  });

  it('W03 FR-081: a failed read says what could not be loaded; 429 and 5xx keep their forms', () => {
    expect(problemCopy('cart', problem(0), { operation: 'read' }).text).toBe("We couldn't load your cart.");
    expect(problemCopy('orders', problem(0), { operation: 'read' }).text).toBe("We couldn't load your orders.");
    expect(problemCopy('notifications', problem(0), { operation: 'read' }).text).toBe("We couldn't load notifications.");
    expect(problemCopy('cart', problem(500), { operation: 'read' }).text).toBe(GENERIC);
    expect(problemCopy('orders', problem(429, 'rate_limited', { retryAfterSeconds: 3 }), { operation: 'read' }).text).toBe('Too many requests. Try again in 3 seconds.');
  });

  it('W03 FR-082: the generic form carries "Reference: {requestId}" when the body had one', () => {
    for (const input of [problem(500, undefined, { requestId: 'req-7' }), problem(400, 'validation_failed', { requestId: 'req-7' }), problem(422, 'idempotency_key_reuse', { requestId: 'req-7' })]) {
      expect(problemCopy('checkout', input).reference).toBe('Reference: req-7');
    }
    expect(problemCopy('checkout', problem(500)).reference).toBeUndefined();
  });

  it('W03 FR-082: known codes, rate limits and offline carry no reference', () => {
    expect(problemCopy('checkout', problem(409, 'price_changed', { requestId: 'r' })).reference).toBeUndefined();
    expect(problemCopy('checkout', problem(429, 'rate_limited', { requestId: 'r' })).reference).toBeUndefined();
    expect(problemCopy('cart', problem(0)).reference).toBeUndefined();
  });

  it('W03 FR-082: detail is a second line only for a 4xx generic form with a plain string of at most 200 characters', () => {
    expect(problemCopy('checkout', problem(400, 'validation_failed'), { detail: 'quantity is required' }).detail).toBe('quantity is required');
    expect(problemCopy('checkout', problem(400, 'validation_failed'), { detail: 'x'.repeat(200) }).detail).toBe('x'.repeat(200));
    expect(problemCopy('checkout', problem(400, 'validation_failed'), { detail: 'x'.repeat(201) }).detail).toBeUndefined();
    expect(problemCopy('checkout', problem(400, 'validation_failed'), { detail: '   ' }).detail).toBeUndefined();
    expect(problemCopy('checkout', problem(400, 'validation_failed'), { detail: 42 as never }).detail).toBeUndefined();
    expect(problemCopy('checkout', problem(500), { detail: 'select * from users' }).detail).toBeUndefined();
    expect(problemCopy('checkout', problem(503), { detail: 'upstream down' }).detail).toBeUndefined();
    // a known code never shows the server's words
    expect(problemCopy('checkout', problem(409, 'price_changed'), { detail: 'SERVER WORDS' }).detail).toBeUndefined();
  });

  it('W03 AS-73: title and detail of the server never reach the text, for any W03 surface', () => {
    const error = { response: { status: 422, headers: {}, data: { code: 'teapot', title: 'SERVER TITLE', detail: 'SERVER DETAIL', requestId: 'r1' } } };
    for (const surface of ['cart', 'checkout', 'pay', 'orders', 'notifications'] as Surface[]) {
      const copy = problemCopy(surface, problemFromError(error));
      expect(copy.text).toBe(GENERIC);
      expect(JSON.stringify(copy)).not.toMatch(/SERVER/);
    }
  });

  it('W03 FR-081: retryable is true for offline, 429 and 5xx only', () => {
    expect(problemCopy('checkout', problem(503, 'checkout_unavailable')).retryable).toBe(true);
    expect(problemCopy('cart', problem(429, 'rate_limited')).retryable).toBe(true);
    expect(problemCopy('cart', problem(0)).retryable).toBe(true);
    expect(problemCopy('checkout', problem(422, 'cart_empty')).retryable).toBe(false);
  });
});
