'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';

/** Checkout order state machine (SD-19): PENDING → RESERVED → PAID → FULFILLING → SHIPPED → DELIVERED. */
export type OrderStatus = 'PENDING' | 'RESERVED' | 'PAID' | 'FULFILLING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED';

export interface OrderSummary {
  id: string;
  status: OrderStatus;
  total: number | string; // cents (NUMERIC arrives as a string)
  createdAt: string;
}

export const ORDERS_QUERY_KEY = ['orders'] as const;

/** Only orders that haven't been paid can be cancelled by the buyer (stock is released). */
export const isCancellable = (status: OrderStatus) => status === 'PENDING' || status === 'RESERVED';

const OPEN: OrderStatus[] = ['PENDING', 'RESERVED', 'PAID', 'FULFILLING', 'SHIPPED'];

export function orderStats(orders: OrderSummary[]) {
  return {
    total: orders.length,
    open: orders.filter((o) => OPEN.includes(o.status)).length,
    delivered: orders.filter((o) => o.status === 'DELIVERED').length,
  };
}

export function useOrders() {
  return useQuery({
    queryKey: ORDERS_QUERY_KEY,
    // S10 contract: { items: [{ id, status, totalMinor, currency, createdAt }], nextCursor }; the list route arrives with
    // S10's reads story (US6) - until then the request fails and the page shows its error state.
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: (Omit<OrderSummary, 'total'> & { totalMinor: number })[] }>('/api/orders');
      return data.items.map(({ totalMinor, ...order }): OrderSummary => ({ ...order, total: totalMinor }));
    },
  });
}

export function useCancelOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => apiClient.post(`/api/orders/${orderId}/cancel`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ORDERS_QUERY_KEY }),
  });
}
