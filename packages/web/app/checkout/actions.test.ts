import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BFF_COOKIES, BFF_CSRF_HEADER } from '@marketplace-sandbox/contracts';
import { checkoutBody, ORDER_ID, PRODUCT_A, PRODUCT_B, problemResponse } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';

const jar: Record<string, string> = {};
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock('@/lib/server/endpoints.server', () => ({ bffUrl: () => 'http://bff.test' }));

// The two seams the tests force: the referral code W02 will supply, and whether the contract schema declares `refCode`.
const seam = vi.hoisted(() => ({ refCode: null as string | null, refCodeThrows: false, schemaDeclaresRefCode: false }));
vi.mock('@/lib/server/ref-code.server', () => ({
  readRefCode: async () => {
    if (seam.refCodeThrows) throw new Error('cookie store broke');
    return seam.refCode;
  },
}));
vi.mock('@marketplace-sandbox/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@marketplace-sandbox/contracts')>();
  const withRefCode = actual.checkoutRequestSchema.extend({ ref: (await import('zod')).z.string().optional() });
  return {
    ...actual,
    get checkoutRequestSchema() {
      return seam.schemaDeclaresRefCode ? withRefCode : actual.checkoutRequestSchema.omit({ ref: true });
    },
  };
});

import { placeOrder } from './actions';

const KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b';
const URL = 'http://bff.test/api/bff/f/checkout';
let seen: Request[];

function answer(handler: () => Response) {
  server.use(
    http.post(URL, ({ request }) => {
      seen.push(request.clone());
      return handler();
    }),
  );
}

beforeEach(() => {
  seen = [];
  seam.refCode = null;
  seam.refCodeThrows = false;
  seam.schemaDeclaresRefCode = false;
  for (const name of Object.keys(jar)) delete jar[name];
  jar[BFF_COOKIES.session] = 'session-value';
  jar[BFF_COOKIES.csrf] = 'csrf-value';
  answer(() => HttpResponse.json(checkoutBody(), { status: 202, headers: { location: `/orders/${ORDER_ID}` } }));
});
afterEach(() => vi.restoreAllMocks());

describe('Order creation function (W03 UK3)', () => {
  it('W03 AS-34: sends the Idempotency-Key and the CSRF header, forwards the session, and reads orderId from the 202 body', async () => {
    const result = await placeOrder({ key: KEY, expectedTotalMinor: 3998 });
    expect(result).toEqual({ ok: true, orderId: ORDER_ID, replayed: false });
    const request = seen[0];
    expect(request.headers.get('idempotency-key')).toBe(KEY);
    expect(request.headers.get(BFF_CSRF_HEADER)).toBe('csrf-value');
    expect(request.headers.get('cookie')).toContain(`${BFF_COOKIES.session}=session-value`);
    expect(await request.json()).toEqual({ expectedTotalMinor: 3998 });
  });

  it('W03 AS-21: a 202 with Idempotency-Replayed: true is a success with replayed true', async () => {
    answer(() => HttpResponse.json(checkoutBody(), { status: 202, headers: { 'idempotency-replayed': 'true' } }));
    expect(await placeOrder({ key: KEY, expectedTotalMinor: 3998 })).toEqual({ ok: true, orderId: ORDER_ID, replayed: true });
  });

  it('W03 AS-34: refCode is not sent when checkoutRequestSchema does not declare it, even if a code exists', async () => {
    seam.refCode = 'REF-123';
    seam.schemaDeclaresRefCode = false;
    await placeOrder({ key: KEY, expectedTotalMinor: 100 });
    expect(await seen[0].json()).toEqual({ expectedTotalMinor: 100 });
  });

  it('W03 AS-34: refCode is sent when the schema declares it and a code exists', async () => {
    seam.refCode = 'REF-123';
    seam.schemaDeclaresRefCode = true;
    await placeOrder({ key: KEY, expectedTotalMinor: 100 });
    expect(await seen[0].json()).toEqual({ expectedTotalMinor: 100, ref: 'REF-123' });
  });

  it('W03 AS-34: refCode is not sent when the schema declares it but there is no code', async () => {
    seam.refCode = null;
    seam.schemaDeclaresRefCode = true;
    await placeOrder({ key: KEY, expectedTotalMinor: 100 });
    expect(await seen[0].json()).toEqual({ expectedTotalMinor: 100 });
  });

  it('W03 AS-34: a failing referral lookup never stops the order', async () => {
    seam.schemaDeclaresRefCode = true;
    seam.refCodeThrows = true;
    expect(await placeOrder({ key: KEY, expectedTotalMinor: 100 })).toMatchObject({ ok: true });
    expect(await seen[0].json()).toEqual({ expectedTotalMinor: 100 });
  });

  it('W03 AS-23: price_changed carries currentTotalMinor and the changed lines', async () => {
    answer(() =>
      HttpResponse.json(
        { code: 'price_changed', requestId: 'r-1', currentTotalMinor: 4500, lines: [{ productId: PRODUCT_A, unitPriceMinor: 2250 }] },
        { status: 409 },
      ),
    );
    expect(await placeOrder({ key: KEY, expectedTotalMinor: 3998 })).toMatchObject({
      ok: false,
      problem: { status: 409, code: 'price_changed', requestId: 'r-1', currentTotalMinor: 4500, lines: [{ productId: PRODUCT_A, unitPriceMinor: 2250 }] },
    });
  });

  it('W03 AS-24: out_of_stock carries productIds and flashSaleId', async () => {
    answer(() => HttpResponse.json({ code: 'out_of_stock', productIds: [PRODUCT_A, PRODUCT_B], flashSaleId: 'fs-1' }, { status: 422 }));
    expect(await placeOrder({ key: KEY, expectedTotalMinor: 1 })).toMatchObject({
      ok: false,
      problem: { status: 422, code: 'out_of_stock', productIds: [PRODUCT_A, PRODUCT_B], flashSaleId: 'fs-1' },
    });
  });

  it('W03 AS-25: product_unavailable carries productIds', async () => {
    answer(() => HttpResponse.json({ code: 'product_unavailable', productIds: [PRODUCT_B] }, { status: 422 }));
    expect(await placeOrder({ key: KEY, expectedTotalMinor: 1 })).toMatchObject({ ok: false, problem: { code: 'product_unavailable', productIds: [PRODUCT_B] } });
  });

  it('W03 AS-22: a 409 idempotency_in_flight carries retryAfter seconds from Retry-After', async () => {
    answer(() => problemResponse(409, 'idempotency_in_flight', { retryAfter: 3 }));
    expect(await placeOrder({ key: KEY, expectedTotalMinor: 1 })).toMatchObject({ ok: false, problem: { status: 409, code: 'idempotency_in_flight', retryAfter: 3 } });
  });

  it('W03 AS-29: a 429 rate_limited carries retryAfter', async () => {
    answer(() => problemResponse(429, 'rate_limited', { retryAfter: 42 }));
    const result = await placeOrder({ key: KEY, expectedTotalMinor: 1 });
    expect(result).toMatchObject({ ok: false, problem: { status: 429, code: 'rate_limited', retryAfter: 42 } });
  });

  it('W03 AS-31: a body that lacks what its code promises gives a problem without extras, never an error', async () => {
    answer(() => HttpResponse.json({ code: 'price_changed', currentTotalMinor: 'x' }, { status: 409 }));
    const result = await placeOrder({ key: KEY, expectedTotalMinor: 1 });
    expect(result).toMatchObject({ ok: false, problem: { status: 409, code: 'price_changed' } });
    expect(result.ok === false && result.problem.currentTotalMinor).toBeFalsy();
  });

  it('W03 AS-31: a 4xx plain-string detail is returned, a 5xx detail never is, and the reference stays', async () => {
    answer(() => problemResponse(400, 'validation_failed', { detail: 'expectedTotalMinor must be an integer' }));
    expect(await placeOrder({ key: KEY, expectedTotalMinor: 1 })).toMatchObject({ ok: false, problem: { status: 400, detail: 'expectedTotalMinor must be an integer', requestId: 'req-test-1' } });
    answer(() => problemResponse(500, 'internal_error', { detail: 'SELECT * FROM secrets' }));
    const failed = await placeOrder({ key: KEY, expectedTotalMinor: 1 });
    expect(failed).toMatchObject({ ok: false, problem: { status: 500, requestId: 'req-test-1' } });
    expect(JSON.stringify(failed)).not.toContain('secrets');
  });

  it('W03 AS-30: a network failure is a problem with status 0, not a throw', async () => {
    server.use(http.post(URL, () => HttpResponse.error()));
    expect(await placeOrder({ key: KEY, expectedTotalMinor: 1 })).toMatchObject({ ok: false, problem: { status: 0 } });
  });

  it('W03 AS-32: without a session cookie the answer is a 401 problem and nothing is sent', async () => {
    delete jar[BFF_COOKIES.session];
    expect(await placeOrder({ key: KEY, expectedTotalMinor: 1 })).toMatchObject({ ok: false, problem: { status: 401, code: 'unauthenticated' } });
    expect(seen).toHaveLength(0);
  });

  it('W03 AS-19: an empty key is refused as a problem (never sent, never thrown)', async () => {
    const result = await placeOrder({ key: '', expectedTotalMinor: 1 });
    expect(result).toMatchObject({ ok: false, problem: { status: 400 } });
    expect(seen).toHaveLength(0);
  });

  it('W03 FR-011: malformed input from the browser (negative or fractional total) is refused as a problem', async () => {
    expect(await placeOrder({ key: KEY, expectedTotalMinor: -1 })).toMatchObject({ ok: false, problem: { status: 400 } });
    expect(await placeOrder({ key: KEY, expectedTotalMinor: 1.5 })).toMatchObject({ ok: false, problem: { status: 400 } });
    expect(await placeOrder(null as never)).toMatchObject({ ok: false, problem: { status: 400 } });
    expect(seen).toHaveLength(0);
  });
});
