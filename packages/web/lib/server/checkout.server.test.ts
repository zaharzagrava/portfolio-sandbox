import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BFF_COOKIES } from '@marketplace-sandbox/contracts';
import { checkoutBody, problemResponse } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';

const jar: Record<string, string> = {};
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) }),
}));
vi.mock('@/lib/server/endpoints.server', () => ({ bffUrl: () => 'http://bff.test' }));

import { submitCheckout } from './checkout.server';

const KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b';
let seen: Request[];

beforeEach(() => {
  seen = [];
  for (const name of Object.keys(jar)) delete jar[name];
  server.use(
    http.post('http://bff.test/api/bff/f/checkout', ({ request }) => {
      seen.push(request.clone());
      return HttpResponse.json(checkoutBody(), { status: 202 });
    }),
  );
});
afterEach(() => vi.restoreAllMocks());

describe('checkout.server (W03 UK3)', () => {
  it('W03 AS-34: forwards the session cookie and the CSRF cookie, echoes the CSRF value in X-CSRF-Token, and sends the key', async () => {
    jar[BFF_COOKIES.session] = 'sess value';
    jar[BFF_COOKIES.csrf] = 'csrf-token.value';
    const result = await submitCheckout({ key: KEY, expectedTotalMinor: 3998 });
    expect(result.ok).toBe(true);
    const request = seen[0];
    expect(request.headers.get('x-csrf-token')).toBe('csrf-token.value');
    expect(request.headers.get('cookie')).toBe(`${BFF_COOKIES.session}=sess value; ${BFF_COOKIES.csrf}=csrf-token.value`);
    expect(request.headers.get('idempotency-key')).toBe(KEY);
    expect(request.headers.get('authorization')).toBeNull();
    expect(await request.json()).toEqual({ expectedTotalMinor: 3998 });
  });

  it('W03 AS-32: without a session cookie it answers 401 unauthenticated and sends nothing', async () => {
    jar[BFF_COOKIES.csrf] = 'c';
    const result = await submitCheckout({ key: KEY, expectedTotalMinor: 1 });
    expect(result).toMatchObject({ ok: false, status: 401, code: 'unauthenticated' });
    expect(seen).toHaveLength(0);
  });

  it('W03 AS-32: without a CSRF cookie it answers csrf_invalid and sends nothing', async () => {
    jar[BFF_COOKIES.session] = 's';
    const result = await submitCheckout({ key: KEY, expectedTotalMinor: 1 });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'csrf_invalid' });
    expect(seen).toHaveLength(0);
  });

  it('W03 AS-31: a problem from the API is returned as a value, not thrown', async () => {
    jar[BFF_COOKIES.session] = 's';
    jar[BFF_COOKIES.csrf] = 'c';
    server.use(http.post('http://bff.test/api/bff/f/checkout', () => problemResponse(422, 'cart_empty', { requestId: 'r-1' })));
    expect(await submitCheckout({ key: KEY })).toMatchObject({ ok: false, status: 422, code: 'cart_empty', requestId: 'r-1' });
  });

  it('W03 AS-19: an empty key is refused by the API module (throws), never sent', async () => {
    jar[BFF_COOKIES.session] = 's';
    jar[BFF_COOKIES.csrf] = 'c';
    await expect(submitCheckout({ key: '' })).rejects.toThrow(/idempotency/i);
    expect(seen).toHaveLength(0);
  });
});
