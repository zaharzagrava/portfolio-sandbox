'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { shopOrderPageSchema, type ShopOrderPageDto } from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { listQuery, SHOP_ORDERS_PAGE_SIZE } from '@/lib/seller/wire';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

export type { ShopOrderPageDto };

export async function fetchShopOrders(shopId: string, params: { status?: string; cursor?: string }): Promise<ShopOrderPageDto> {
  const { data } = await apiClient.get<unknown>(`/api/shops/${encodeURIComponent(shopId)}/orders`, { params: listQuery(SHOP_ORDERS_PAGE_SIZE, params) });
  return parseBody(shopOrderPageSchema, data);
}

/** The shop's order slices, newest first. The buyer id is in the answer and is never shown (W04 AS-83). */
export function useShopOrders(shopId: string, params: { status?: string; cursor?: string } = {}, initialData?: ShopOrderPageDto) {
  return useQuery({
    queryKey: queryKeys.seller.orders(shopId, params),
    queryFn: () => fetchShopOrders(shopId, params),
    initialData,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}
