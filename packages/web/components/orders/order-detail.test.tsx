import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderPageResponse } from '@marketplace-sandbox/contracts';
import { setSessionPresence } from '@/lib/api/session-presence';
import { queryKeys } from '@/lib/query-keys';
import { resetUserStream } from '@/lib/realtime/user-stream';
import { formatMoney } from '@/lib/utils';
import { installEventSourceStub, type EventSourceStub } from '@/tests/stubs/event-source';
import { ORDER_ID, orderBody, PRODUCT_A, PRODUCT_B, problemResponse, SHOP_A } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OrderDetail } from './order-detail';

const origin = 'http://localhost:3000';
const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SHOP_B = '8d2e0b3f-1c4a-4d6e-9f70-3b4c5d6e7f80';
const PAYMENT_ID = 'c0a8f6b2-1d3e-4f5a-9b7c-2e4d6f8a0b1c';
type Status = OrderPageResponse['order']['status'];
type Payment = NonNullable<OrderPageResponse['payment']>;

const payment = (over: Partial<Payment> = {}): Payment => ({
  id: PAYMENT_ID,
  status: 'COMPLETED',
  amountMinor: 5498,
  currency: 'EUR',
  failureCode: null,
  requiresAction: false,
  version: 2,
  updatedAt: '2026-10-10T10:05:00.000Z',
  ...over,
});

function aggregate(status: Status = 'RESERVED', over: Partial<OrderPageResponse> = {}): OrderPageResponse {
  return {
    order: orderBody({
      status,
      totalMinor: 5498,
      items: [
        { productId: PRODUCT_A, shopId: SHOP_A, title: 'Headphones', quantity: 2, unitPriceMinor: 1999, discountMinor: 0, lineTotalMinor: 3998 },
        { productId: PRODUCT_B, shopId: SHOP_B, title: '<i>Cable</i>', quantity: 1, unitPriceMinor: 1500, discountMinor: 0, lineTotalMinor: 1500 },
      ],
      shopOrders: [
        { id: '5a5a5a5a-1111-4111-8111-5a5a5a5a5a5a', shopId: SHOP_A, subtotalMinor: 3998, status: 'PENDING' },
        { id: '6b6b6b6b-2222-4222-8222-6b6b6b6b6b6b', shopId: SHOP_B, subtotalMinor: 1500, status: 'PAID' },
      ],
      timeline:
        status === 'CANCELLED'
          ? [
              { status: 'CANCELLED', reason: 'hold_expired', at: '2026-10-10T10:20:00.000Z' },
              { status: 'RESERVED', reason: null, at: '2026-10-10T10:00:00.000Z' },
            ]
          : [{ status: 'RESERVED', reason: null, at: '2026-10-10T10:00:00.000Z' }],
    }),
    payment: null,
    errors: [],
    ...over,
  };
}

let backend: OrderPageResponse;
let reads = 0;
let client: QueryClient;
let stream: EventSourceStub;

function renderDetail(seed?: OrderPageResponse) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.auth.session(), { id: USER, email: 'a@b.co', role: 'USER' });
  if (seed) client.setQueryData(queryKeys.orders.detail(ORDER_ID), seed);
  return render(
    <QueryClientProvider client={client}>
      <OrderDetail orderId={ORDER_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setSessionPresence(() => false);
  stream = installEventSourceStub();
  reads = 0;
  backend = aggregate();
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  server.use(
    http.get(`${origin}/api/bff/orders/:id`, () => {
      reads += 1;
      return HttpResponse.json(backend);
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  resetUserStream();
  stream.restore();
});

describe('Order detail', () => {
  it('W03 AS-55: shows number, status text, placed date, lines by shop with subtotals and shop-order status, total and product links', async () => {
    backend = aggregate('PAID', { payment: payment() });
    renderDetail(backend);
    expect(await screen.findByRole('heading', { level: 1, name: `Order #${ORDER_ID.slice(0, 8).toUpperCase()}` })).toBeInTheDocument();
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0);
    expect(document.querySelector('time[datetime="2026-10-10T10:00:00.000Z"]')).not.toBeNull();
    const shops = screen.getAllByRole('region', { name: /^Shop \d$/ });
    expect(shops).toHaveLength(2);
    expect(within(shops[0]).getByRole('link', { name: 'Headphones' })).toHaveAttribute('href', `/products/${PRODUCT_A}`);
    // the line total and the shop subtotal are both this amount
    expect(within(shops[0]).getAllByText(formatMoney(3998, 'EUR'))).toHaveLength(2);
    expect(within(shops[0]).getByText('Processing')).toBeInTheDocument();
    expect(within(shops[1]).getByText('Paid')).toBeInTheDocument();
    expect(within(shops[1]).getAllByText(formatMoney(1500, 'EUR'))).toHaveLength(2);
    expect(screen.getByText('Total').closest('dl')).toHaveTextContent(formatMoney(5498, 'EUR'));
  });

  it('W03 AS-73: a product title with HTML is shown as text', async () => {
    renderDetail(backend);
    const link = await screen.findByRole('link', { name: '<i>Cable</i>' });
    expect(link.querySelector('i')).toBeNull();
  });

  it('W03 AS-55: the timeline is an ordered list, oldest first, with reason sentences and times', async () => {
    backend = aggregate('CANCELLED');
    renderDetail(backend);
    const list = await screen.findByRole('list', { name: 'Order timeline' });
    const entries = within(list).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Awaiting payment');
    expect(entries[1]).toHaveTextContent('Cancelled');
    expect(entries[1]).toHaveTextContent('The reservation ended before payment.');
    expect(entries[1].querySelector('time')).toHaveAttribute('datetime', '2026-10-10T10:20:00.000Z');
  });

  it('W03 AS-55: RESERVED offers Pay now (to the pay step) and Cancel', async () => {
    renderDetail(backend);
    expect(await screen.findByRole('link', { name: 'Pay now' })).toHaveAttribute('href', `/checkout/pay/${ORDER_ID}`);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buy these items again' })).toBeNull();
  });

  it('W03 AS-55: CANCELLED offers Buy these items again and no Pay now or Cancel', async () => {
    backend = aggregate('CANCELLED');
    renderDetail(backend);
    expect(await screen.findByRole('button', { name: 'Buy these items again' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pay now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it.each(['PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'REFUNDED'] as const)('W03 AS-55: a %s order offers no order action', async (status) => {
    backend = aggregate(status);
    renderDetail(backend);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('link', { name: 'Pay now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Buy these items again' })).toBeNull();
  });

  it('W03 AS-55: the payment panel shows the payment status text and amount', async () => {
    backend = aggregate('PAID', { payment: payment({ status: 'REFUND_PENDING' }) });
    renderDetail(backend);
    const panel = await screen.findByRole('region', { name: 'Payment' });
    expect(panel).toHaveTextContent('Refund on its way');
    expect(panel).toHaveTextContent(formatMoney(5498, 'EUR'));
  });

  it('W03 AS-56: payment null with a payment error says it is unavailable and Reload re-reads', async () => {
    backend = aggregate('RESERVED', { errors: [{ section: 'payment', code: 'UPSTREAM_UNAVAILABLE', retryable: true }] });
    renderDetail(backend);
    const panel = await screen.findByRole('region', { name: 'Payment' });
    expect(panel).toHaveTextContent('Payment details are unavailable right now.');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    const before = reads;
    await userEvent.setup().click(within(panel).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it('W03 AS-56: payment null without an error shows no payment panel and no error', async () => {
    renderDetail(backend);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Payment' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W03 AS-57: while loading, a skeleton is announced as "Loading order"', () => {
    renderDetail();
    expect(screen.getByRole('status')).toHaveTextContent('Loading order');
  });

  it('W03 AS-57: a failed read shows an alert with Try again', async () => {
    server.use(http.get(`${origin}/api/bff/orders/:id`, () => problemResponse(400, 'validation_failed')));
    renderDetail();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("We couldn't load your order.");
    server.use(http.get(`${origin}/api/bff/orders/:id`, () => HttpResponse.json(backend)));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: /^Order #/ })).toBeInTheDocument();
  });

  it('W03 AS-58: a live order.status re-reads the order and announces the new status once', async () => {
    renderDetail(backend);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(stream.all.length).toBeGreaterThan(0));
    backend = aggregate('PAID');
    const before = reads;
    act(() => {
      stream.last().open();
      stream.last().emit('order.status', { topic: `user:${USER}`, data: { orderId: ORDER_ID, status: 'PAID', orderVersion: 2 } });
    });
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Pay now' })).toBeNull());
    const live = screen.getAllByRole('status').filter((node) => node.textContent?.includes('is now'));
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveTextContent(`Order #${ORDER_ID.slice(0, 8).toUpperCase()} is now Paid`);
  });
});
