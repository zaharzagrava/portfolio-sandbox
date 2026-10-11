'use client';

import { useQuery } from '@tanstack/react-query';
import {
  paymentAcceptedSchema,
  paymentSchema,
  type PaymentAccepted,
  type PaymentStatusValue,
  type PaymentView,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { apiClient } from './client';
import { parseBody } from './parse';
import { retryUnlessClientError } from './orders';

/** What the cache holds for a payment: the contract view without `clientSecret` (W03 AS-72). */
export type PaymentSummary = Omit<PaymentView, 'clientSecret'>;
export type { PaymentAccepted };

const TERMINAL_FRESH_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Payment states that no longer change on their own. `REFUND_PENDING` still moves to `REFUNDED`. */
export const isTerminalPayment = (status: PaymentStatusValue): boolean =>
  status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED' || status === 'REFUNDED';

/**
 * `POST /api/payments/intents` (S13). Sends exactly `{orderId, paymentMethodId}`: never an amount, a currency or card
 * fields. `key` is the pay attempt's `Idempotency-Key` (reused by a double press, a reload and a retry; FR-054).
 */
export async function createPaymentIntent(input: { orderId: string; paymentMethodId: string; key: string }): Promise<PaymentAccepted> {
  const { data } = await apiClient.post<unknown>(
    '/api/payments/intents',
    { orderId: input.orderId, paymentMethodId: input.paymentMethodId },
    { headers: { 'Idempotency-Key': input.key } },
  );
  return parseBody(paymentAcceptedSchema, data);
}

/** The payment id a `409 payment_already_exists` points at (AS-44), when the error carries a valid one. */
export function existingPaymentId(error: unknown): string | undefined {
  const value = (error as { response?: { data?: { existingPaymentId?: unknown } } } | null)?.response?.data?.existingPaymentId;
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

async function fetchPaymentView(paymentId: string): Promise<PaymentView> {
  const { data } = await apiClient.get<unknown>(`/api/payments/${encodeURIComponent(paymentId)}`);
  return parseBody(paymentSchema, data);
}

/** The payment without its secret. The secret is dropped here, before TanStack stores anything. */
export async function fetchPayment(paymentId: string): Promise<PaymentSummary> {
  const { clientSecret: _secret, ...summary } = await fetchPaymentView(paymentId);
  void _secret;
  return summary;
}

/**
 * The one-time read of the provider `clientSecret` (AS-40): a direct call whose result goes to the caller's memory only;
 * nothing is cached, stored, logged or put in a URL. `null` when no customer action is pending.
 */
export async function readClientSecret(paymentId: string): Promise<string | null> {
  const view = await fetchPaymentView(paymentId);
  return view.requiresAction ? view.clientSecret : null;
}

/** Follows one payment by id: fresh until terminal, then 60 s. The cache never holds `clientSecret`. */
export function usePayment(paymentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.payments.detail(paymentId ?? ''),
    queryFn: () => fetchPayment(paymentId as string),
    enabled: Boolean(paymentId),
    staleTime: (query) => (query.state.data && isTerminalPayment(query.state.data.status) ? TERMINAL_FRESH_MS : 0),
    retry: retryUnlessClientError,
  });
}
