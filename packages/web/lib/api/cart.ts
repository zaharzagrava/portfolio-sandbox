'use client';

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { cartPageResponseSchema, cartSchema, type CartDto, type CartPageResponse } from '@marketplace-sandbox/contracts';
import { unitCount } from '@/lib/cart/totals';
import { createWriteQueue, type WriteQueue } from '@/lib/cart/write-queue';
import { queryKeys } from '@/lib/query-keys';
import { apiClient } from './client';
import { parseBody } from './parse';

/**
 * The cart in the browser (W03 FR-050..FR-057). Reads are parsed with the contracts schemas: the cheap lines (`GET /api/cart`,
 * badge and add-to-cart) and the aggregate (`GET /api/bff/cart`, cart page and review). Same-origin relative URLs; the BFF
 * session / guest `cart` cookie travels by itself and the CSRF proof is added by the shared client on every write.
 */
export const MAX_LINE_QUANTITY = 20;
export const MAX_CART_LINES = 50;

const CART_PATH = '/api/cart';

export async function fetchCartLines(): Promise<CartDto> {
  const { data } = await apiClient.get<unknown>(CART_PATH);
  return parseBody(cartSchema, data);
}

export async function fetchCartPage(): Promise<CartPageResponse> {
  const { data } = await apiClient.get<unknown>('/api/bff/cart');
  return parseBody(cartPageResponseSchema, data);
}

/** `PUT /api/cart/items/:productId {quantity}`; `0` removes the line. Resolves with the whole cart. */
export async function setLine(productId: string, quantity: number): Promise<CartDto> {
  const { data } = await apiClient.put<unknown>(`${CART_PATH}/items/${encodeURIComponent(productId)}`, { quantity });
  return parseBody(cartSchema, data);
}

export function useCartLines() {
  return useQuery({ queryKey: queryKeys.cart.lines(), queryFn: fetchCartLines });
}

export function useCartPage() {
  return useQuery({ queryKey: queryKeys.cart.page(), queryFn: fetchCartPage });
}

/** Units in the cart for the badge; `null` until the first read succeeds (and when it fails with nothing cached). */
export function useCartCount(): number | null {
  const { data } = useQuery({ queryKey: queryKeys.cart.lines(), queryFn: fetchCartLines, select: (cart) => unitCount(cart.lines) });
  return data ?? null;
}

// --- writes: optimistic, serialised per product, re-read after the last ------------------------------------------------
type CartLines = CartDto['lines'];
type CartLineDto = CartLines[number];
type PageLine = CartPageResponse['lines'][number];

type WriteContext = {
  queue: WriteQueue<CartDto>;
  /** The quantity the server last confirmed for a product (0 when absent), the target of a rollback. */
  confirmed: Map<string, number>;
  /** The cache entries of a product as they were before its first optimistic change, to bring a removed line back. */
  originals: Map<string, { line?: CartLineDto; pageLine?: PageLine }>;
};

const contexts = new WeakMap<QueryClient, WriteContext>();

function contextFor(client: QueryClient): WriteContext {
  let context = contexts.get(client);
  if (context) return context;
  const created: WriteContext = { queue: undefined as unknown as WriteQueue<CartDto>, confirmed: new Map(), originals: new Map() };
  created.queue = createWriteQueue(
    async (productId, quantity) => {
      const cart = await setLine(productId, quantity);
      created.confirmed.set(productId, cart.lines.find((entry) => entry.productId === productId)?.quantity ?? 0);
      return cart;
    },
    {
      onSettled: () => {
        // The last write of a burst settled: the server's cart is the truth for both reads (this is also the rollback).
        void client.invalidateQueries({ queryKey: queryKeys.cart.lines() });
        void client.invalidateQueries({ queryKey: queryKeys.cart.page() });
      },
    },
  );
  context = created;
  contexts.set(client, context);
  return context;
}

function setQuantity<T extends { productId: string; quantity: number }>(lines: T[], productId: string, quantity: number, make?: () => T): T[] {
  const index = lines.findIndex((entry) => entry.productId === productId);
  if (index === -1) return quantity > 0 && make ? [...lines, make()] : lines;
  if (quantity <= 0) return lines.filter((entry) => entry.productId !== productId);
  return lines.map((entry, position) => (position === index ? { ...entry, quantity } : entry));
}

function show(client: QueryClient, context: WriteContext, productId: string, quantity: number): void {
  const original = context.originals.get(productId);
  client.setQueryData<CartDto>(queryKeys.cart.lines(), (current) => {
    if (!current) return current;
    const make = (): CartLineDto => ({ ...(original?.line ?? { productId, addedAt: new Date().toISOString() }), quantity });
    return { ...current, lines: setQuantity<CartLineDto>(current.lines, productId, quantity, make) };
  });
  client.setQueryData<CartPageResponse>(queryKeys.cart.page(), (current) => {
    if (!current) return current;
    // A product the page does not know yet cannot be shown (title, price): the re-read after the write brings it.
    const make = original?.pageLine ? () => ({ ...(original.pageLine as PageLine), quantity }) : undefined;
    return { ...current, lines: setQuantity<PageLine>(current.lines, productId, quantity, make) };
  });
}

function currentQuantity(client: QueryClient, productId: string): number | undefined {
  const lines = client.getQueryData<CartDto>(queryKeys.cart.lines());
  return lines ? (lines.lines.find((entry) => entry.productId === productId)?.quantity ?? 0) : undefined;
}

/**
 * Sets one line (`0` removes it): the cached lines and page change at once; the PUT is sent after any earlier PUT for the
 * same product (the last value wins); the cart is re-read after the last write of a burst. A refused or failed write
 * rejects with the original error and puts the confirmed quantity back, even if the re-read fails too.
 */
export function writeCartLine(client: QueryClient, productId: string, quantity: number): Promise<CartDto> {
  const context = contextFor(client);
  if (!context.queue.isBusy(productId)) {
    const known = currentQuantity(client, productId);
    if (known === undefined) context.confirmed.delete(productId);
    else context.confirmed.set(productId, known);
    context.originals.set(productId, {
      line: client.getQueryData<CartDto>(queryKeys.cart.lines())?.lines.find((entry) => entry.productId === productId),
      pageLine: client.getQueryData<CartPageResponse>(queryKeys.cart.page())?.lines.find((entry) => entry.productId === productId),
    });
  }
  // A read that started before this change must not land on top of it.
  void client.cancelQueries({ queryKey: queryKeys.cart.lines() });
  void client.cancelQueries({ queryKey: queryKeys.cart.page() });
  show(client, context, productId, quantity);
  return context.queue.set(productId, quantity).catch((error: unknown) => {
    if (!context.queue.isBusy(productId)) {
      const confirmed = context.confirmed.get(productId);
      if (confirmed !== undefined) show(client, context, productId, confirmed);
    }
    throw error;
  });
}

/** `(productId, quantity) => Promise<CartDto>` bound to the app's query client. Rejects with the axios error (use `problemFromError`). */
export function useSetCartLine(): (productId: string, quantity: number) => Promise<CartDto> {
  const client = useQueryClient();
  return useCallback((productId, quantity) => writeCartLine(client, productId, quantity), [client]);
}

// --- merge after sign-in -----------------------------------------------------------------------------------------------
export type MergeResult = { droppedLines: number };

/**
 * After sign-in: moves the guest cart into the member's (W03 AS-11, AS-12). Never throws: a failure resolves
 * `{droppedLines: 0}`. The result is recorded under `queryKeys.cart.lastMerge()` for the cart page's notice, and the cart
 * reads are invalidated so they show the summed quantities.
 */
export async function mergeGuestCart(queryClient?: QueryClient): Promise<MergeResult> {
  let result: MergeResult = { droppedLines: 0 };
  let merged = false;
  try {
    const { data } = await apiClient.post<unknown>(`${CART_PATH}/merge`, {});
    result = { droppedLines: parseBody(cartSchema, data).droppedLines };
    merged = true;
  } catch {
    result = { droppedLines: 0 };
  }
  if (queryClient) {
    queryClient.setQueryData(queryKeys.cart.lastMerge(), result);
    if (merged) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.cart.lines() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.cart.page() });
    }
  }
  return result;
}

/** What the last `mergeGuestCart` reported; `undefined` before any merge in this page load. */
export function useLastMerge(): MergeResult | undefined {
  return useQuery<MergeResult>({ queryKey: queryKeys.cart.lastMerge(), queryFn: () => ({ droppedLines: 0 }), enabled: false, staleTime: Infinity }).data;
}
