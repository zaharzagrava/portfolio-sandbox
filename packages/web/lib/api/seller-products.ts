'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  productMemberSchema,
  productPageSchema,
  shopProductSearchResponseSchema,
  type ProductCreateRequest,
  type ProductMemberView,
  type ProductUpdateRequest,
} from '@marketplace-sandbox/contracts';
import type { Problem } from './errors';
import { queryKeys } from '@/lib/query-keys';
import type { InventoryParams } from '@/lib/seller/search-params';
import { browsePage, INVENTORY_PAGE_SIZE, inventoryQuery, isSearch, searchPage, type InventoryPage, type InventoryRow } from '@/lib/seller/wire';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

export type { ProductMemberView };

export { INVENTORY_PAGE_SIZE, type InventoryPage, type InventoryRow };

const base = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}/products`;

/** The shop's products: the member browse list, or the shop search when `q` is set (it covers every status). */
export async function fetchInventory(shopId: string, params: InventoryParams): Promise<InventoryPage> {
  if (isSearch(params)) {
    const { data } = await apiClient.get<unknown>(`${base(shopId)}/search`, { params: inventoryQuery(params) });
    return searchPage(parseBody(shopProductSearchResponseSchema, data));
  }
  const { data } = await apiClient.get<unknown>(base(shopId), { params: inventoryQuery(params) });
  return browsePage(parseBody(productPageSchema, data));
}

export async function fetchProduct(shopId: string, productId: string): Promise<ProductMemberView> {
  const { data } = await apiClient.get<unknown>(`${base(shopId)}/${encodeURIComponent(productId)}`);
  return parseBody(productMemberSchema, data);
}

/** `idempotencyKey`: one per create attempt, so a repeat of the same request answers with the product it made (S05). */
/**
 * After a `version_conflict`: whether the product is archived now. A write against an old version answers "changed" even when
 * the change was an archive, so the screens read the product once to give the right words. A failed read counts as "no".
 */
export async function isArchivedNow(shopId: string, productId: string): Promise<boolean> {
  try {
    return (await fetchProduct(shopId, productId)).status === 'ARCHIVED';
  } catch {
    return false;
  }
}

/** The problem a screen shows for a product that was archived or restored elsewhere (the same as the API's own 409). */
export const ARCHIVED_ELSEWHERE: Problem = { status: 409, code: 'product_archived', errors: [] };

export async function createProduct(shopId: string, body: ProductCreateRequest, idempotencyKey?: string): Promise<ProductMemberView> {
  const { data } = await apiClient.post<unknown>(base(shopId), body, idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined);
  return parseBody(productMemberSchema, data);
}

export async function updateProduct(shopId: string, productId: string, body: ProductUpdateRequest): Promise<ProductMemberView> {
  const { data } = await apiClient.patch<unknown>(`${base(shopId)}/${encodeURIComponent(productId)}`, body);
  return parseBody(productMemberSchema, data);
}

export async function transitionProduct(shopId: string, productId: string, action: 'archive' | 'restore', expectedVersion: number): Promise<ProductMemberView> {
  const { data } = await apiClient.post<unknown>(`${base(shopId)}/${encodeURIComponent(productId)}/${action}`, { expectedVersion });
  return parseBody(productMemberSchema, data);
}

type InitialPage = InventoryPage | undefined;

/** The list for the URL's filters. The previous rows stay while the next page loads (W04 AS-31). */
export function useInventory(shopId: string, params: InventoryParams, initialData?: InitialPage) {
  return useQuery({
    queryKey: queryKeys.seller.inventory(shopId, { q: params.q || undefined, status: params.status, inStock: params.inStock, cursor: params.cursor }),
    queryFn: () => fetchInventory(shopId, params),
    placeholderData: keepPreviousData,
    initialData,
    // the search index lags behind a new product by a few seconds: a search is read again whenever it is asked for again, so an
    // empty answer is never served for a minute (the browse list keeps the default)
    staleTime: isSearch(params) ? 0 : undefined,
    retry: retryUnlessClientError,
  });
}

/** The member view of one product (with `version`); the edit dialog reads it fresh every time it opens. */
export function useProduct(shopId: string, productId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.seller.product(shopId, productId ?? ''),
    queryFn: () => fetchProduct(shopId, productId as string),
    enabled: Boolean(productId),
    staleTime: 0,
    gcTime: 0,
    retry: retryUnlessClientError,
  });
}

function useInventoryMutation<TInput>(shopId: string, mutationFn: (input: TInput) => Promise<ProductMemberView>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    // A refused write (409, 404) means the list is out of date too, so it refetches either way.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'inventory') }),
  });
}

/** The input is the request body, plus the `idempotencyKey` of this attempt (not part of the body). */
export function useCreateProduct(shopId: string) {
  return useInventoryMutation(shopId, ({ idempotencyKey, ...body }: ProductCreateRequest & { idempotencyKey?: string }) => createProduct(shopId, body, idempotencyKey));
}

export function useUpdateProduct(shopId: string) {
  return useInventoryMutation(shopId, (input: { productId: string; body: ProductUpdateRequest }) => updateProduct(shopId, input.productId, input.body));
}

/** Stock is a `PATCH` of `quantity` against the version the seller saw (a sale in between answers `409 version_conflict`). */
export function useAdjustStock(shopId: string) {
  return useInventoryMutation(shopId, (input: { productId: string; quantity: number; expectedVersion: number }) =>
    updateProduct(shopId, input.productId, { expectedVersion: input.expectedVersion, quantity: input.quantity }),
  );
}

export function useArchiveProduct(shopId: string) {
  return useInventoryMutation(shopId, (input: { productId: string; expectedVersion: number }) => transitionProduct(shopId, input.productId, 'archive', input.expectedVersion));
}

export function useRestoreProduct(shopId: string) {
  return useInventoryMutation(shopId, (input: { productId: string; expectedVersion: number }) => transitionProduct(shopId, input.productId, 'restore', input.expectedVersion));
}
