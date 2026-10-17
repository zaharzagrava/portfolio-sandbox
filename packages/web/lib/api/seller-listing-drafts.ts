'use client';

import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  draftConnectSchema,
  draftPageSchema,
  draftPublishResultSchema,
  draftSchema,
  draftVersionPageSchema,
  draftVersionSchema,
  type Draft,
  type DraftConnect,
  type DraftPage,
  type DraftPublishRequest,
  type DraftPublishResult,
  type DraftVersion,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

/**
 * F1 (S06 collaborative listing drafts, `contracts/http.md`). The document itself travels over the editing connection
 * (`lib/seller/collab-session.ts`); these are the HTTP routes around it: find or start a draft, get a connection ticket,
 * name versions and publish. The ticket is used once and is not kept in any cache.
 */

export type { Draft, DraftConnect, DraftPage, DraftPublishResult, DraftVersion };

export const DRAFT_PAGE_SIZE = 100;
export const VERSION_PAGE_SIZE = 20;

const base = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}/drafts`;
const one = (shopId: string, draftId: string) => `${base(shopId)}/${encodeURIComponent(draftId)}`;

/** The open drafts of the shop, newest first (the route has no product filter: the caller picks by `productId`). */
export function useOpenDrafts(shopId: string) {
  return useQuery({
    queryKey: queryKeys.seller.drafts(shopId, { status: 'DRAFT' }),
    queryFn: async (): Promise<DraftPage> => {
      const { data } = await apiClient.get<unknown>(base(shopId), { params: { status: 'DRAFT', limit: DRAFT_PAGE_SIZE } });
      return parseBody(draftPageSchema, data);
    },
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function useCreateDraft(shopId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { title: string; productId?: string }): Promise<Draft> => {
      const { data } = await apiClient.post<unknown>(base(shopId), input);
      return parseBody(draftSchema, data);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'drafts') }),
  });
}

/** One connection ticket: `url` (without the ticket), the single-use `ticket`, and whether this member may write. */
export async function connectDraft(shopId: string, draftId: string): Promise<DraftConnect> {
  const { data } = await apiClient.post<unknown>(`${one(shopId, draftId)}/connect`);
  return parseBody(draftConnectSchema, data);
}

export function useDraftVersions(shopId: string, draftId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.seller.draftVersions(shopId, draftId),
    queryFn: async ({ pageParam }): Promise<{ items: DraftVersion[]; nextCursor: string | null }> => {
      const { data } = await apiClient.get<unknown>(`${one(shopId, draftId)}/versions`, { params: { limit: VERSION_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) } });
      return parseBody(draftVersionPageSchema, data);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: retryUnlessClientError,
  });
}

export function useCreateVersion(shopId: string, draftId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<DraftVersion> => {
      const { data } = await apiClient.post<unknown>(`${one(shopId, draftId)}/versions`, { name });
      return parseBody(draftVersionSchema, data);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.draftVersions(shopId, draftId) }),
  });
}

/**
 * Publishes the draft. `key` is the `Idempotency-Key` of this attempt: the caller keeps one key while it retries the same
 * request and takes a new one when the request changes (`acknowledgeProductVersion` added). No cache holds the result.
 */
export function usePublishDraft(shopId: string, draftId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { key: string; body: DraftPublishRequest }): Promise<DraftPublishResult> => {
      const { data } = await apiClient.post<unknown>(`${one(shopId, draftId)}/publish`, input.body, { headers: { 'Idempotency-Key': input.key } });
      return parseBody(draftPublishResultSchema, data);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'drafts') }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.draftVersions(shopId, draftId) }),
  });
}

/** `currentVersion` of a `409 product_version_conflict`, the version the product is at now. */
export function currentVersionOf(error: unknown): number | undefined {
  const value = (error as { response?: { data?: { currentVersion?: unknown } } } | null)?.response?.data?.currentVersion;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
