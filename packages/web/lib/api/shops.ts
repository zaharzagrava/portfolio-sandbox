'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import { fuzzyMatches } from '../fuzzy';

/** Multi-tenant shops (SD-02). Opening a shop makes the owner a SELLER (on the next token refresh). */
export interface MyShop {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER';
}

export interface SellerStats {
  sellerId: string;
  days: number;
  summary: { revenueCents: number; orders: number; unitsSold: number; uniqueBuyers: number; refunds: number; avgOrderValueCents: number };
  daily: { day: string; revenueCents: number; orders: number }[];
  topProducts: { productId: string; revenueCents: number; unitsSold: number }[];
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

export function useSellerStats(enabled: boolean, days = 30) {
  return useQuery({
    queryKey: ['seller-stats', days],
    enabled,
    queryFn: async () => (await apiClient.get<SellerStats>('/api/sellers/me/stats', { params: { days } })).data,
  });
}

export function useShopProducts(shopId: string | undefined, q = '') {
  return useQuery({
    queryKey: ['shop-products', shopId, q],
    enabled: !!shopId,
    queryFn: async () => {
      // The shop list has no text search (S-catalog): fetch the shop's products and match typo-tolerantly here.
      const { data } = await apiClient.get<{ items: { id: string; title: string; priceMinor: number; quantity: number }[] }>(
        `/api/shops/${shopId}/products`,
        { params: { limit: 50 } },
      );
      return data.items
        .filter((item) => fuzzyMatches(item.title, q))
        .map((item): ShopProduct => ({ id: item.id, title: item.title, price: item.priceMinor, quantity: item.quantity }));
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
