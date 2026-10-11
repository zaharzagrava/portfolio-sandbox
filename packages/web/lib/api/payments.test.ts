import type { ReactNode } from 'react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { setSessionPresence } from './session-presence';
import { createPaymentIntent, existingPaymentId, isTerminalPayment, readClientSecret, usePayment } from './payments';

const origin = 'http://localhost:3000';
const ORDER_ID = '7f1c0b1e-8f5e-4d7e-9a53-0d6a5b1f2c01';
const PAYMENT_ID = 'c0a8f6b2-1d3e-4f5a-9b7c-2e4d6f8a0b1c';
const KEY = '11111111-2222-4333-8444-555555555555';

const payment = (over: Record<string, unknown> = {}) => ({
  id: PAYMENT_ID,
  orderId: ORDER_ID,
  status: 'PENDING',
  amountMinor: 2500,
  currency: 'EUR',
  failureCode: null,
  requiresAction: true,
  clientSecret: 'pi_secret_123',
  version: 2,
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T10:00:01.000Z',
  ...over,
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, Wrapper };
}

describe('payments api', () => {
  beforeEach(() => setSessionPresence(() => false));

  it('W03 AS-38: createPaymentIntent posts only {orderId, paymentMethodId} with the Idempotency-Key and parses paymentAcceptedSchema', async () => {
    let body: unknown;
    let key: string | null = null;
    let auth: string | null = 'unset';
    server.use(
      http.post(`${origin}/api/payments/intents`, async ({ request }) => {
        body = await request.json();
        key = request.headers.get('idempotency-key');
        auth = request.headers.get('authorization');
        return HttpResponse.json(
          { paymentId: PAYMENT_ID, orderId: ORDER_ID, status: 'PENDING', amountMinor: 2500, currency: 'EUR', createdAt: '2026-10-11T10:00:00.000Z' },
          { status: 202 },
        );
      }),
    );
    const accepted = await createPaymentIntent({ orderId: ORDER_ID, paymentMethodId: 'pm_card', key: KEY });
    expect(accepted.paymentId).toBe(PAYMENT_ID);
    expect(body).toEqual({ orderId: ORDER_ID, paymentMethodId: 'pm_card' });
    expect(key).toBe(KEY);
    expect(auth).toBeNull();
  });

  it('W03 AS-44: 409 payment_already_exists exposes the existing payment id; other errors expose none', async () => {
    server.use(
      http.post(`${origin}/api/payments/intents`, () => HttpResponse.json({ code: 'payment_already_exists', existingPaymentId: PAYMENT_ID }, { status: 409 })),
    );
    const error = await createPaymentIntent({ orderId: ORDER_ID, paymentMethodId: 'pm', key: KEY }).catch((e: unknown) => e);
    expect(existingPaymentId(error)).toBe(PAYMENT_ID);
    expect(existingPaymentId(new Error('x'))).toBeUndefined();
    expect(existingPaymentId({ response: { data: { existingPaymentId: 'not-a-uuid' } } })).toBeUndefined();
  });

  it('W03 AS-72: usePayment never puts the clientSecret into the query cache', async () => {
    server.use(http.get(`${origin}/api/payments/${PAYMENT_ID}`, () => HttpResponse.json(payment())));
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => usePayment(PAYMENT_ID), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).not.toHaveProperty('clientSecret');
    expect(result.current.data?.requiresAction).toBe(true);
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain('pi_secret_123');
    expect(client.getQueryData(queryKeys.payments.detail(PAYMENT_ID))).toBeDefined();
  });

  it('W03 AS-40: readClientSecret reads the secret once, outside the cache, only while customer action is pending', async () => {
    server.use(http.get(`${origin}/api/payments/${PAYMENT_ID}`, () => HttpResponse.json(payment())));
    expect(await readClientSecret(PAYMENT_ID)).toBe('pi_secret_123');
  });

  it('W03 AS-40: readClientSecret is null when the payment carries no secret', async () => {
    server.use(http.get(`${origin}/api/payments/${PAYMENT_ID}`, () => HttpResponse.json(payment({ clientSecret: null, requiresAction: false, status: 'COMPLETED' }))));
    expect(await readClientSecret(PAYMENT_ID)).toBeNull();
  });

  it('W03 AS-40: a malformed payment body is an invalid_response error, not a secret', async () => {
    server.use(http.get(`${origin}/api/payments/${PAYMENT_ID}`, () => HttpResponse.json({ clientSecret: 'x' })));
    await expect(readClientSecret(PAYMENT_ID)).rejects.toMatchObject({ response: { data: { code: 'invalid_response' } } });
  });

  it('W03 AS-71: usePayment does not run without an id', () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => usePayment(undefined), { wrapper: Wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it.each([
    ['PENDING', false],
    ['UNKNOWN', false],
    ['COMPLETED', true],
    ['FAILED', true],
    ['CANCELLED', true],
    ['REFUND_PENDING', false],
    ['REFUNDED', true],
  ] as const)('W03 AS-71: payment %s terminal=%s', (status, expected) => {
    expect(isTerminalPayment(status)).toBe(expected);
  });
});
