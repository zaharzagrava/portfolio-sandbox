'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/use-auth';
import { apiClient } from './client';
import type { ProductDetail } from './catalog';

/** Server cart (DynamoDB, SD-19): guests are identified by a signed HttpOnly `cart` cookie, users by their id. */
export interface CartLine {
  productId: string;
  quantity: number;
  addedAt: string;
}

export interface CartItem extends CartLine {
  product: Pick<ProductDetail, 'id' | 'title' | 'price' | 'brand' | 'inStock' | 'quantity'> | null;
}

export const MAX_LINE_QUANTITY = 20;
export const CART_QUERY_KEY = ['cart'] as const;

export interface CartTotals {
  itemCount: number;
  subtotal: number; // cents
}

/** Lines whose product no longer exists (deleted / unknown) are skipped: they can't be bought. */
export function cartTotals(items: CartItem[]): CartTotals {
  let itemCount = 0;
  let subtotal = 0;
  for (const item of items) {
    if (!item.product) continue;
    itemCount += item.quantity;
    subtotal += item.product.price * item.quantity;
  }
  return { itemCount, subtotal };
}

/** Quantity after adding `delta` to an existing line, clamped to the server limit (0 removes the line). */
export function nextQuantity(current: number, delta: number): number {
  return Math.min(MAX_LINE_QUANTITY, Math.max(0, current + delta));
}

async function hydrate(lines: CartLine[]): Promise<CartItem[]> {
  return Promise.all(
    lines.map(async (line) => {
      try {
        const { data } = await apiClient.get<ProductDetail>(`/api/products/${line.productId}`);
        return { ...line, product: data };
      } catch {
        return { ...line, product: null };
      }
    }),
  );
}

export const cartApi = {
  async get(): Promise<CartItem[]> {
    const { data } = await apiClient.get<{ lines: CartLine[] }>('/api/cart');
    return hydrate(data.lines ?? []);
  },
  async setQuantity(productId: string, quantity: number): Promise<CartItem[]> {
    const { data } = await apiClient.put<{ lines: CartLine[] }>(`/api/cart/items/${productId}`, { quantity });
    return hydrate(data.lines ?? []);
  },
  /** After login: move the guest cart into the user's cart (no-op when there is none). */
  async mergeGuestCart(): Promise<void> {
    await apiClient.post('/api/cart/merge', {});
  },
};

/** Waits for the session restore: fetched too early it would read the anonymous cart and cache that. */
export function useCart() {
  const { user, isLoading } = useAuth();
  return useQuery({ queryKey: [...CART_QUERY_KEY, user?.id ?? 'guest'], queryFn: cartApi.get, enabled: !isLoading });
}

export function useSetCartQuantity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ productId, quantity }: { productId: string; quantity: number }) => cartApi.setQuantity(productId, quantity),
    onSuccess: (items) => {
      queryClient.setQueriesData({ queryKey: CART_QUERY_KEY }, items);
    },
  });
}
