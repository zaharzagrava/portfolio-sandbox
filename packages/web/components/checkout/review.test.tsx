import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartPageResponse } from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { formatMoney } from '@/lib/utils';
import { cartPageBody, PRODUCT_A, PRODUCT_B, problemResponse, SHOP_A } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/app/checkout/actions', () => ({ placeOrder: vi.fn() }));
const trackCheckoutStep = vi.hoisted(() => vi.fn());
vi.mock('@/lib/checkout/events', () => ({ trackCheckoutStep }));

import { Review } from './review';

const SHOP_B = '8d2e0b3f-1c4a-4d6e-9f70-3b4c5d6e7f80';

type Line = CartPageResponse['lines'][number];
const line = (productId: string, quantity: number, overrides: Partial<Line> = {}): Line => ({
  productId,
  quantity,
  addedAt: '2026-10-10T10:00:00.000Z',
  product: { title: 'Headphones', priceMinor: 1999, currency: 'EUR', imageUrl: null, inStock: true },
  shop: { id: SHOP_A, name: 'Sound Shop' },
  ...overrides,
});

function renderReview(page: CartPageResponse | null) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  if (page) client.setQueryData(queryKeys.cart.page(), page);
  return render(
    <QueryClientProvider client={client}>
      <Review />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  trackCheckoutStep.mockClear();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('Checkout review (W03 UK1)', () => {
  it('W03 AS-15: shows the progress list with Review current, the lines by shop, the note, the estimated total and Place order', () => {
    renderReview(
      cartPageBody({
        lines: [
          line(PRODUCT_A, 2),
          line(PRODUCT_B, 1, { product: { title: 'Speaker', priceMinor: 5000, currency: 'EUR', imageUrl: null, inStock: true }, shop: { id: SHOP_B, name: 'Bass Barn' } }),
        ],
      }),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Checkout' })).toBeInTheDocument();

    const steps = within(screen.getByRole('list', { name: 'Checkout progress' })).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual(['Review', 'Pay']);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
    expect(steps[1]).not.toHaveAttribute('aria-current');

    const sound = screen.getByRole('region', { name: 'Sound Shop' });
    expect(sound).toHaveTextContent('Headphones');
    expect(sound).toHaveTextContent('Quantity 2');
    expect(sound).toHaveTextContent(formatMoney(3998, 'EUR'));
    expect(screen.getByRole('region', { name: 'Bass Barn' })).toHaveTextContent('Speaker');

    expect(screen.getByText('Placing the order holds your items for 15 minutes while you pay.')).toBeInTheDocument();
    expect(screen.getByText('Estimated total')).toBeInTheDocument();
    expect(screen.getByText(formatMoney(3998 + 5000, 'EUR'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place order' })).toBeEnabled();
  });

  it('W03 AS-08: a line whose product is gone says so, is not priced and stays out of the estimated total', () => {
    renderReview(cartPageBody({ lines: [line(PRODUCT_A, 1), line(PRODUCT_B, 3, { product: null, shop: null })] }));
    const other = screen.getByRole('region', { name: 'Other items' });
    expect(other).toHaveTextContent('Unavailable product');
    expect(other).toHaveTextContent('No longer available');
    expect(other).toHaveTextContent('—');
    const totals = screen.getByText('Estimated total').closest('dl') as HTMLElement;
    expect(within(totals).getByText(formatMoney(1999, 'EUR'))).toBeInTheDocument();
  });

  it('W03 AS-08: a product that is out of stock is labelled and still counts', () => {
    renderReview(cartPageBody({ lines: [line(PRODUCT_A, 1, { product: { title: 'Headphones', priceMinor: 1999, currency: 'EUR', imageUrl: null, inStock: false } })] }));
    expect(screen.getByRole('region', { name: 'Sound Shop' })).toHaveTextContent('Out of stock');
    expect(screen.getByRole('button', { name: 'Place order' })).toBeEnabled();
  });

  it('W03 AS-26: lines in two currencies list one estimated amount per currency', () => {
    renderReview(
      cartPageBody({
        lines: [line(PRODUCT_A, 1), line(PRODUCT_B, 1, { product: { title: 'Mug', priceMinor: 700, currency: 'USD', imageUrl: null, inStock: true } })],
      }),
    );
    const totals = screen.getByText('Estimated total').closest('dl') as HTMLElement;
    expect(within(totals).getByText(formatMoney(1999, 'EUR'))).toBeInTheDocument();
    expect(within(totals).getByText(formatMoney(700, 'USD'))).toBeInTheDocument();
  });

  it('W03 AS-16: an empty cart shows the empty state with Browse products and no Place order', () => {
    renderReview(cartPageBody({ lines: [] }));
    expect(screen.getByText('Your cart is empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse products' })).toHaveAttribute('href', '/search');
    expect(screen.queryByRole('button', { name: /place order/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Placing the order holds your items for 15 minutes while you pay.')).not.toBeInTheDocument();
  });

  it('W03 AS-33: offline shows the status banner and disables Place order, and online brings it back', () => {
    renderReview(cartPageBody());
    expect(screen.queryByText("You're offline. Reconnect to place your order.")).not.toBeInTheDocument();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('status')).toHaveTextContent("You're offline. Reconnect to place your order.");
    expect(screen.getByRole('button', { name: 'Place order' })).toBeDisabled();

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByText("You're offline. Reconnect to place your order.")).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place order' })).toBeEnabled();
  });

  it('W03 AS-17: emits one checkout_step review event with the number of items when the review is shown', () => {
    const { rerender } = renderReview(cartPageBody({ lines: [line(PRODUCT_A, 2)] }));
    expect(trackCheckoutStep).toHaveBeenCalledTimes(1);
    expect(trackCheckoutStep).toHaveBeenCalledWith({ step: 'review', items: 2 });
    rerender(<></>);
    expect(trackCheckoutStep).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-09: while the cart is being read the review shows a loading status and no Place order', async () => {
    server.use(http.get(/\/api\/bff\/cart$/, () => new Promise(() => {})));
    renderReview(null);
    expect(screen.getByRole('status')).toHaveTextContent('Loading checkout…');
    expect(screen.queryByRole('button', { name: /place order/i })).not.toBeInTheDocument();
    expect(trackCheckoutStep).not.toHaveBeenCalled();
  });

  it("W03 AS-09: when the cart cannot be read the review says so with Try again, and a retry reads again", async () => {
    server.use(http.get(/\/api\/bff\/cart$/, () => problemResponse(500, 'internal_error')));
    renderReview(null);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't load your cart.");
    expect(screen.queryByRole('button', { name: /place order/i })).not.toBeInTheDocument();

    server.use(http.get(/\/api\/bff\/cart$/, () => HttpResponse.json(cartPageBody())));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Place order' })).toBeEnabled();
  });
});
