import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { problemResponse } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { CancelOrderDialog } from './cancel-order-dialog';

const origin = 'http://localhost:3000';
const ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

let client: QueryClient;
function renderDialog() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const view = { current: null as HTMLButtonElement | null };
  render(
    <QueryClientProvider client={client}>
      <button type="button" ref={(node) => void (view.current = node)}>
        View
      </button>
      <CancelOrderDialog orderId={ID} returnFocus={() => view.current} />
    </QueryClientProvider>,
  );
  return { invalidate };
}

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
});

describe('Cancel order dialog', () => {
  it('W03 AS-54: opens with "Cancel this order?" and focus on Keep order; Keep order closes it and focus returns to Cancel', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Cancel this order?' })).toBeInTheDocument();
    expect(screen.getByText('The items go back on sale.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep order' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Keep order' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('W03 AS-54: confirming shows "Cancelling…", then a toast "Order cancelled", closes, and focus goes to the View link', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(`${origin}/api/orders/${ID}/cancel`, async () => {
        await gate;
        return HttpResponse.json({
          id: ID,
          status: 'CANCELLED',
          totalMinor: 100,
          currency: 'EUR',
          reservedUntil: null,
          createdAt: '2026-10-10T10:00:00.000Z',
          items: [],
          shopOrders: [],
          timeline: [],
        });
      }),
    );
    const { invalidate } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    release();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Order cancelled'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'View' })).toHaveFocus();
    expect(invalidate).toHaveBeenCalled();
  });

  it('W03 AS-54: 409 order_not_cancellable toasts "(it is now Paid)", closes and re-reads', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(`${origin}/api/orders/${ID}/cancel`, () =>
        HttpResponse.json({ code: 'order_not_cancellable', status: 409, currentStatus: 'PAID' }, { status: 409, headers: { 'content-type': 'application/problem+json' } }),
      ),
    );
    const { invalidate } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This order can't be cancelled any more (it is now Paid)."));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(invalidate).toHaveBeenCalled();
  });

  it('W03 AS-54: 404 order_not_found closes the dialog and re-reads the list', async () => {
    const user = userEvent.setup();
    server.use(http.post(`${origin}/api/orders/${ID}/cancel`, () => problemResponse(404, 'order_not_found')));
    const { invalidate } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("We couldn't find that order."));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(invalidate).toHaveBeenCalled();
  });

  it('W03 AS-54: 429 keeps the dialog open with the wait form and disables Cancel order', async () => {
    const user = userEvent.setup();
    server.use(http.post(`${origin}/api/orders/${ID}/cancel`, () => problemResponse(429, 'rate_limited', { retryAfter: 30 })));
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Try again in 30 seconds/);
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeDisabled();
  });

  it('W03 AS-54: any other problem is the generic form inside the dialog and the button works again', async () => {
    const user = userEvent.setup();
    server.use(http.post(`${origin}/api/orders/${ID}/cancel`, () => problemResponse(500, 'internal_error')));
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Try again.');
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeEnabled();
  });
});
