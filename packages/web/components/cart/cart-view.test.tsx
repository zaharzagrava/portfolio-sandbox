import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { loginHref } from '@/lib/auth/return-to';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { queryKeys } from '@/lib/query-keys';
import { productHref, searchHref } from '@/lib/routes';
import { fakeCartBackend, type FakeCartOptions, type FakeLine } from '../../tests/msw/cart-backend';
import { PRODUCT_A, PRODUCT_B, problemResponse } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';
import { CartView } from './cart-view';

let mockAuthenticated = true;
const track = vi.fn();
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: mockAuthenticated, isLoading: false, user: null, status: mockAuthenticated ? 'authenticated' : 'anonymous' }),
}));
vi.mock('@/lib/analytics/track', () => ({ track: (event: unknown) => track(event) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/cart' }));

const origin = 'http://localhost:3000';
const PRODUCT_C = '5b4d0e1f-7c6a-4f81-9a9d-3e4f5a6b7c8d';
const PRODUCT_D = '6c5e1f20-8d7b-4092-8bae-4f5a6b7c8d9e';
const SHOP_B = { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'Cable Co' };

const HEADPHONES: FakeLine = { productId: PRODUCT_A, quantity: 2, title: 'Headphones', priceMinor: 1999 };

function renderCart(lines: FakeLine[] = [HEADPHONES], options: FakeCartOptions = {}) {
  const backend = fakeCartBackend(lines, options);
  server.use(...backend.handlers);
  const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
  render(<CartView />, { wrapper });
  return { backend, client };
}

const lineFor = async (title: string) => (await screen.findByRole('group', { name: `Quantity of ${title}` })).closest('li') as HTMLElement;
const summary = () => screen.getByRole('region', { name: 'Order summary' });

beforeEach(() => {
  mockAuthenticated = true;
  track.mockReset();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
});
afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  vi.restoreAllMocks();
});

describe('Cart view', () => {
  describe('empty cart', () => {
    it('W03 AS-01: shows the heading, "Your cart is empty" and a Browse products link, with no summary and no checkout action', async () => {
      renderCart([]);
      expect(screen.getByRole('heading', { level: 1, name: 'Your cart' })).toBeInTheDocument();
      expect(await screen.findByText('Your cart is empty')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Browse products' })).toHaveAttribute('href', searchHref({}));
      expect(screen.queryByRole('region', { name: 'Order summary' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /check ?out/i })).not.toBeInTheDocument();
    });
  });

  describe('loaded cart', () => {
    it('W03 AS-03: groups lines under "Sold by {shop}" and puts shop-less lines under "Other items"', async () => {
      renderCart([
        HEADPHONES,
        { productId: PRODUCT_B, quantity: 1, title: 'Cable', priceMinor: 500, shop: SHOP_B },
        { productId: PRODUCT_C, quantity: 1, title: 'Charger', priceMinor: 900, shop: null },
      ]);
      await lineFor('Headphones');
      const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
      expect(headings).toEqual(expect.arrayContaining(['Sold by Sound Shop', 'Sold by Cable Co', 'Other items']));
      const sound = screen.getByRole('region', { name: 'Sold by Sound Shop' });
      expect(within(sound).getByRole('link', { name: 'Headphones' })).toBeInTheDocument();
      expect(within(sound).queryByRole('link', { name: 'Cable' })).not.toBeInTheDocument();
      expect(within(screen.getByRole('region', { name: 'Other items' })).getByRole('link', { name: 'Charger' })).toBeInTheDocument();
    });

    it('W03 AS-03: each line shows the title as a product link, the unit price, the quantity control, the line total and Remove', async () => {
      renderCart();
      const line = await lineFor('Headphones');
      expect(within(line).getByRole('link', { name: 'Headphones' })).toHaveAttribute('href', productHref(PRODUCT_A));
      expect(within(line).getByText('€19.99')).toBeInTheDocument();
      expect(within(line).getByText('€39.98')).toBeInTheDocument();
      expect(within(line).getByRole('textbox', { name: 'Quantity of Headphones' })).toHaveValue('2');
      expect(within(line).getByRole('button', { name: 'Remove Headphones' })).toBeInTheDocument();
    });

    it('W03 AS-03: the summary shows "Subtotal (n items)", a Checkout link and Continue shopping', async () => {
      renderCart([HEADPHONES, { productId: PRODUCT_B, quantity: 1, title: 'Cable', priceMinor: 500 }]);
      await lineFor('Headphones');
      const panel = within(summary());
      expect(panel.getByText('Subtotal (3 items)')).toBeInTheDocument();
      expect(panel.getByText('€44.98')).toBeInTheDocument();
      expect(panel.getByRole('link', { name: 'Checkout' })).toHaveAttribute('href', '/checkout');
      expect(screen.getByRole('link', { name: 'Continue shopping' })).toHaveAttribute('href', searchHref({}));
    });

    it('W03 AS-03: only an https image is shown (decorative); any other address gets the placeholder', async () => {
      const { backend } = renderCart([
        { ...HEADPHONES, imageUrl: 'https://cdn.example/h.jpg' },
        { productId: PRODUCT_B, quantity: 1, title: 'Cable', imageUrl: 'javascript:alert(1)' },
      ]);
      await lineFor('Headphones');
      const images = document.querySelectorAll('img');
      expect(images).toHaveLength(1);
      expect(images[0]).toHaveAttribute('src', 'https://cdn.example/h.jpg');
      expect(images[0]).toHaveAttribute('alt', '');
      expect(backend.lines).toHaveLength(2);
    });

    it('W03 AS-03: a title with markup is shown as text', async () => {
      renderCart([{ ...HEADPHONES, title: '<img src=x onerror=alert(1)> Buds' }]);
      const line = await lineFor('<img src=x onerror=alert(1)> Buds');
      expect(within(line).getByRole('link', { name: '<img src=x onerror=alert(1)> Buds' })).toBeInTheDocument();
      expect(document.querySelectorAll('img')).toHaveLength(0);
    });

    it('W03 AS-75: the cart step is reported once per view with the unit count only', async () => {
      renderCart([HEADPHONES, { productId: PRODUCT_B, quantity: 1, title: 'Cable' }]);
      await lineFor('Headphones');
      await userEvent.click(screen.getByRole('button', { name: 'Increase quantity of Headphones' }));
      expect(track).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenCalledWith({ name: 'checkout_step', props: { step: 'cart', items: 3 } });
    });
  });

  describe('unavailable and out-of-stock lines', () => {
    it('W03 AS-08: a product the catalogue no longer knows reads "No longer available", shows "—", keeps Remove and is left out of the subtotal', async () => {
      renderCart([HEADPHONES, { productId: PRODUCT_B, quantity: 3, product: null }]);
      const gone = await lineFor('Unavailable product');
      expect(within(gone).getByText('No longer available')).toBeInTheDocument();
      expect(within(gone).getAllByText('—').length).toBeGreaterThanOrEqual(2);
      expect(within(gone).getByRole('button', { name: 'Remove Unavailable product' })).toBeInTheDocument();
      const panel = within(summary());
      expect(panel.getByText('€39.98')).toBeInTheDocument();
      expect(panel.getByRole('link', { name: 'Checkout' })).toBeInTheDocument();
    });

    it('W03 AS-08: an out-of-stock product is labelled "Out of stock" but still counts in the subtotal', async () => {
      renderCart([{ ...HEADPHONES, inStock: false }]);
      const line = await lineFor('Headphones');
      expect(within(line).getByText('Out of stock')).toBeInTheDocument();
      expect(within(summary()).getByText('€39.98')).toBeInTheDocument();
      expect(within(summary()).getByRole('link', { name: 'Checkout' })).toBeInTheDocument();
    });
  });

  describe('loading, error and partial states', () => {
    it('W03 AS-09: while loading shows the heading and a skeleton announced as "Loading your cart"', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      server.use(
        http.get(`${origin}/api/bff/cart`, async () => {
          await gate;
          return HttpResponse.json({ lines: [], droppedLines: 0, errors: [] });
        }),
      );
      const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
      render(
        <QueryClientProvider client={client}>
          <CartView />
        </QueryClientProvider>,
      );
      expect(screen.getByRole('heading', { level: 1, name: 'Your cart' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Loading your cart');
      release();
      expect(await screen.findByText('Your cart is empty')).toBeInTheDocument();
    });

    it('W03 AS-09: a failed read shows an alert "We couldn\'t load your cart." and Try again reads it again', async () => {
      const backend = fakeCartBackend([HEADPHONES]);
      server.use(http.get(`${origin}/api/bff/cart`, () => HttpResponse.error(), { once: true }), ...backend.handlers);
      const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
      render(
        <QueryClientProvider client={client}>
          <CartView />
        </QueryClientProvider>,
      );
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("We couldn't load your cart.");
      await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('group', { name: 'Quantity of Headphones' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('W03 AS-09: a 5xx shows the generic form with its reference, never the server text', async () => {
      server.use(http.get(`${origin}/api/bff/cart`, () => problemResponse(503, 'unavailable', { requestId: 'req-77' })));
      const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
      render(
        <QueryClientProvider client={client}>
          <CartView />
        </QueryClientProvider>,
      );
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Something went wrong. Try again.');
      expect(alert).toHaveTextContent('Reference: req-77');
      expect(alert).not.toHaveTextContent(/Server (title|detail)/);
      expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('W03 AS-09: a 429 says when to try again', async () => {
      server.use(http.get(`${origin}/api/bff/cart`, () => problemResponse(429, 'rate_limited', { retryAfter: 7 })));
      const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
      render(
        <QueryClientProvider client={client}>
          <CartView />
        </QueryClientProvider>,
      );
      expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 7 seconds.');
    });

    it('W03 AS-09: when the product details failed, lines keep quantity and Remove, the subtotal is unavailable and a banner offers Reload', async () => {
      const { backend } = renderCart(
        [
          { productId: PRODUCT_A, quantity: 2, product: null },
          { productId: PRODUCT_B, quantity: 1, product: null },
        ],
        { errors: [{ section: 'products', code: 'UPSTREAM_UNAVAILABLE', retryable: true }] },
      );
      const banner = await screen.findByText("Some product details couldn't be loaded.");
      const line = (await screen.findAllByRole('group', { name: /^Quantity of/ }))[0].closest('li') as HTMLElement;
      expect(within(line).getByText('Details unavailable right now')).toBeInTheDocument();
      expect(within(line).queryByText('No longer available')).not.toBeInTheDocument();
      expect(within(line).getByRole('textbox')).toHaveValue('2');
      expect(within(line).getByRole('button', { name: /^Remove/ })).toBeInTheDocument();
      expect(within(summary()).getByText('Subtotal unavailable')).toBeInTheDocument();
      expect(within(summary()).getByRole('link', { name: 'Checkout' })).toBeInTheDocument();

      const before = backend.reads.page;
      await userEvent.click(within(banner.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Reload' }));
      await waitFor(() => expect(backend.reads.page).toBeGreaterThan(before));
    });
  });

  describe('guest checkout', () => {
    it('W03 AS-10: a guest sees "Sign in to check out" linking to sign-in with a return to /checkout', async () => {
      mockAuthenticated = false;
      renderCart();
      await lineFor('Headphones');
      const link = within(summary()).getByRole('link', { name: 'Sign in to check out' });
      expect(link).toHaveAttribute('href', loginHref('/checkout'));
      expect(screen.queryByRole('link', { name: 'Checkout' })).not.toBeInTheDocument();
    });
  });

  describe('merge notice', () => {
    const notice = 'items from your guest cart couldn\'t be added because a cart holds at most 50 different items.';

    it('W03 AS-11: after a merge that dropped lines a status notice says how many, until it is dismissed', async () => {
      const { client } = renderCart();
      act(() => {
        client.setQueryData(queryKeys.cart.lastMerge(), { droppedLines: 3 });
      });
      const message = await screen.findByText(`3 ${notice}`);
      expect(message.closest('[role="status"]')).not.toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText(`3 ${notice}`)).not.toBeInTheDocument();
    });

    it('W03 AS-11: one dropped line reads in the singular', async () => {
      const { client } = renderCart();
      act(() => {
        client.setQueryData(queryKeys.cart.lastMerge(), { droppedLines: 1 });
      });
      expect(await screen.findByText(`1 item from your guest cart couldn't be added because a cart holds at most 50 different items.`)).toBeInTheDocument();
    });

    it('W03 AS-11: nothing is shown when no line was dropped', async () => {
      const { client } = renderCart();
      await lineFor('Headphones');
      act(() => {
        client.setQueryData(queryKeys.cart.lastMerge(), { droppedLines: 0 });
      });
      expect(screen.queryByText(/from your guest cart/)).not.toBeInTheDocument();
    });

    it('W03 AS-12: with no merge recorded the cart shows the member\'s own cart and no notice', async () => {
      renderCart();
      await lineFor('Headphones');
      expect(screen.queryByText(/from your guest cart/)).not.toBeInTheDocument();
    });
  });

  describe('money', () => {
    it('W03 AS-73: the subtotal is an exact integer sum formatted with the lines\' own currency', async () => {
      renderCart([
        { productId: PRODUCT_A, quantity: 1, title: 'A', priceMinor: 1099 },
        { productId: PRODUCT_B, quantity: 1, title: 'B', priceMinor: 2099 },
      ]);
      await lineFor('A');
      expect(within(summary()).getByText('€31.98')).toBeInTheDocument();
    });

    it('W03 AS-73: items in different currencies list one subtotal per currency with the "can\'t be bought together" note', async () => {
      renderCart([
        { productId: PRODUCT_A, quantity: 2, title: 'Headphones', priceMinor: 1999, currency: 'EUR' },
        { productId: PRODUCT_D, quantity: 1, title: 'Notebook', priceMinor: 500, currency: 'USD' },
      ]);
      const notebook = await lineFor('Notebook');
      expect(within(notebook).getAllByText('$5.00').length).toBeGreaterThanOrEqual(1);
      const panel = within(summary());
      expect(panel.getByText('€39.98')).toBeInTheDocument();
      expect(panel.getByText('$5.00')).toBeInTheDocument();
      expect(panel.getByText("Items in different currencies can't be bought together.")).toBeInTheDocument();
    });
  });
});
