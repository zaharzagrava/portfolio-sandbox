import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const api = vi.hoisted(() => ({ fetchCartLines: vi.fn(), writeCartLine: vi.fn() }));
vi.mock('@/lib/api/cart', () => ({ ...api, MAX_LINE_QUANTITY: 20 }));

import { queryKeys } from '@/lib/query-keys';
import { BuyAgainButton } from './buy-again';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function renderButton(items: { productId: string; title: string; quantity: number }[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BuyAgainButton items={items} />
    </QueryClientProvider>,
  );
  return { client };
}

describe('W03 buy again', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchCartLines.mockResolvedValue({ lines: [{ productId: A, quantity: 19, addedAt: '2026-10-10T10:00:00.000Z' }] });
    api.writeCartLine.mockResolvedValue({ lines: [] });
  });

  it('W03 AS-59: writes each line in order with current + ordered quantity capped at 20, then toasts and opens the cart', async () => {
    const user = userEvent.setup();
    renderButton([
      { productId: A, title: 'Headphones', quantity: 3 },
      { productId: B, title: 'Speaker', quantity: 2 },
    ]);
    await user.click(screen.getByRole('button', { name: 'Buy these items again' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/cart'));
    expect(api.writeCartLine.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [A, 20],
      [B, 2],
    ]);
    expect(toast.success).toHaveBeenCalledWith('Items added to your cart');
  });

  it('W03 AS-59: failed lines are kept for the cart page, the other lines still go in and the cart opens', async () => {
    const user = userEvent.setup();
    api.writeCartLine.mockRejectedValueOnce(new Error('x')).mockResolvedValue({ lines: [] });
    const { client } = renderButton([
      { productId: A, title: 'Headphones', quantity: 1 },
      { productId: B, title: 'Speaker', quantity: 1 },
    ]);
    await user.click(screen.getByRole('button', { name: 'Buy these items again' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/cart'));
    expect(client.getQueryData(queryKeys.cart.buyAgainFailures())).toEqual(['Headphones']);
    expect(api.writeCartLine).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith('Items added to your cart');
  });

  it('W03 AS-59: when no line could be added there is no success toast, the cart still opens with the list', async () => {
    const user = userEvent.setup();
    api.writeCartLine.mockRejectedValue(new Error('x'));
    const { client } = renderButton([{ productId: A, title: 'Headphones', quantity: 1 }]);
    await user.click(screen.getByRole('button', { name: 'Buy these items again' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/cart'));
    expect(client.getQueryData(queryKeys.cart.buyAgainFailures())).toEqual(['Headphones']);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('W03 AS-59: a successful run clears an older failure list', async () => {
    const user = userEvent.setup();
    const { client } = renderButton([{ productId: B, title: 'Speaker', quantity: 1 }]);
    client.setQueryData(queryKeys.cart.buyAgainFailures(), ['Old']);
    await user.click(screen.getByRole('button', { name: 'Buy these items again' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/cart'));
    expect(client.getQueryData(queryKeys.cart.buyAgainFailures())).toEqual([]);
  });
});
