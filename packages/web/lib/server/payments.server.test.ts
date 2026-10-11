import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../vitest.setup';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === '__Host-bff-session' ? { value: 'opaque' } : undefined) }),
}));
vi.mock('@/lib/config', () => ({ config: { bffUrl: 'http://bff.test' } }));

import { getPaymentSummary } from './payments.server';

const PAYMENT_ID = 'c0a8f6b2-1d3e-4f5a-9b7c-2e4d6f8a0b1c';
const view = {
  id: PAYMENT_ID,
  orderId: '7f1c0b1e-8f5e-4d7e-9a53-0d6a5b1f2c01',
  status: 'PENDING',
  amountMinor: 2500,
  currency: 'EUR',
  failureCode: null,
  requiresAction: true,
  clientSecret: 'pi_secret_123',
  version: 1,
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T10:00:00.000Z',
};

describe('payments.server', () => {
  it('W03 AS-72: reads a payment as the member and never returns the clientSecret', async () => {
    let cookie: string | null = null;
    server.use(
      http.get(`http://bff.test/api/bff/f/payments/${PAYMENT_ID}`, ({ request }) => {
        cookie = request.headers.get('cookie');
        return HttpResponse.json(view);
      }),
    );
    const result = await getPaymentSummary(PAYMENT_ID);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('pi_secret_123');
    expect(cookie).toBe('__Host-bff-session=opaque');
  });

  it('W03 AS-35: a malformed id is not-found without a request; a 404 stays a value', async () => {
    expect(await getPaymentSummary('x')).toMatchObject({ ok: false, status: 404 });
    server.use(http.get(`http://bff.test/api/bff/f/payments/${PAYMENT_ID}`, () => HttpResponse.json({ code: 'payment_not_found' }, { status: 404 })));
    expect(await getPaymentSummary(PAYMENT_ID)).toMatchObject({ ok: false, status: 404, code: 'payment_not_found' });
  });
});
