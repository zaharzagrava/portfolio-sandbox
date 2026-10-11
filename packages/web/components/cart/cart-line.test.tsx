import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { toast } from 'sonner';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { fakeCartBackend, type FakeLine } from '../../tests/msw/cart-backend';
import { PRODUCT_A, PRODUCT_B, problemResponse } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';
import { CartView } from './cart-view';

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ isAuthenticated: true, isLoading: false, user: null, status: 'authenticated' }) }));
vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/cart' }));

const PRODUCT_C = '5b4d0e1f-7c6a-4f81-9a9d-3e4f5a6b7c8d';
const HEADPHONES: FakeLine = { productId: PRODUCT_A, quantity: 2, title: 'Headphones', priceMinor: 1999 };
const CABLE: FakeLine = { productId: PRODUCT_B, quantity: 1, title: 'Cable', priceMinor: 500 };

function renderCart(lines: FakeLine[] = [HEADPHONES, CABLE]) {
  const backend = fakeCartBackend(lines);
  server.use(...backend.handlers);
  const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
  render(<CartView />, { wrapper });
  return backend;
}

const groupOf = (title: string) => screen.findByRole('group', { name: `Quantity of ${title}` });
const lineOf = (group: HTMLElement) => group.closest('li') as HTMLElement;

beforeEach(() => {
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
});
afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Cart line', () => {
  it('W03 AS-04: pressing + changes the quantity, the line total and the subtotal before the answer, and the control is busy until it settles', async () => {
    const backend = renderCart();
    const group = await groupOf('Headphones');
    const release = backend.hold();
    await userEvent.click(within(group).getByRole('button', { name: 'Increase quantity of Headphones' }));

    expect(within(group).getByRole('textbox', { name: 'Quantity of Headphones' })).toHaveValue('3');
    expect(within(lineOf(group)).getByText('€59.97')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Order summary' })).getByText('€64.97')).toBeInTheDocument();
    expect(group).toHaveAttribute('aria-busy', 'true');

    release();
    await waitFor(() => expect(group).toHaveAttribute('aria-busy', 'false'));
    expect(backend.puts).toEqual([{ productId: PRODUCT_A, quantity: 3 }]);
  });

  it('W03 AS-04: quick presses show every step at once and send only the first and the last value, in order', async () => {
    const backend = renderCart();
    const group = await groupOf('Headphones');
    const release = backend.hold();
    const plus = within(group).getByRole('button', { name: 'Increase quantity of Headphones' });
    await userEvent.click(plus);
    await userEvent.click(plus);
    await userEvent.click(plus);
    expect(within(group).getByRole('textbox')).toHaveValue('5');
    release();
    await waitFor(() => expect(group).toHaveAttribute('aria-busy', 'false'));
    expect(backend.puts.map((put) => put.quantity)).toEqual([3, 5]);
    expect(within(group).getByRole('textbox')).toHaveValue('5');
  });

  it('W03 AS-04: pressing − lowers the quantity by one', async () => {
    const backend = renderCart();
    const group = await groupOf('Headphones');
    await userEvent.click(within(group).getByRole('button', { name: 'Decrease quantity of Headphones' }));
    expect(within(group).getByRole('textbox')).toHaveValue('1');
    await waitFor(() => expect(backend.puts).toEqual([{ productId: PRODUCT_A, quantity: 1 }]));
  });

  it('W03 AS-05: Remove takes the line away at once and shows a status toast "Removed {title}" with Undo', async () => {
    const backend = renderCart();
    const group = await groupOf('Headphones');
    await userEvent.click(within(lineOf(group)).getByRole('button', { name: 'Remove Headphones' }));

    expect(screen.queryByRole('group', { name: 'Quantity of Headphones' })).not.toBeInTheDocument();
    const message = await screen.findByText('Removed Headphones');
    expect(message.closest('li')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await waitFor(() => expect(backend.puts).toEqual([{ productId: PRODUCT_A, quantity: 0 }]));
  });

  it('W03 AS-05: focus moves to the next line when a line is removed', async () => {
    renderCart();
    const group = await groupOf('Headphones');
    await userEvent.click(within(lineOf(group)).getByRole('button', { name: 'Remove Headphones' }));
    expect(screen.getByRole('link', { name: 'Cable' })).toHaveFocus();
  });

  it('W03 AS-05: focus moves to the heading when no line is left', async () => {
    renderCart([HEADPHONES]);
    const group = await groupOf('Headphones');
    await userEvent.click(within(lineOf(group)).getByRole('button', { name: 'Remove Headphones' }));
    expect(await screen.findByText('Your cart is empty')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Your cart' })).toHaveFocus();
  });

  it('W03 AS-05: Undo brings the line back with its previous quantity', async () => {
    const backend = renderCart();
    const group = await groupOf('Headphones');
    await userEvent.click(within(lineOf(group)).getByRole('button', { name: 'Remove Headphones' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    const back = await groupOf('Headphones');
    expect(within(back).getByRole('textbox')).toHaveValue('2');
    expect(backend.puts).toEqual([
      { productId: PRODUCT_A, quantity: 0 },
      { productId: PRODUCT_A, quantity: 2 },
    ]);
  });

  it('W03 AS-05: the undo toast stays for 8 seconds, then goes without any further request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const backend = renderCart();
    const group = await groupOf('Headphones');
    await user.click(within(lineOf(group)).getByRole('button', { name: 'Remove Headphones' }));
    await screen.findByText('Removed Headphones');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    expect(screen.getByText('Removed Headphones')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.queryByText('Removed Headphones')).not.toBeInTheDocument();
    expect(backend.puts).toEqual([{ productId: PRODUCT_A, quantity: 0 }]);
  });

  it('W03 AS-06: − is disabled at 1 (removal is the explicit Remove)', async () => {
    renderCart();
    const group = await groupOf('Cable');
    expect(within(group).getByRole('button', { name: 'Decrease quantity of Cable' })).toBeDisabled();
    expect(within(group).getByRole('button', { name: 'Increase quantity of Cable' })).toBeEnabled();
  });

  it('W03 AS-06: + is disabled at 20 and the hint "Maximum 20 per item" describes it', async () => {
    renderCart([{ productId: PRODUCT_C, quantity: 20, title: 'Charger', priceMinor: 900 }]);
    const group = await groupOf('Charger');
    const plus = within(group).getByRole('button', { name: 'Increase quantity of Charger' });
    expect(plus).toBeDisabled();
    expect(plus).toHaveAccessibleDescription('Maximum 20 per item');
    expect(within(lineOf(group)).getByText('Maximum 20 per item')).toBeVisible();
  });

  it('W03 AS-06: a typed number from 1 to 20 is sent when committed with Enter', async () => {
    const backend = renderCart();
    const group = await groupOf('Headphones');
    const field = within(group).getByRole('textbox', { name: 'Quantity of Headphones' });
    await userEvent.clear(field);
    await userEvent.type(field, '7{Enter}');
    expect(field).toHaveValue('7');
    await waitFor(() => expect(backend.puts).toEqual([{ productId: PRODUCT_A, quantity: 7 }]));
  });

  it('W03 AS-06: a typed number is also committed when the field loses focus', async () => {
    const backend = renderCart();
    const group = await groupOf('Headphones');
    const field = within(group).getByRole('textbox', { name: 'Quantity of Headphones' });
    await userEvent.clear(field);
    await userEvent.type(field, '9');
    await userEvent.tab();
    await waitFor(() => expect(backend.puts).toEqual([{ productId: PRODUCT_A, quantity: 9 }]));
  });

  it.each([['empty', ''], ['zero', '0'], ['too large', '21'], ['a decimal', '2.5'], ['text', 'abc']])(
    'W03 AS-06: %s reverts to the saved quantity and announces "Enter a quantity from 1 to 20"',
    async (_label, typed) => {
      const backend = renderCart();
      const group = await groupOf('Headphones');
      const field = within(group).getByRole('textbox', { name: 'Quantity of Headphones' });
      await userEvent.clear(field);
      if (typed) await userEvent.type(field, typed);
      await userEvent.keyboard('{Enter}');
      expect(field).toHaveValue('2');
      expect(within(lineOf(group)).getByRole('status')).toHaveTextContent('Enter a quantity from 1 to 20');
      expect(backend.puts).toEqual([]);
    },
  );

  it.each([
    ['cart_line_limit', () => problemResponse(422, 'cart_line_limit'), 'Your cart is full (50 different items). Remove one to add another.'],
    ['rate_limited with Retry-After', () => problemResponse(429, 'rate_limited', { retryAfter: 12 }), "You're changing the cart too fast. Try again in 12 seconds."],
    ['a network failure', () => HttpResponse.error(), "You're offline. The change wasn't saved."],
    ['any other problem', () => problemResponse(500, 'internal'), 'Something went wrong. Try again.'],
  ])('W03 AS-07: %s shows its copy in an alert toast and rolls the displayed values back', async (_label, respond, copy) => {
    const backend = renderCart();
    const group = await groupOf('Headphones');
    backend.failNext(respond);
    await userEvent.click(within(group).getByRole('button', { name: 'Increase quantity of Headphones' }));

    const message = await screen.findByText(copy);
    expect(message.closest('li')).toHaveAttribute('role', 'alert');
    await waitFor(() => expect(within(group).getByRole('textbox')).toHaveValue('2'));
    expect(within(lineOf(group)).getByText('€39.98')).toBeInTheDocument();
  });

  it('W03 AS-07: the server\'s own title and detail never reach the screen', async () => {
    const backend = renderCart();
    const group = await groupOf('Headphones');
    backend.failNext(() => problemResponse(422, 'cart_line_limit'));
    await userEvent.click(within(group).getByRole('button', { name: 'Increase quantity of Headphones' }));
    await screen.findByText('Your cart is full (50 different items). Remove one to add another.');
    expect(screen.queryByText(/Server (title|detail)/)).not.toBeInTheDocument();
  });
});
