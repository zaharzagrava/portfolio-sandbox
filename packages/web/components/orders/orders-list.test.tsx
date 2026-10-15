import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderPageDto } from '@marketplace-sandbox/contracts';
import { setSessionPresence } from '@/lib/api/session-presence';
import { queryKeys } from '@/lib/query-keys';
import { resetUserStream } from '@/lib/realtime/user-stream';
import { formatMoney } from '@/lib/utils';
import { installEventSourceStub, type EventSourceStub } from '@/tests/stubs/event-source';
import { problemResponse } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OrdersList } from './orders-list';

const origin = 'http://localhost:3000';
const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const A = '11111111-aaaa-4aaa-8aaa-111111111111';
const B = '22222222-bbbb-4bbb-8bbb-222222222222';
const C = '33333333-cccc-4ccc-8ccc-333333333333';
const OTHER = '44444444-dddd-4ddd-8ddd-444444444444';

type Item = OrderPageDto['items'][number];
const item = (id: string, status: Item['status'], over: Partial<Item> = {}): Item => ({
  id,
  status,
  totalMinor: 3998,
  currency: 'EUR',
  createdAt: '2026-10-10T10:00:00.000Z',
  ...over,
});

let page: OrderPageDto;
let reads = 0;
let lastCursor: string | null = null;
let client: QueryClient;
let stream: EventSourceStub;

function renderList(cursor?: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.auth.session(), { id: USER, email: 'a@b.co', role: 'USER' });
  return render(
    <QueryClientProvider client={client}>
      <OrdersList cursor={cursor} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setSessionPresence(() => false);
  stream = installEventSourceStub();
  reads = 0;
  lastCursor = null;
  page = { items: [item(A, 'RESERVED'), item(B, 'PAID', { totalMinor: 1500, currency: 'USD' }), item(C, 'CANCELLED')], nextCursor: null };
  server.use(
    http.get(`${origin}/api/orders`, ({ request }) => {
      reads += 1;
      lastCursor = new URL(request.url).searchParams.get('cursor');
      return HttpResponse.json(page);
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  resetUserStream();
  stream.restore();
});

const rowOf = async (id: string) => (await screen.findByText(`Order #${id.slice(0, 8).toUpperCase()}`)).closest('tr') as HTMLElement;

describe('Orders list', () => {
  it('W03 AS-51: shows the heading and one row per order with number, date, status text, total and View', async () => {
    renderList();
    expect(await screen.findByRole('heading', { level: 1, name: 'Your orders' })).toBeInTheDocument();
    const row = await rowOf(B);
    expect(screen.getByRole('table', { name: 'Your orders' })).toBeInTheDocument();
    expect(within(row).getByText('Paid')).toBeInTheDocument();
    expect(within(row).getByText(formatMoney(1500, 'USD'))).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'View order #22222222' })).toHaveAttribute('href', `/orders/${B}`);
    expect(row.querySelector('time')).toHaveAttribute('datetime', '2026-10-10T10:00:00.000Z');
    expect(screen.getAllByRole('row').slice(1).map((r) => r.getAttribute('data-order-id'))).toEqual([A, B, C]);
  });

  it('W03 AS-51: Pay now and Cancel only on RESERVED orders; Pay now links to the pay step', async () => {
    renderList();
    const reserved = await rowOf(A);
    expect(within(reserved).getByRole('link', { name: 'Pay now' })).toHaveAttribute('href', `/checkout/pay/${A}`);
    expect(within(reserved).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(reserved).getByText('Awaiting payment')).toBeInTheDocument();
    for (const id of [B, C]) {
      const other = await rowOf(id);
      expect(within(other).queryByRole('link', { name: 'Pay now' })).toBeNull();
      expect(within(other).queryByRole('button', { name: 'Cancel' })).toBeNull();
    }
  });

  it('W03 AS-51: every status shows its text', async () => {
    page = {
      items: (['PENDING', 'RESERVED', 'PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const).map((s, i) =>
        item(`0000000${i}-aaaa-4aaa-8aaa-111111111111`, s),
      ),
      nextCursor: null,
    };
    renderList();
    for (const text of ['Processing', 'Awaiting payment', 'Paid', 'Preparing', 'Shipped', 'Delivered', 'Cancelled', 'Refunded']) {
      expect(await screen.findByText(text)).toBeInTheDocument();
    }
  });

  it('W03 AS-52: an empty history says so and offers Browse products', async () => {
    page = { items: [], nextCursor: null };
    renderList();
    expect(await screen.findByText("You haven't placed any orders yet.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse products' })).toHaveAttribute('href', '/search');
  });

  it('W03 AS-52: while loading, a skeleton is announced as "Loading your orders"', () => {
    renderList();
    expect(screen.getByRole('status')).toHaveTextContent('Loading your orders');
    expect(screen.getByRole('heading', { level: 1, name: 'Your orders' })).toBeInTheDocument();
  });

  it('W03 AS-52: a failed read shows the alert and Try again reads again', async () => {
    server.use(http.get(`${origin}/api/orders`, () => problemResponse(500, 'internal_error')));
    renderList();
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert).toHaveTextContent("We couldn't load your orders.");
    server.use(http.get(`${origin}/api/orders`, () => HttpResponse.json(page)));
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(await rowOf(A)).toBeInTheDocument();
  });

  it('W03 AS-52: 429 shows the wait form and 5xx the generic form', async () => {
    server.use(http.get(`${origin}/api/orders`, () => problemResponse(429, 'rate_limited', { retryAfter: 30 })));
    renderList();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Try again in 30 seconds/);
  });

  it('W03 AS-53: Older orders carries the cursor in the URL; the first page has no Newest orders link', async () => {
    page = { ...page, nextCursor: 'abc123' };
    renderList();
    await rowOf(A);
    expect(screen.getByRole('link', { name: 'Older orders' })).toHaveAttribute('href', '/orders?cursor=abc123');
    expect(screen.queryByRole('link', { name: 'Newest orders' })).toBeNull();
  });

  it('W03 AS-53: a later page reads with its cursor and links back to the newest orders', async () => {
    renderList('abc123');
    await rowOf(A);
    expect(lastCursor).toBe('abc123');
    expect(screen.getByRole('link', { name: 'Newest orders' })).toHaveAttribute('href', '/orders');
    expect(screen.queryByRole('link', { name: 'Older orders' })).toBeNull();
  });

  it('W03 AS-53: a rejected cursor says the page is gone and offers Newest orders', async () => {
    server.use(http.get(`${origin}/api/orders`, () => problemResponse(400, 'invalid_cursor')));
    renderList('bad');
    expect(await screen.findByText('This page of orders is no longer available.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Newest orders' })).toHaveAttribute('href', '/orders');
  });

  describe('live status (AS-58)', () => {
    const emit = (orderId: string, status: string) =>
      act(() => {
        stream.last().open();
        stream.last().emit('order.status', { topic: `user:${USER}`, data: { orderId, status, orderVersion: 3 } });
      });

    it('W03 AS-58: an event for a listed order re-reads the list and announces the new status once', async () => {
      renderList();
      await rowOf(A);
      await waitFor(() => expect(stream.all.length).toBeGreaterThan(0));
      page = { ...page, items: [item(A, 'PAID'), ...page.items.slice(1)] };
      const before = reads;
      emit(A, 'PAID');
      await waitFor(() => expect(reads).toBe(before + 1));
      const row = await rowOf(A);
      await waitFor(() => expect(within(row).getByText('Paid')).toBeInTheDocument());
      const announcements = screen.getAllByRole('status').filter((node) => node.textContent?.includes('is now'));
      expect(announcements).toHaveLength(1);
      expect(announcements[0]).toHaveTextContent('Order #11111111 is now Paid');
    });

    it('W03 AS-58: an event for another order only refreshes its cached entry (no list read, no announcement)', async () => {
      renderList();
      await rowOf(A);
      await waitFor(() => expect(stream.all.length).toBeGreaterThan(0));
      client.setQueryData(queryKeys.orders.detail(OTHER), { order: {}, payment: null, errors: [] });
      const before = reads;
      emit(OTHER, 'PAID');
      await waitFor(() => expect(client.getQueryState(queryKeys.orders.detail(OTHER))?.isInvalidated).toBe(true));
      expect(reads).toBe(before);
      expect(screen.queryByText(/is now/)).toBeNull();
    });
  });
});
