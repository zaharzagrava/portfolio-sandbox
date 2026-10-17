'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  conflictPageSchema,
  integrationInstallResponseSchema,
  integrationPageSchema,
  integrationReconcileResponseSchema,
  integrationSchema,
  integrationSyncResponseSchema,
  quarantineItemSchema,
  quarantinePageSchema,
  quarantineRetryResponseSchema,
  reconciliationPageSchema,
  reconciliationReportSchema,
  stockConflictSchema,
  syncConflictPageSchema,
  syncConflictSchema,
  type ConflictPage,
  type Integration,
  type IntegrationPage,
  type QuarantineItem,
  type QuarantinePage,
  type ReconciliationPage,
  type ReconciliationReport,
  type StockConflict,
  type SyncConflictPage,
  type WooConnectRequest,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

/**
 * F3 (S08 integrations and quarantine, S09 offline conflicts). Everything comes from the HTTP routes; no event is
 * subscribed (W04 R-14), so a list is refreshed by asking again. A secret typed into the WooCommerce form is sent once and
 * is in no query or mutation result.
 */

export type { ConflictPage, Integration, IntegrationPage, QuarantineItem, QuarantinePage, ReconciliationPage, ReconciliationReport, StockConflict, SyncConflictPage };

export const INTEGRATIONS_PAGE_SIZE = 20;
export const QUARANTINE_PAGE_SIZE = 20;
export const CONFLICTS_PAGE_SIZE = 20;
export const RECONCILIATIONS_PAGE_SIZE = 20;

const shopBase = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}`;
const one = (shopId: string, integrationId: string) => `${shopBase(shopId)}/integrations/${encodeURIComponent(integrationId)}`;
const paging = (size: number, params: { status?: string; cursor?: string }) => ({ limit: size, ...(params.status ? { status: params.status } : {}), ...(params.cursor ? { cursor: params.cursor } : {}) });

// ---------------------------------------------------------------- integrations

export function useIntegrations(shopId: string, params: { cursor?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.seller.integrations(shopId, params),
    queryFn: async (): Promise<IntegrationPage> => {
      const { data } = await apiClient.get<unknown>(`${shopBase(shopId)}/integrations`, { params: paging(INTEGRATIONS_PAGE_SIZE, params) });
      return parseBody(integrationPageSchema, data);
    },
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function useIntegration(shopId: string, integrationId: string) {
  return useQuery({
    queryKey: queryKeys.seller.integration(shopId, integrationId),
    queryFn: async (): Promise<Integration> => {
      const { data } = await apiClient.get<unknown>(one(shopId, integrationId));
      return parseBody(integrationSchema, data);
    },
    retry: retryUnlessClientError,
  });
}

function useInvalidate(shopId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'integrations') });
}

/** Starts the Shopify install; the answer carries the address the browser is sent to. */
export function useInstallShopify(shopId: string) {
  return useMutation({
    mutationFn: async (shopDomain: string) => {
      const { data } = await apiClient.post<unknown>(`${shopBase(shopId)}/integrations/shopify/install`, { shopDomain });
      return parseBody(integrationInstallResponseSchema, data);
    },
  });
}

/** Connects a WooCommerce store. The consumer secret goes to the API and is not kept: the answer has no credentials. */
export function useConnectWoo(shopId: string) {
  const invalidate = useInvalidate(shopId);
  return useMutation({
    mutationFn: async (body: WooConnectRequest): Promise<Integration> => {
      const { data } = await apiClient.post<unknown>(`${shopBase(shopId)}/integrations`, body);
      return parseBody(integrationSchema, data);
    },
    onSuccess: invalidate,
  });
}

export function useDisconnect(shopId: string, integrationId: string) {
  const invalidate = useInvalidate(shopId);
  return useMutation({
    mutationFn: async () => {
      await apiClient.delete(one(shopId, integrationId));
    },
    onSuccess: invalidate,
  });
}

export function usePauseResume(shopId: string, integrationId: string) {
  const invalidate = useInvalidate(shopId);
  return useMutation({
    mutationFn: async (action: 'pause' | 'resume'): Promise<Integration> => {
      const { data } = await apiClient.post<unknown>(`${one(shopId, integrationId)}/${action}`);
      return parseBody(integrationSchema, data);
    },
    onSettled: invalidate,
  });
}

export function useSyncNow(shopId: string, integrationId: string) {
  const invalidate = useInvalidate(shopId);
  return useMutation({
    mutationFn: async (mode: 'incremental' | 'backfill') => {
      const { data } = await apiClient.post<unknown>(`${one(shopId, integrationId)}/sync`, { mode });
      return parseBody(integrationSyncResponseSchema, data);
    },
    onSettled: invalidate,
  });
}

export function useReconcileNow(shopId: string, integrationId: string) {
  const invalidate = useInvalidate(shopId);
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<unknown>(`${one(shopId, integrationId)}/reconcile`);
      return parseBody(integrationReconcileResponseSchema, data);
    },
    onSettled: invalidate,
  });
}

// ---------------------------------------------------------------- quarantine

export function useQuarantine(shopId: string, integrationId: string, params: { status?: string; cursor?: string }) {
  return useQuery({
    queryKey: queryKeys.seller.quarantine(shopId, integrationId, params),
    queryFn: async (): Promise<QuarantinePage> => {
      const { data } = await apiClient.get<unknown>(`${one(shopId, integrationId)}/quarantine`, { params: paging(QUARANTINE_PAGE_SIZE, params) });
      return parseBody(quarantinePageSchema, data);
    },
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

/** `resolved` (the item now passes) or `still_invalid` (it was checked again and is still refused). */
export function useRetryQuarantine(shopId: string, integrationId: string) {
  const invalidate = useInvalidate(shopId);
  return useMutation({
    mutationFn: async (quarantineId: string) => {
      const { data } = await apiClient.post<unknown>(`${one(shopId, integrationId)}/quarantine/${encodeURIComponent(quarantineId)}/retry`);
      return parseBody(quarantineRetryResponseSchema, data);
    },
    onSettled: invalidate,
  });
}

export function useDismissQuarantine(shopId: string, integrationId: string) {
  const invalidate = useInvalidate(shopId);
  return useMutation({
    mutationFn: async (quarantineId: string): Promise<QuarantineItem> => {
      const { data } = await apiClient.post<unknown>(`${one(shopId, integrationId)}/quarantine/${encodeURIComponent(quarantineId)}/dismiss`);
      return parseBody(quarantineItemSchema, data);
    },
    onSettled: invalidate,
  });
}

// ---------------------------------------------------------------- stock conflicts of an integration (S08)

export function useStockConflicts(shopId: string, integrationId: string, params: { status?: string; cursor?: string }) {
  return useQuery({
    queryKey: queryKeys.seller.conflicts(shopId, integrationId, params),
    queryFn: async (): Promise<ConflictPage> => {
      const { data } = await apiClient.get<unknown>(`${one(shopId, integrationId)}/conflicts`, { params: paging(CONFLICTS_PAGE_SIZE, params) });
      return parseBody(conflictPageSchema, data);
    },
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function useDismissStockConflict(shopId: string, integrationId: string) {
  const invalidate = useInvalidate(shopId);
  return useMutation({
    mutationFn: async (conflictId: string): Promise<StockConflict> => {
      const { data } = await apiClient.post<unknown>(`${one(shopId, integrationId)}/conflicts/${encodeURIComponent(conflictId)}/dismiss`);
      return parseBody(stockConflictSchema, data);
    },
    onSettled: invalidate,
  });
}

// ---------------------------------------------------------------- reconciliations

export function useReconciliations(shopId: string, integrationId: string, params: { cursor?: string }) {
  return useQuery({
    queryKey: queryKeys.seller.reconciliations(shopId, integrationId, params),
    queryFn: async (): Promise<ReconciliationPage> => {
      const { data } = await apiClient.get<unknown>(`${one(shopId, integrationId)}/reconciliations`, { params: paging(RECONCILIATIONS_PAGE_SIZE, params) });
      return parseBody(reconciliationPageSchema, data);
    },
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function useReconciliation(shopId: string, integrationId: string, runId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.seller.reconciliation(shopId, integrationId, runId ?? ''),
    queryFn: async (): Promise<ReconciliationReport> => {
      const { data } = await apiClient.get<unknown>(`${one(shopId, integrationId)}/reconciliations/${encodeURIComponent(runId ?? '')}`);
      return parseBody(reconciliationReportSchema, data);
    },
    enabled: runId !== undefined,
    retry: retryUnlessClientError,
  });
}

// ---------------------------------------------------------------- offline conflicts (S09, HTTP only)

export function useOfflineConflicts(shopId: string, params: { status?: string; cursor?: string }) {
  return useQuery({
    queryKey: queryKeys.seller.offlineConflicts(shopId, params),
    queryFn: async (): Promise<SyncConflictPage> => {
      const { data } = await apiClient.get<unknown>(`${shopBase(shopId)}/sync/conflicts`, { params: paging(CONFLICTS_PAGE_SIZE, params) });
      return parseBody(syncConflictPageSchema, data);
    },
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

export function useDismissOfflineConflict(shopId: string) {
  const invalidate = useInvalidate(shopId);
  return useMutation({
    mutationFn: async (opId: string) => {
      const { data } = await apiClient.post<unknown>(`${shopBase(shopId)}/sync/conflicts/${encodeURIComponent(opId)}/dismiss`);
      return parseBody(syncConflictSchema, data);
    },
    onSettled: invalidate,
  });
}
