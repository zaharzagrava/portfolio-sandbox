'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { orderPageResponseSchema, orderPageSchema, orderSchema, type OrderDto, type OrderPageDto, type OrderPageResponse } from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { apiClient } from './client';
import { ApiParseError, parseBody } from './parse';

/** Order states come from the contract (S10); the web package keeps no copy of the list. */
export type OrderStatus = OrderDto['status'];
export type { OrderDto, OrderPageDto, OrderPageResponse };

export const ORDERS_PAGE_SIZE = 20;
const TERMINAL_FRESH_MS = 60_000;

/** Only orders that have not been paid can be cancelled by the buyer (stock is released). */
export const isCancellable = (status: OrderStatus): boolean => status === 'PENDING' || status === 'RESERVED';

/** States that no longer change on their own: the detail may then be served from the cache for 60 s. */
export const isTerminalOrder = (status: OrderStatus): boolean => status === 'DELIVERED' || status === 'CANCELLED' || status === 'REFUNDED';

/** A 4xx answer will not change by asking again; network failures and 5xx get the app default. */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiParseError) return false;
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  return failureCount < 1;
}

export async function fetchOrdersPage(cursor?: string): Promise<OrderPageDto> {
  const { data } = await apiClient.get<unknown>('/api/orders', { params: { limit: ORDERS_PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
  return parseBody(orderPageSchema, data);
}

export async function fetchOrder(orderId: string): Promise<OrderPageResponse> {
  const { data } = await apiClient.get<unknown>(`/api/bff/orders/${encodeURIComponent(orderId)}`);
  return parseBody(orderPageResponseSchema, data);
}

export async function cancelOrder(orderId: string): Promise<OrderDto> {
  const { data } = await apiClient.post<unknown>(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {});
  return parseBody(orderSchema, data);
}

/** One keyset page of the member's history; the cursor lives in the URL (AS-51, AS-53). */
export function useOrdersPage(cursor?: string) {
  return useQuery({
    queryKey: queryKeys.orders.list({ cursor }),
    queryFn: () => fetchOrdersPage(cursor),
    retry: retryUnlessClientError,
  });
}

/** The order aggregate: order plus latest payment summary. Fresh until terminal, then 60 s (data-model). */
export function useOrder(orderId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.orders.detail(orderId ?? ''),
    queryFn: () => fetchOrder(orderId as string),
    enabled: Boolean(orderId),
    staleTime: (query) => (query.state.data && isTerminalOrder(query.state.data.order.status) ? TERMINAL_FRESH_MS : 0),
    retry: retryUnlessClientError,
  });
}

export function useCancelOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => cancelOrder(orderId),
    onSuccess: () => {
      // The list and the detail both show the status; the prefix covers every cached page and aggregate.
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.all });
    },
  });
}
