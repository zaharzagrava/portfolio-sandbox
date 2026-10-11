import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartDto, CartPageResponse } from '@marketplace-sandbox/contracts';
import type { CheckoutProblem, PlaceOrderResult } from '@/lib/checkout/checkout-problem';
import { setSessionEndHandler, rearmSessionEnd } from '@/lib/auth/session-ended';
import { CHECKOUT_ATTEMPT_KEY } from '@/lib/checkout/attempt-store';
import { queryKeys } from '@/lib/query-keys';
import { formatMoney } from '@/lib/utils';
import { cartBody, cartPageBody, ORDER_ID, PRODUCT_A, PRODUCT_B, SHOP_A } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const placeOrder = vi.hoisted(() => vi.fn());
vi.mock('@/app/checkout/actions', () => ({ placeOrder }));
const trackCheckoutStep = vi.hoisted(() => vi.fn());
vi.mock('@/lib/checkout/events', () => ({ trackCheckoutStep }));

import { Review } from './review';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const origin = 'http://localhost:3000';

type Line = CartPageResponse['lines'][number];
const lineA: Line = {
  productId: PRODUCT_A,
  quantity: 2,
  addedAt: '2026-10-10T10:00:00.000Z',
  product: { title: 'Headphones', priceMinor: 1999, currency: 'EUR', imageUrl: null, inStock: true },
  shop: { id: SHOP_A, name: 'Sound Shop' },
};
const lineB: Line = {
  productId: PRODUCT_B,
  quantity: 1,
  addedAt: '2026-10-10T10:00:00.000Z',
  product: { title: 'Speaker', priceMinor: 5000, currency: 'EUR', imageUrl: null, inStock: true },
  shop: { id: SHOP_A, name: 'Sound Shop' },
};
const TOTAL_A = 3998;

let client: QueryClient;
function renderReview(lines: Line[] = [lineA]) {
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(queryKeys.cart.page(), cartPageBody({ lines }));
  client.setQueryData<CartDto>(queryKeys.cart.lines(), cartBody({ lines: lines.map(({ productId, quantity, addedAt }) => ({ productId, quantity, addedAt })) }));
  return render(
    <QueryClientProvider client={client}>
      <Review />
    </QueryClientProvider>,
  );
}

const problem = (status: number, code: string | undefined, extra: Partial<CheckoutProblem> = {}): PlaceOrderResult => ({
  ok: false,
  problem: { status, ...(code ? { code } : {}), errors: [], ...extra },
});
const created = (replayed = false): PlaceOrderResult => ({ ok: true, orderId: ORDER_ID, replayed });
const button = () => screen.getByRole('button', { name: /place order|placing order/i });
const keyOf = (call: number): string => placeOrder.mock.calls[call][0].key;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  placeOrder.mockReset();
  router.push.mockReset();
  trackCheckoutStep.mockReset();
  sessionStorage.clear();
  rearmSessionEnd();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setSessionEndHandler(null);
});

describe('Place order (W03 UK4)', () => {
  it('W03 AS-17: pressing Place order shows the pending label, disables the button with aria-busy, sends the key and the shown total, then moves to the pay page and clears the cart', async () => {
    const answer = deferred<PlaceOrderResult>();
    placeOrder.mockReturnValue(answer.promise);
    renderReview();
    await userEvent.click(button());

    expect(button()).toHaveTextContent('Placing order…');
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute('aria-busy', 'true');
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(placeOrder).toHaveBeenCalledWith({ key: expect.stringMatching(UUID), expectedTotalMinor: TOTAL_A });
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY) as string)).toMatchObject({ key: keyOf(0), expectedTotalMinor: TOTAL_A });

    await act(async () => answer.resolve(created()));
    expect(router.push).toHaveBeenCalledWith(`/checkout/pay/${ORDER_ID}`);
    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)).toBeNull();
    expect(client.getQueryData<CartDto>(queryKeys.cart.lines())?.lines).toEqual([]);
    expect(button()).toBeDisabled();
  });

  it('W03 AS-18: two quick presses send one request', async () => {
    placeOrder.mockReturnValue(new Promise(() => {}));
    renderReview();
    const target = button();
    fireEvent.click(target);
    fireEvent.click(target);
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-18: pressing Enter twice on the button sends one request', async () => {
    placeOrder.mockReturnValue(new Promise(() => {}));
    renderReview();
    button().focus();
    await userEvent.keyboard('{Enter}{Enter}');
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-20: after a reload the stored attempt of the same cart is used, so the same key is sent', async () => {
    placeOrder.mockResolvedValue(problem(0, undefined));
    const first = renderReview();
    await userEvent.click(button());
    await screen.findByRole('alert');
    first.unmount();

    placeOrder.mockResolvedValue(created());
    renderReview();
    await userEvent.click(button());
    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('W03 AS-19: when the cart changed since the attempt began, the press makes a new key', async () => {
    placeOrder.mockResolvedValue(problem(0, undefined));
    const first = renderReview([lineA]);
    await userEvent.click(button());
    await screen.findByRole('alert');
    first.unmount();

    placeOrder.mockResolvedValue(created());
    renderReview([lineA, lineB]);
    await userEvent.click(button());
    expect(keyOf(1)).not.toBe(keyOf(0));
    expect(placeOrder.mock.calls[1][0].expectedTotalMinor).toBe(TOTAL_A + 5000);
  });

  it('W03 AS-21: a replayed answer behaves exactly like the first 202', async () => {
    placeOrder.mockResolvedValue(created(true));
    renderReview();
    await userEvent.click(button());
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/checkout/pay/${ORDER_ID}`));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('W03 AS-22: 409 idempotency_in_flight is retried with the same key after the advertised delay, and still reads Placing order…', async () => {
    vi.useFakeTimers();
    placeOrder.mockResolvedValueOnce(problem(409, 'idempotency_in_flight', { retryAfter: 3, retryAfterSeconds: 3 })).mockResolvedValueOnce(created());
    renderReview();
    fireEvent.click(button());
    await act(async () => {});
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(button()).toHaveTextContent('Placing order…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(2900));
    expect(placeOrder).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(router.push).toHaveBeenCalledWith(`/checkout/pay/${ORDER_ID}`);
  });

  it('W03 AS-22: the retry waits at least one second even when Retry-After says 0', async () => {
    vi.useFakeTimers();
    placeOrder.mockResolvedValueOnce(problem(409, 'idempotency_in_flight', { retryAfter: 0, retryAfterSeconds: 0 })).mockResolvedValueOnce(created());
    renderReview();
    fireEvent.click(button());
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(900));
    expect(placeOrder).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(placeOrder).toHaveBeenCalledTimes(2);
  });

  it('W03 AS-22: after five retries it stops with the alert and the Your orders link, Place order is enabled again with the same key', async () => {
    vi.useFakeTimers();
    placeOrder.mockResolvedValue(problem(409, 'idempotency_in_flight', { retryAfter: 1, retryAfterSeconds: 1 }));
    renderReview();
    fireEvent.click(button());
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(placeOrder).toHaveBeenCalledTimes(6);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("We're still processing your order. Check Your orders before trying again.");
    expect(within(alert).getByRole('link', { name: 'Your orders' })).toHaveAttribute('href', '/orders');
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent('Place order');

    placeOrder.mockResolvedValue(created());
    fireEvent.click(button());
    await act(async () => {});
    expect(placeOrder).toHaveBeenCalledTimes(7);
    expect(keyOf(6)).toBe(keyOf(0));
  });

  it('W03 AS-23: price_changed shows the alert with focus, old and new unit prices and the new total; nothing is placed until Accept', async () => {
    placeOrder.mockResolvedValueOnce(
      problem(409, 'price_changed', {
        currentTotalMinor: 4500,
        // The API lists every line; only the ones whose unit price differs from what the buyer saw are shown.
        lines: [
          { productId: PRODUCT_A, unitPriceMinor: 2250 },
          { productId: PRODUCT_B, unitPriceMinor: 5000 },
        ],
      }),
    );
    renderReview([lineA, lineB]);
    await userEvent.click(button());
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('Speaker:');

    expect(alert).toHaveTextContent('Prices changed since you added these items.');
    expect(alert).toHaveTextContent(`Headphones: was ${formatMoney(1999, 'EUR')}, now ${formatMoney(2250, 'EUR')}`);
    expect(alert).toHaveTextContent(`New total: ${formatMoney(4500, 'EUR')}`);
    expect(alert).toHaveFocus();
    expect(within(alert).getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart');
    expect(placeOrder).toHaveBeenCalledTimes(1);

    placeOrder.mockResolvedValueOnce(created());
    await userEvent.click(within(alert).getByRole('button', { name: 'Accept new total and place order' }));
    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(placeOrder.mock.calls[1][0]).toEqual({ key: keyOf(0), expectedTotalMinor: 4500 });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/checkout/pay/${ORDER_ID}`));
  });

  it('W03 AS-24: out_of_stock names the products by title, labels their lines, offers Review cart, and the next press uses a new key', async () => {
    placeOrder.mockResolvedValueOnce(problem(422, 'out_of_stock', { productIds: [PRODUCT_B], flashSaleId: 'fs-1' }));
    renderReview([lineA, lineB]);
    await userEvent.click(button());
    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent('Not enough stock for: Speaker. Nothing was reserved.');
    expect(within(alert).getByRole('link', { name: 'Review cart' })).toHaveAttribute('href', '/cart');
    const items = screen.getAllByRole('listitem');
    expect(items.filter((item) => item.textContent?.includes('Out of stock')).map((item) => item.textContent)).toEqual([expect.stringContaining('Speaker')]);
    expect(button()).toBeEnabled();

    placeOrder.mockResolvedValueOnce(created());
    await userEvent.click(button());
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('W03 AS-25: product_unavailable removes exactly the named lines with one write each, Place order is disabled meanwhile', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    const writes: { id: string; body: unknown }[] = [];
    const release = deferred<void>();
    server.use(
      http.put(`${origin}/api/cart/items/:productId`, async ({ params, request }) => {
        writes.push({ id: String(params.productId), body: await request.json() });
        await release.promise;
        return HttpResponse.json(cartBody({ lines: [{ productId: PRODUCT_A, quantity: 2, addedAt: '2026-10-10T10:00:00.000Z' }] }));
      }),
      http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody())),
      http.get(`${origin}/api/bff/cart`, () => HttpResponse.json(cartPageBody({ lines: [lineA] }))),
    );
    placeOrder.mockResolvedValueOnce(problem(422, 'product_unavailable', { productIds: [PRODUCT_B] }));
    renderReview([lineA, lineB]);
    await userEvent.click(button());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Some items can't be bought any more: Speaker.");

    await userEvent.click(within(alert).getByRole('button', { name: 'Remove unavailable items' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes).toEqual([{ id: PRODUCT_B, body: { quantity: 0 } }]);
    expect(button()).toBeDisabled();

    release.resolve();
    await waitFor(() => expect(button()).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Remove unavailable items' })).not.toBeInTheDocument();
  });

  it('W03 AS-26: mixed_currency shows the exact copy and Back to cart', async () => {
    placeOrder.mockResolvedValueOnce(problem(422, 'mixed_currency'));
    renderReview();
    await userEvent.click(button());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your cart has items priced in different currencies. Remove the items of one currency to continue.');
    expect(within(alert).getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart');
  });

  it('W03 AS-27: cart_empty shows the empty state with the Your orders note and no Place order', async () => {
    const reads: string[] = [];
    server.use(
      http.get(`${origin}/api/bff/cart`, () => {
        reads.push('page');
        return HttpResponse.json(cartPageBody({ lines: [] }));
      }),
    );
    placeOrder.mockResolvedValueOnce(problem(422, 'cart_empty'));
    renderReview();
    await userEvent.click(button());
    expect(await screen.findByText('Your cart is empty')).toBeInTheDocument();
    const note = screen.getByText(/If you just placed an order/);
    expect(note).toHaveTextContent("If you just placed an order, you'll find it in Your orders.");
    expect(within(note).getByRole('link', { name: 'Your orders' })).toHaveAttribute('href', '/orders');
    expect(screen.queryByRole('button', { name: /place order/i })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)).toBeNull();
    await waitFor(() => expect(reads).toEqual(['page'])); // the cart is read again
  });

  it('W03 AS-28: checkout_in_progress shows the alert with the Your orders link and Place order stays enabled', async () => {
    placeOrder.mockResolvedValueOnce(problem(409, 'checkout_in_progress'));
    renderReview();
    await userEvent.click(button());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Another checkout for your cart is in progress. Check Your orders or try again in a moment.');
    expect(within(alert).getByRole('link', { name: 'Your orders' })).toHaveAttribute('href', '/orders');
    expect(button()).toBeEnabled();
  });

  it('W03 AS-29: rate_limited disables Place order until Retry-After passes, counts down in an unannounced line and announces only the start and the end', async () => {
    vi.useFakeTimers();
    placeOrder.mockResolvedValueOnce(problem(429, 'rate_limited', { retryAfter: 3, retryAfterSeconds: 3 }));
    renderReview();
    fireEvent.click(button());
    await act(async () => {});

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Too many attempts. Try again in 3 seconds.');
    expect(button()).toBeDisabled();
    const countdown = within(alert).getByText(/Too many attempts/);
    expect(countdown.closest('[aria-live]')).toHaveAttribute('aria-live', 'off');

    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(alert).toHaveTextContent('Too many attempts. Try again in 2 seconds.');
    expect(button()).toBeDisabled();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(2100));
    expect(button()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You can place your order again.');
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-30: checkout_unavailable shows the exact copy, Place order is enabled and the retry sends the same key', async () => {
    placeOrder.mockResolvedValueOnce(problem(503, 'checkout_unavailable', { retryAfter: 2, retryAfterSeconds: 2 }));
    renderReview();
    await userEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent('Checkout is temporarily unavailable. Nothing was charged. Try again in a moment.');
    expect(button()).toBeEnabled();

    placeOrder.mockResolvedValueOnce(created());
    await userEvent.click(button());
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('W03 AS-30: a network failure, or a Server Function call that throws, reads the same and keeps the key', async () => {
    placeOrder.mockRejectedValueOnce(new Error('Failed to fetch'));
    renderReview();
    await userEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent('Checkout is temporarily unavailable. Nothing was charged. Try again in a moment.');
    expect(button()).toBeEnabled();

    placeOrder.mockResolvedValueOnce(problem(0, undefined));
    await userEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent('Checkout is temporarily unavailable. Nothing was charged. Try again in a moment.');
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it.each(['idempotency_key_reuse', 'idempotency_key_required', 'idempotency_key_invalid'])(
    'W03 AS-31: %s shows the generic alert with the reference and the next press makes a new attempt',
    async (code) => {
      placeOrder.mockResolvedValueOnce(problem(422, code, { requestId: 'req-77' }));
      renderReview();
      await userEvent.click(button());
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Something went wrong. Try again.');
      expect(alert).toHaveTextContent('Reference: req-77');
      expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY)).toBeNull();

      placeOrder.mockResolvedValueOnce(created());
      await userEvent.click(button());
      expect(keyOf(1)).not.toBe(keyOf(0));
    },
  );

  it('W03 AS-31: a 5xx shows the generic alert with the reference and never the detail; a 4xx plain detail is a second line', async () => {
    placeOrder.mockResolvedValueOnce(problem(500, 'internal_error', { requestId: 'req-5', detail: 'SELECT * FROM secrets' }));
    renderReview();
    await userEvent.click(button());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong. Try again.');
    expect(alert).toHaveTextContent('Reference: req-5');
    expect(alert).not.toHaveTextContent('secrets');

    placeOrder.mockResolvedValueOnce(problem(400, 'validation_failed', { detail: 'expectedTotalMinor must be an integer' }));
    await userEvent.click(button());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('expectedTotalMinor must be an integer'));
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
  });

  it('W03 AS-32: a 401 runs the session-ended flow once and keeps the stored attempt for after sign-in', async () => {
    const ended = vi.fn();
    setSessionEndHandler(ended);
    placeOrder.mockResolvedValue(problem(401, 'unauthenticated'));
    renderReview();
    await userEvent.click(button());
    await screen.findByRole('alert');
    await userEvent.click(button());
    await waitFor(() => expect(placeOrder).toHaveBeenCalledTimes(2));
    expect(ended).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_ATTEMPT_KEY) as string).key).toBe(keyOf(0));
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it('W03 AS-17: the review event is sent once, not again by a failed press and a retry', async () => {
    placeOrder.mockResolvedValueOnce(problem(503, 'checkout_unavailable')).mockResolvedValueOnce(created());
    renderReview();
    await userEvent.click(button());
    await screen.findByRole('alert');
    await userEvent.click(button());
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(trackCheckoutStep).toHaveBeenCalledTimes(1);
    expect(trackCheckoutStep).toHaveBeenCalledWith({ step: 'review', items: 2 });
  });
});
