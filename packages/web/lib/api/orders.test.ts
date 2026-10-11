import type { ReactNode } from 'react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { setSessionPresence } from './session-presence';
import { cancelOrder, isCancellable, isTerminalOrder, useOrder, useOrdersPage } from './orders';

const origin = 'http://localhost:3000';
const ORDER_ID = '7f1c0b1e-8f5e-4d7e-9a53-0d6a5b1f2c01';
const PRODUCT_ID = '3b9c7e0a-6b1a-4a55-8d57-0a1c2f3d4e5f';
const SHOP_ID = '5d2c1b0a-9e8f-4a7b-8c6d-1e2f3a4b5c6d';

const order = (status = 'RESERVED') => ({
  id: ORDER_ID,
  status,
  totalMinor: 2500,
  currency: 'EUR',
  reservedUntil: '2026-10-11T10:15:00.000Z',
  createdAt: '2026-10-11T10:00:00.000Z',
  items: [{ productId: PRODUCT_ID, shopId: SHOP_ID, title: 'Mug', quantity: 1, unitPriceMinor: 2500, discountMinor: 0, lineTotalMinor: 2500 }],
  shopOrders: [{ id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', shopId: SHOP_ID, subtotalMinor: 2500, status: 'PENDING' }],
  timeline: [{ status: 'RESERVED', reason: null, at: '2026-10-11T10:00:00.000Z' }],
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, Wrapper };
}

describe('isCancellable', () => {
  it('W03 AS-54: only PENDING and RESERVED orders offer Cancel', () => {
    expect(isCancellable('PENDING')).toBe(true);
    expect(isCancellable('RESERVED')).toBe(true);
    for (const status of ['PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const) expect(isCancellable(status)).toBe(false);
  });
});

describe('isTerminalOrder', () => {
  it.each([
    ['PENDING', false],
    ['RESERVED', false],
    ['PAID', false],
    ['FULFILLING', false],
    ['SHIPPED', false],
    ['DELIVERED', true],
    ['CANCELLED', true],
    ['REFUNDED', true],
  ] as const)('W03 AS-71: %s terminal=%s (60 s freshness only once terminal)', (status, expected) => {
    expect(isTerminalOrder(status)).toBe(expected);
  });
});

describe('useOrdersPage', () => {
  it('W03 AS-51: reads one keyset page with limit and cursor and parses it with orderPageSchema', async () => {
    let seen: URL | undefined;
    let auth: string | null = 'unset';
    server.use(
      http.get(`${origin}/api/orders`, ({ request }) => {
        seen = new URL(request.url);
        auth = request.headers.get('authorization');
        return HttpResponse.json({ items: [{ id: ORDER_ID, status: 'PAID', totalMinor: 2500, currency: 'EUR', createdAt: '2026-10-11T10:00:00.000Z' }], nextCursor: 'abc' });
      }),
    );
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useOrdersPage('cur1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.nextCursor).toBe('abc');
    expect(result.current.data?.items[0]?.id).toBe(ORDER_ID);
    expect(seen?.searchParams.get('cursor')).toBe('cur1');
    expect(seen?.searchParams.get('limit')).toBe('20');
    expect(auth).toBeNull();
    expect(client.getQueryData(queryKeys.orders.list({ cursor: 'cur1' }))).toBeDefined();
  });

  it('W03 AS-51: no cursor means no cursor parameter (newest page)', async () => {
    let seen: URL | undefined;
    server.use(
      http.get(`${origin}/api/orders`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useOrdersPage(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(seen?.searchParams.has('cursor')).toBe(false);
  });

  it('W03 AS-53: 400 invalid_cursor surfaces as an error carrying the problem code, without retry', async () => {
    let calls = 0;
    server.use(
      http.get(`${origin}/api/orders`, () => {
        calls += 1;
        return HttpResponse.json({ code: 'invalid_cursor', status: 400 }, { status: 400 });
      }),
    );
    const { client } = wrapper();
    client.setDefaultOptions({ queries: { retry: 3 } });
    const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useOrdersPage('bad'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(calls).toBe(1);
    expect((result.current.error as { response?: { data?: { code?: string } } }).response?.data?.code).toBe('invalid_cursor');
  });

  it('W03 AS-51: a body that does not match the contract is an invalid_response error', async () => {
    server.use(http.get(`${origin}/api/orders`, () => HttpResponse.json({ items: [{ id: 'x' }] })));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useOrdersPage(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as { response?: { data?: { code?: string } } }).response?.data?.code).toBe('invalid_response');
  });
});

describe('useOrder', () => {
  it('W03 AS-55: reads the aggregate from /api/bff/orders/:id and parses it with orderPageResponseSchema', async () => {
    let auth: string | null = 'unset';
    server.use(
      http.get(`${origin}/api/bff/orders/${ORDER_ID}`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({ order: order(), payment: null, errors: [] });
      }),
    );
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useOrder(ORDER_ID), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.order.status).toBe('RESERVED');
    expect(result.current.data?.payment).toBeNull();
    expect(auth).toBeNull();
    expect(client.getQueryData(queryKeys.orders.detail(ORDER_ID))).toBeDefined();
  });

  it('W03 AS-57: 404 order_not_found is an error without retry (foreign and unknown look the same)', async () => {
    let calls = 0;
    server.use(
      http.get(`${origin}/api/bff/orders/${ORDER_ID}`, () => {
        calls += 1;
        return HttpResponse.json({ code: 'order_not_found', status: 404 }, { status: 404 });
      }),
    );
    const { client } = wrapper();
    client.setDefaultOptions({ queries: { retry: 3 } });
    const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useOrder(ORDER_ID), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(calls).toBe(1);
    expect((result.current.error as { response?: { status?: number } }).response?.status).toBe(404);
  });

  it('W03 AS-71: does not run without an id', () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useOrder(undefined), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('cancelOrder', () => {
  it('W03 AS-54: posts to /api/orders/:id/cancel and parses the order', async () => {
    setSessionPresence(() => false);
    let method = '';
    server.use(
      http.post(`${origin}/api/orders/${ORDER_ID}/cancel`, ({ request }) => {
        method = request.method;
        return HttpResponse.json(order('CANCELLED'));
      }),
    );
    const result = await cancelOrder(ORDER_ID);
    expect(method).toBe('POST');
    expect(result.status).toBe('CANCELLED');
  });

  it('W03 AS-54: 409 order_not_cancellable rejects with the problem for the dialog copy', async () => {
    setSessionPresence(() => false);
    server.use(http.post(`${origin}/api/orders/${ORDER_ID}/cancel`, () => HttpResponse.json({ code: 'order_not_cancellable', status: 409 }, { status: 409 })));
    await expect(cancelOrder(ORDER_ID)).rejects.toMatchObject({ response: { status: 409, data: { code: 'order_not_cancellable' } } });
  });
});
