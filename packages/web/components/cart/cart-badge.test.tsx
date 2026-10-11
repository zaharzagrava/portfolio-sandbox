import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { queryKeys } from '@/lib/query-keys';
import { cartBody, PRODUCT_A, PRODUCT_B, problemResponse } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';
import { CartBadge, useCartCount } from './cart-badge';

const origin = 'http://localhost:3000';
const line = (productId: string, quantity: number) => ({ productId, quantity, addedAt: '2026-10-10T10:00:00.000Z' });

function setup() {
  const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

const serveLines = (lines: ReturnType<typeof line>[]) => server.use(http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody({ lines }))));

afterEach(() => focusManager.setFocused(undefined));

describe('Cart badge', () => {
  it('W03 AS-13: the link is named "Cart" and shows no number while the count is unknown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get(`${origin}/api/cart`, async () => {
        await gate;
        return HttpResponse.json(cartBody({ lines: [line(PRODUCT_A, 2)] }));
      }),
    );
    const { wrapper } = setup();
    render(<CartBadge />, { wrapper });
    const link = screen.getByRole('link', { name: 'Cart' });
    expect(link).toHaveAttribute('href', '/cart');
    expect(link).toHaveTextContent('');
    release();
    await screen.findByRole('link', { name: 'Cart, 2 items' });
  });

  it('W03 AS-13: with lines it is named "Cart, n items" and shows the unit count', async () => {
    serveLines([line(PRODUCT_A, 2), line(PRODUCT_B, 3)]);
    const { wrapper } = setup();
    render(<CartBadge />, { wrapper });
    const link = await screen.findByRole('link', { name: 'Cart, 5 items' });
    expect(link).toHaveTextContent('5');
  });

  it('W03 AS-13: one unit reads "Cart, 1 item"', async () => {
    serveLines([line(PRODUCT_A, 1)]);
    const { wrapper } = setup();
    render(<CartBadge />, { wrapper });
    expect(await screen.findByRole('link', { name: 'Cart, 1 item' })).toHaveTextContent('1');
  });

  it('W03 AS-13: above 99 units the badge reads 99+ while the name keeps the real count', async () => {
    const others = ['5b4d0e1f-7c6a-4f81-9a9d-3e4f5a6b7c8d', '6c5e1f20-8d7b-4092-8bae-4f5a6b7c8d9e', '7d6f2031-9e8c-41a3-9cbf-5a6b7c8d9eaf', '8e703142-afad-42b4-adc0-6b7c8d9eafb0'];
    serveLines([PRODUCT_A, PRODUCT_B, ...others].map((productId) => line(productId, 20)));
    const { wrapper } = setup();
    render(<CartBadge />, { wrapper });
    const link = await screen.findByRole('link', { name: 'Cart, 120 items' });
    expect(link).toHaveTextContent('99+');
    expect(link).not.toHaveTextContent('120');
  });

  it('W03 AS-01: an empty cart shows no number and the plain name', async () => {
    serveLines([]);
    const { client, wrapper } = setup();
    render(<CartBadge />, { wrapper });
    await waitFor(() => expect(client.getQueryData(queryKeys.cart.lines())).toBeDefined());
    const link = screen.getByRole('link', { name: 'Cart' });
    expect(link).toHaveTextContent('');
  });

  it('W03 AS-13: when the read fails and nothing is cached the badge stays absent', async () => {
    server.use(http.get(`${origin}/api/cart`, () => problemResponse(500, 'internal')));
    const { client, wrapper } = setup();
    render(<CartBadge />, { wrapper });
    await waitFor(() => expect(client.getQueryState(queryKeys.cart.lines())?.status).toBe('error'));
    expect(screen.getByRole('link', { name: 'Cart' })).toHaveTextContent('');
  });

  it('W03 AS-13: the count follows a cart change made in this tab at once', async () => {
    serveLines([line(PRODUCT_A, 2)]);
    const { client, wrapper } = setup();
    render(<CartBadge />, { wrapper });
    await screen.findByRole('link', { name: 'Cart, 2 items' });
    act(() => {
      client.setQueryData(queryKeys.cart.lines(), cartBody({ lines: [line(PRODUCT_A, 7)] }));
    });
    // Query Client notifies observers on the next tick; no request is involved (the cache is the source).
    expect(await screen.findByRole('link', { name: 'Cart, 7 items' })).toBeInTheDocument();
  });

  it('W03 AS-13: a cart changed elsewhere shows after the tab regains focus', async () => {
    let answer = [line(PRODUCT_A, 1)];
    server.use(http.get(`${origin}/api/cart`, () => HttpResponse.json(cartBody({ lines: answer }))));
    const { wrapper } = setup();
    render(<CartBadge />, { wrapper });
    await screen.findByRole('link', { name: 'Cart, 1 item' });
    answer = [line(PRODUCT_A, 4)];
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await screen.findByRole('link', { name: 'Cart, 4 items' });
  });

  it('W03 AS-13: useCartCount is re-exported for the mobile menu', () => {
    expect(typeof useCartCount).toBe('function');
  });
});
