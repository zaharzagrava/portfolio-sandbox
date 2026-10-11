import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { cartBody, PRODUCT_A, problemResponse } from '../tests/msw/handlers';
import { server } from '../vitest.setup';
import { AddToCartButton } from './add-to-cart-button';

const push = vi.fn();
const track = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/products/x' }));
vi.mock('@/lib/analytics/track', () => ({ track: (event: unknown) => track(event) }));

const origin = 'http://localhost:3000';
const line = (productId: string, quantity: number) => ({ productId, quantity, addedAt: '2026-10-10T10:00:00.000Z' });

/** A cart server that keeps one product's quantity and records the order of the requests it sees. */
function cartServer(initial: number) {
  let quantity = initial;
  const calls: string[] = [];
  const puts: number[] = [];
  let hold: Promise<void> | null = null;
  const body = () => cartBody({ lines: quantity > 0 ? [line(PRODUCT_A, quantity)] : [] });
  server.use(
    http.get(`${origin}/api/cart`, () => {
      calls.push('GET');
      return HttpResponse.json(body());
    }),
    http.put(`${origin}/api/cart/items/${PRODUCT_A}`, async ({ request }) => {
      const next = ((await request.json()) as { quantity: number }).quantity;
      calls.push('PUT');
      puts.push(next);
      if (hold) await hold;
      quantity = next;
      return HttpResponse.json(body());
    }),
  );
  return {
    calls,
    puts,
    holdWrites() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

function renderButton(props: Partial<React.ComponentProps<typeof AddToCartButton>> = {}) {
  const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
  return render(<AddToCartButton productId={PRODUCT_A} category="audio" {...props} />, { wrapper });
}

beforeEach(() => {
  push.mockReset();
  track.mockReset();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
});
afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  vi.restoreAllMocks();
});

describe('Add to cart button', () => {
  it('W03 AS-02: shows "Adding…" and stays disabled until the answer, then a status toast with a View cart action', async () => {
    const backend = cartServer(0);
    const release = backend.holdWrites();
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    const pending = await screen.findByRole('button', { name: 'Adding…' });
    expect(pending).toBeDisabled();
    expect(screen.queryByText('Added to cart')).not.toBeInTheDocument();
    release();
    const message = await screen.findByText('Added to cart');
    expect(message.closest('li')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'View cart' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeEnabled();
  });

  it('W03 AS-02: the View cart action opens the cart page', async () => {
    cartServer(0);
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    await userEvent.click(await screen.findByRole('button', { name: 'View cart' }));
    expect(push).toHaveBeenCalledWith('/cart');
  });

  it('W03 AS-02: reads the cart first and sends the current quantity plus one', async () => {
    const backend = cartServer(3);
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    await screen.findByText('Added to cart');
    expect(backend.calls.indexOf('GET')).toBeGreaterThanOrEqual(0);
    expect(backend.calls.indexOf('GET')).toBeLessThan(backend.calls.indexOf('PUT'));
    expect(backend.puts).toEqual([4]);
  });

  it('W03 AS-02: pressing again adds one more unit', async () => {
    const backend = cartServer(1);
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    await waitFor(() => expect(backend.puts).toEqual([2]));
    await screen.findByRole('button', { name: 'Add to cart' });
    await userEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    await waitFor(() => expect(backend.puts).toEqual([2, 3]));
  });

  it('W03 AS-75: one add_to_cart event per successful add, with product_id and category only', async () => {
    cartServer(0);
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    await screen.findByText('Added to cart');
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith({ name: 'add_to_cart', props: { product_id: PRODUCT_A, category: 'audio' } });
  });

  it('W03 AS-75: a refused add emits no event and explains itself in an alert toast', async () => {
    cartServer(0);
    server.use(http.put(`${origin}/api/cart/items/${PRODUCT_A}`, () => problemResponse(422, 'cart_line_limit')));
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    const message = await screen.findByText('Your cart is full (50 different items). Remove one to add another.');
    expect(message.closest('li')).toHaveAttribute('role', 'alert');
    expect(track).not.toHaveBeenCalled();
    expect(screen.queryByText('Added to cart')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeEnabled();
  });

  it('W03 AS-07: a network failure says the change was not saved', async () => {
    server.use(http.get(`${origin}/api/cart`, () => HttpResponse.error()));
    renderButton();
    await userEvent.click(screen.getByRole('button', { name: 'Add to cart' }));
    expect(await screen.findByText("You're offline. The change wasn't saved.")).toBeInTheDocument();
    expect(track).not.toHaveBeenCalled();
  });

  it('W03 AS-02: a product that is out of stock shows "Out of stock", is disabled and sends nothing', async () => {
    const backend = cartServer(0);
    renderButton({ disabled: true });
    const button = screen.getByRole('button', { name: 'Out of stock' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(backend.puts).toEqual([]);
  });

  it('W03 AS-02: at 20 units in the cart the button is disabled and says "Maximum 20 in cart"', async () => {
    const backend = cartServer(20);
    renderButton();
    const button = await screen.findByRole('button', { name: 'Maximum 20 in cart' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(backend.puts).toEqual([]);
  });
});
