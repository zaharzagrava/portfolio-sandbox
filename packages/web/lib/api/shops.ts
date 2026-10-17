'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';

/** The longest search text `GET /api/shops/:shopId/products/search` accepts (S32). */
const SHOP_SEARCH_MAX = 100;

/** Multi-tenant shops (SD-02). Opening a shop makes the owner a SELLER (on the next token refresh). */
export interface MyShop {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER';
}

/** `GET /api/shops/:shopId/stats` (S40): the shop's figures over the last `days` UTC days; money in minor units. */
export interface SellerStats {
  shopId: string;
  days: number;
  from: string;
  to: string;
  currency: string;
  summary: {
    revenueMinor: number;
    orders: number;
    unitsSold: number;
    uniqueBuyers: number;
    refundsCount: number;
    refundedMinor: number;
    netRevenueMinor: number;
    avgOrderValueMinor: number;
  };
  daily: { day: string; revenueMinor: number; orders: number; refundedMinor: number }[];
  topProducts: { productId: string; title: string; revenueMinor: number; unitsSold: number }[];
}

/** `GET /api/shops/:shopId/rank` (S40): the shop's own place on a board; members only. */
export interface ShopRank {
  period: { kind: 'week' | 'month'; id: string; startsAt: string; endsAt: string; closed: boolean };
  category: string | null;
  rank: number;
  of: number;
  topPercent: number;
  revenueMinor: number;
}

export interface ShopProduct {
  id: string;
  title: string;
  price: number;
  quantity: number;
}

/** The server's slug rule: lowercase letters/digits/dashes, 3-40 chars, no leading/trailing dash. */
export const SHOP_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export const MY_SHOPS_KEY = ['shops', 'mine'] as const;

export function useMyShops(enabled = true) {
  return useQuery({ queryKey: MY_SHOPS_KEY, enabled, queryFn: async () => (await apiClient.get<{ items: MyShop[] }>('/api/shops/mine')).data.items });
}

export function useCreateShop() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; slug: string }) => (await apiClient.post<{ id: string }>('/api/shops', input)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MY_SHOPS_KEY }),
  });
}

export function useSellerStats(shopId: string | undefined, days = 30) {
  return useQuery({
    queryKey: ['seller-stats', shopId, days],
    enabled: !!shopId,
    queryFn: async () => (await apiClient.get<SellerStats>(`/api/shops/${shopId}/stats`, { params: { days } })).data,
  });
}

/** `404 not_ranked` (no sales on the board yet) is an ordinary answer, not an error to retry. */
export function useShopRank(shopId: string | undefined, period: 'week' | 'month' = 'week') {
  return useQuery({
    queryKey: ['shop-rank', shopId, period],
    enabled: !!shopId,
    retry: false,
    queryFn: async () => {
      try {
        return (await apiClient.get<ShopRank>(`/api/shops/${shopId}/rank`, { params: { period } })).data;
      } catch (error) {
        if ((error as { response?: { status?: number } }).response?.status === 404) return null;
        throw error;
      }
    },
  });
}

export function useShopProducts(shopId: string | undefined, q = '') {
  return useQuery({
    queryKey: ['shop-products', shopId, q],
    enabled: !!shopId,
    queryFn: async () => {
      const text = q.trim().slice(0, SHOP_SEARCH_MAX);
      // S32: typo-tolerant, shop-scoped search on the server; the plain list when there is nothing to search for.
      const { data } = text
        ? await apiClient.get<{ items: { id: string; title: string; priceMinor: number; quantity: number }[] }>(`/api/shops/${shopId}/products/search`, { params: { q: text, limit: 50 } })
        : await apiClient.get<{ items: { id: string; title: string; priceMinor: number; quantity: number }[] }>(`/api/shops/${shopId}/products`, { params: { limit: 50 } });
      return data.items.map((item): ShopProduct => ({ id: item.id, title: item.title, price: item.priceMinor, quantity: item.quantity }));
    },
  });
}

export function useCreateProduct(shopId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { title: string; description: string; brand: string; category: string; price: number; quantity: number }) =>
      {
      const { price, ...rest } = input;
      return (await apiClient.post(`/api/shops/${shopId}/products`, { ...rest, priceMinor: price })).data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shop-products', shopId] }),
  });
}
