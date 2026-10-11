import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkoutBody, ORDER_ID, problemResponse } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';
import { buildCheckoutBody, postCheckout, type PostCheckoutInput } from './checkout';

const BASE = 'http://bff.test';
const KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b';
const OTHER_ORDER = '11111111-2222-4333-8444-555555555555';

let seen: Request[];
beforeEach(() => {
  seen = [];
});

const input = (overrides: Partial<PostCheckoutInput> = {}): PostCheckoutInput => ({
  baseUrl: BASE,
  key: KEY,
  expectedTotalMinor: 3998,
  headers: { cookie: '__Host-bff-session=s; __Host-bff-csrf=c', 'X-CSRF-Token': 'c' },
  ...overrides,
});

function accept(headers: Record<string, string> = {}, body: unknown = checkoutBody()) {
  server.use(
    http.post(`${BASE}/api/bff/f/checkout`, ({ request }) => {
      seen.push(request.clone());
      return HttpResponse.json(body as never, { status: 202, headers });
    }),
  );
}

describe('postCheckout (W03 UK3)', () => {
  it('W03 AS-17: a 202 gives the orderId from the body and ignores Location', async () => {
    accept({ Location: `/api/orders/${OTHER_ORDER}` });
    const result = await postCheckout(input());
    expect(result).toMatchObject({ ok: true, orderId: ORDER_ID, replayed: false });
    expect(result.ok && result.response).toEqual(checkoutBody());
  });

  it('W03 AS-21: Idempotency-Replayed: true is a success marked as replayed', async () => {
    accept({ 'Idempotency-Replayed': 'true' });
    expect(await postCheckout(input())).toMatchObject({ ok: true, orderId: ORDER_ID, replayed: true });
  });

  it('W03 AS-18: sends the Idempotency-Key, the CSRF header, the cookies and {expectedTotalMinor}; never Authorization', async () => {
    accept();
    await postCheckout(input());
    const request = seen[0];
    expect(new URL(request.url).pathname).toBe('/api/bff/f/checkout');
    expect(request.method).toBe('POST');
    expect(request.headers.get('idempotency-key')).toBe(KEY);
    expect(request.headers.get('x-csrf-token')).toBe('c');
    expect(request.headers.get('cookie')).toBe('__Host-bff-session=s; __Host-bff-csrf=c');
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.headers.get('content-type')).toContain('application/json');
    expect(await request.json()).toEqual({ expectedTotalMinor: 3998 });
  });

  it('W03 AS-19: the Idempotency-Key is mandatory: an empty key throws before any request', async () => {
    accept();
    await expect(postCheckout(input({ key: '' }))).rejects.toThrow(/idempotency/i);
    expect(seen).toHaveLength(0);
  });

  it('W03 AS-23: a 409 price_changed is a failure that carries status, code, request id and the body for extension parsing', async () => {
    server.use(
      http.post(`${BASE}/api/bff/f/checkout`, () => {
        const response = problemResponse(409, 'price_changed', { requestId: 'req-5' });
        return HttpResponse.json({ code: 'price_changed', requestId: 'req-5', currentTotalMinor: 4200, lines: [{ productId: OTHER_ORDER, unitPriceMinor: 2100 }] }, { status: 409, headers: response.headers });
      }),
    );
    const result = await postCheckout(input());
    expect(result).toMatchObject({ ok: false, status: 409, code: 'price_changed', requestId: 'req-5' });
    expect(!result.ok && result.body).toMatchObject({ currentTotalMinor: 4200 });
  });

  it('W03 AS-22: Retry-After is returned in seconds', async () => {
    server.use(http.post(`${BASE}/api/bff/f/checkout`, () => problemResponse(409, 'idempotency_in_flight', { retryAfter: 1 })));
    expect(await postCheckout(input())).toMatchObject({ ok: false, status: 409, code: 'idempotency_in_flight', retryAfterSeconds: 1 });
  });

  it('W03 AS-31: a 4xx detail is returned only as a plain string, a 5xx detail is dropped', async () => {
    server.use(http.post(`${BASE}/api/bff/f/checkout`, () => problemResponse(400, 'validation_failed', { detail: 'expectedTotalMinor must be an integer' })));
    expect(await postCheckout(input())).toMatchObject({ ok: false, status: 400, detail: 'expectedTotalMinor must be an integer' });
    server.use(http.post(`${BASE}/api/bff/f/checkout`, () => problemResponse(500, 'internal', { detail: 'select * from orders' })));
    const failure = await postCheckout(input());
    expect(failure).toMatchObject({ ok: false, status: 500 });
    expect(JSON.stringify(failure)).not.toContain('select');
  });

  it('W03 AS-31: a 5xx without a JSON body (a proxy page) is a failure with the status and no code', async () => {
    server.use(http.post(`${BASE}/api/bff/f/checkout`, () => new HttpResponse('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })));
    const failure = await postCheckout(input());
    expect(failure).toEqual({ ok: false, status: 502 });
  });

  it('W03 AS-30: a network failure is status 0', async () => {
    server.use(http.post(`${BASE}/api/bff/f/checkout`, () => HttpResponse.error()));
    expect(await postCheckout(input())).toEqual({ ok: false, status: 0 });
  });

  it('W03 AS-17: a 202 whose body is not a checkout response is a failure (invalid_response), not an order id', async () => {
    accept({}, { orderId: 'not-a-uuid' });
    expect(await postCheckout(input())).toMatchObject({ ok: false, status: 502, code: 'invalid_response' });
  });

  it('W03 AS-34: refCode is sent only when the request schema declares it', async () => {
    accept();
    await postCheckout(input({ refCode: 'FRIEND1' }));
    expect(await seen[0].json()).toEqual({ expectedTotalMinor: 3998 });
  });
});

describe('buildCheckoutBody (W03 UK3, AS-34)', () => {
  const declaring = { shape: { expectedTotalMinor: {}, refCode: {} } };
  const lacking = { shape: { expectedTotalMinor: {} } };

  it.each([
    ['schema lacks refCode, code given', lacking, { expectedTotalMinor: 5, refCode: 'X' }, { expectedTotalMinor: 5 }],
    ['schema declares refCode, code given', declaring, { expectedTotalMinor: 5, refCode: 'X' }, { expectedTotalMinor: 5, refCode: 'X' }],
    ['schema declares refCode, no code', declaring, { expectedTotalMinor: 5 }, { expectedTotalMinor: 5 }],
    ['schema declares refCode, null code', declaring, { expectedTotalMinor: 5, refCode: null }, { expectedTotalMinor: 5 }],
    ['schema declares refCode, empty code', declaring, { expectedTotalMinor: 5, refCode: '' }, { expectedTotalMinor: 5 }],
    ['no expected total', lacking, {}, {}],
    ['zero total is kept', lacking, { expectedTotalMinor: 0 }, { expectedTotalMinor: 0 }],
  ])('W03 AS-34: %s', (_label, schema, given, expected) => {
    expect(buildCheckoutBody(given, schema)).toEqual(expected);
  });

  it('W03 AS-34: the real checkoutRequestSchema does not declare refCode today (S10 H4), so it is never sent', () => {
    expect(buildCheckoutBody({ expectedTotalMinor: 1, refCode: 'X' })).toEqual({ expectedTotalMinor: 1 });
  });
});
