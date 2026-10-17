'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  sellerOverviewResponseSchema,
  shopListItemSchema,
  shopSchema,
  pageSchema,
  type SellerOverviewResponse,
  type ShopDto,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { apiClient } from './client';
import { parseBody } from './parse';
import { retryUnlessClientError } from './orders';

export type { ShopPermission } from '@/lib/seller/permissions';
export type { SellerOverviewResponse, ShopDto };

const shopPageSchema = pageSchema(shopListItemSchema);
export type ShopListPage = ReturnType<typeof shopPageSchema.parse>;
export type ShopListItem = ShopListPage['items'][number];

/** The shop switcher lists this many shops and links to the picker for more (W04 edge cases). */
export const SWITCHER_LIMIT = 50;

export async function fetchShop(shopId: string): Promise<ShopDto> {
  const { data } = await apiClient.get<unknown>(`/api/shops/${encodeURIComponent(shopId)}`);
  return parseBody(shopSchema, data);
}

export async function fetchMyShops(cursor?: string, limit = SWITCHER_LIMIT): Promise<ShopListPage> {
  const { data } = await apiClient.get<unknown>('/api/shops/mine', { params: { limit, ...(cursor ? { cursor } : {}) } });
  return parseBody(shopPageSchema, data);
}

/** One composed answer: the shop plus `stats`, `today` and `rank`, each of which may be missing with an `errors[]` entry. */
export async function fetchOverview(shopId: string, days: number): Promise<SellerOverviewResponse> {
  const { data } = await apiClient.get<unknown>(`/api/bff/seller/${encodeURIComponent(shopId)}/overview`, { params: { days } });
  return parseBody(sellerOverviewResponseSchema, data);
}

export async function openShop(input: { name: string; slug: string }): Promise<ShopDto> {
  const { data } = await apiClient.post<unknown>('/api/shops', input);
  return parseBody(shopSchema, data);
}

/** `GET /shops/{shopId}`; seeded from the server render. The API decides who may read it: this only presents. */
export function useShop(shopId: string, initialData?: ShopDto) {
  return useQuery({
    queryKey: queryKeys.seller.shop(shopId),
    queryFn: () => fetchShop(shopId),
    initialData,
    retry: retryUnlessClientError,
  });
}

export function useMyShops(options: { cursor?: string; initialData?: ShopListPage } = {}) {
  return useQuery({
    queryKey: queryKeys.seller.shops(),
    queryFn: () => fetchMyShops(options.cursor),
    initialData: options.initialData,
    retry: retryUnlessClientError,
  });
}

const OVERVIEW_STALE_MS = 10_000;

/** The overview answer for one period. The caller keeps the previous period's data on screen while the next loads. */
export function useOverview(shopId: string, days: number, initialData?: SellerOverviewResponse) {
  return useQuery({
    queryKey: queryKeys.seller.overview(shopId, { days }),
    queryFn: () => fetchOverview(shopId, days),
    placeholderData: keepPreviousData,
    // The server render already read it: do not read it again on mount. The live panel and "Try again" invalidate it.
    staleTime: OVERVIEW_STALE_MS,
    initialData,
    retry: retryUnlessClientError,
  });
}

/** `POST /shops {name, slug}`; one request at a time (a second `mutate` while pending is the caller's to ignore). */
export function useOpenShop() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: openShop,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.shops() }),
  });
}
