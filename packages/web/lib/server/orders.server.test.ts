import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../vitest.setup';

const cookieJar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === '__Host-bff-session' && cookieJar.value ? { value: cookieJar.value } : undefined) }),
}));
vi.mock('@/lib/config', () => ({ config: { bffUrl: 'http://bff.test' } }));

import { getOrderAggregate, getOrdersPage } from './orders.server';

const ORDER_ID = '7f1c0b1e-8f5e-4d7e-9a53-0d6a5b1f2c01';
const order = {
  id: ORDER_ID,
  status: 'RESERVED',
  totalMinor: 100,
  currency: 'EUR',
  reservedUntil: null,
  createdAt: '2026-10-11T10:00:00.000Z',
  items: [],
  shopOrders: [],
  timeline: [],
};

describe('orders.server', () => {
  beforeEach(() => {
    cookieJar.value = 'opaque';
  });

  it('W03 AS-35: reads the aggregate with only the session cookie, parsed by orderPageResponseSchema', async () => {
    let cookie: string | null = null;
    let auth: string | null = 'unset';
    server.use(
      http.get(`http://bff.test/api/bff/orders/${ORDER_ID}`, ({ request }) => {
        cookie = request.headers.get('cookie');
        auth = request.headers.get('authorization');
        return HttpResponse.json({ order, payment: null, errors: [] });
      }),
    );
    const result = await getOrderAggregate(ORDER_ID);
    expect(result).toMatchObject({ ok: true, data: { order: { id: ORDER_ID } } });
    expect(cookie).toBe('__Host-bff-session=opaque');
    expect(auth).toBeNull();
  });

  it('W03 AS-35: a malformed id is not-found without a request', async () => {
    expect(await getOrderAggregate('nope')).toEqual({ ok: false, status: 404, code: 'order_not_found' });
  });

  it('W03 AS-35: 404 order_not_found (foreign or unknown) is reported as a value', async () => {
    server.use(http.get(`http://bff.test/api/bff/orders/${ORDER_ID}`, () => HttpResponse.json({ code: 'order_not_found' }, { status: 404 })));
    expect(await getOrderAggregate(ORDER_ID)).toMatchObject({ ok: false, status: 404, code: 'order_not_found' });
  });

  it('W03 AS-35: no session cookie means 401 without a request', async () => {
    cookieJar.value = undefined;
    expect(await getOrderAggregate(ORDER_ID)).toMatchObject({ ok: false, status: 401 });
  });

  it('W03 AS-35: a body that breaks the contract is invalid_response', async () => {
    server.use(http.get(`http://bff.test/api/bff/orders/${ORDER_ID}`, () => HttpResponse.json({ order: 1 })));
    expect(await getOrderAggregate(ORDER_ID)).toMatchObject({ ok: false, status: 502, code: 'invalid_response' });
  });

  it('W03 AS-53: reads a history page through the forwarder with limit and cursor; 400 invalid_cursor is a value', async () => {
    let seen: URL | undefined;
    server.use(
      http.get('http://bff.test/api/bff/f/orders', ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ code: 'invalid_cursor' }, { status: 400 });
      }),
    );
    expect(await getOrdersPage('zzz')).toMatchObject({ ok: false, status: 400, code: 'invalid_cursor' });
    expect(seen?.searchParams.get('cursor')).toBe('zzz');
    expect(seen?.searchParams.get('limit')).toBe('20');
  });
});
