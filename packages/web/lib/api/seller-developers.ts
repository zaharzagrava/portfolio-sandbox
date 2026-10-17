'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiKeyListSchema,
  apiVersionStateSchema,
  createdApiKeySchema,
  createdWebhookEndpointSchema,
  pinVersionResultSchema,
  requestLogPageSchema,
  rotatedWebhookSecretSchema,
  usageReportSchema,
  webhookAttemptPageSchema,
  webhookDeliveryAcceptedSchema,
  webhookEndpointPageSchema,
  webhookEndpointSchema,
  webhookEventDetailSchema,
  webhookEventTypesResponseSchema,
  type CreateApiKeyRequest,
  type CreatedApiKey,
  type CreatedWebhookEndpoint,
  type CreateWebhookEndpointRequest,
  type UpdateWebhookEndpointRequest,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import type { LogsParams, WebhookAttemptsParams } from '@/lib/seller/search-params';
import { attemptsQuery, KEYS_PAGE_SIZE, listQuery, logsQuery, WEBHOOKS_PAGE_SIZE } from '@/lib/seller/wire';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

const base = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}/developers`;
const hook = (shopId: string, endpointId: string) => `${base(shopId)}/webhooks/${encodeURIComponent(endpointId)}`;

/** The delivery log refetches this often for this long after a test event (W04 AS-64). */
export const PING_REFETCH_MS = 5_000;
export const PING_REFETCH_TOTAL_MS = 30_000;

/** Defaults a failed catalogue (or the retry rule) must not repeat: a 4xx answer will not change by asking again. */
const retry = retryUnlessClientError;

// ---------------------------------------------------------------- secrets (W04 AS-46)

/**
 * A secret is handed to the caller once, through `reveal`, and is stripped from what the mutation returns, so the query
 * and mutation caches (which keep results) never hold it. `reveal` is a variable of the mutation, not data.
 */
export type Reveal<T> = (created: T) => void;
export type KeyRecord = Omit<CreatedApiKey, 'key'>;
export type EndpointRecord = Omit<CreatedWebhookEndpoint, 'secret'>;

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

// ---------------------------------------------------------------- API keys

export async function fetchApiKeys(shopId: string, cursor?: string) {
  const { data } = await apiClient.get<unknown>(`${base(shopId)}/keys`, { params: listQuery(KEYS_PAGE_SIZE, { cursor }) });
  return parseBody(apiKeyListSchema, data);
}

export function useApiKeys(shopId: string, params: { cursor?: string } = {}, initialData?: Awaited<ReturnType<typeof fetchApiKeys>>) {
  return useQuery({ queryKey: queryKeys.seller.apiKeys(shopId, params), queryFn: () => fetchApiKeys(shopId, params.cursor), initialData, placeholderData: keepPreviousData, retry });
}

function useInvalidate(shopId: string, ...sections: Parameters<typeof queryKeys.seller.scope>[1][]) {
  const queryClient = useQueryClient();
  return () => Promise.all(sections.map((section) => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, section) })));
}

export function useCreateKey(shopId: string) {
  const invalidate = useInvalidate(shopId, 'api-keys');
  return useMutation({
    mutationFn: async (input: { body: CreateApiKeyRequest; reveal: Reveal<CreatedApiKey> }): Promise<KeyRecord> => {
      const { data } = await apiClient.post<unknown>(`${base(shopId)}/keys`, input.body);
      const created = parseBody(createdApiKeySchema, data);
      input.reveal(created);
      return omit(created, 'key');
    },
    gcTime: 0,
    onSettled: invalidate,
  });
}

export function useRotateKey(shopId: string) {
  const invalidate = useInvalidate(shopId, 'api-keys');
  return useMutation({
    mutationFn: async (input: { keyId: string; overlapHours: number; reveal: Reveal<CreatedApiKey> }): Promise<KeyRecord> => {
      const { data } = await apiClient.post<unknown>(`${base(shopId)}/keys/${encodeURIComponent(input.keyId)}/rotate`, { overlapHours: input.overlapHours });
      const created = parseBody(createdApiKeySchema, data);
      input.reveal(created);
      return omit(created, 'key');
    },
    gcTime: 0,
    onSettled: invalidate,
  });
}

export function useRevokeKey(shopId: string) {
  const invalidate = useInvalidate(shopId, 'api-keys');
  return useMutation({
    mutationFn: async (keyId: string): Promise<void> => {
      await apiClient.delete(`${base(shopId)}/keys/${encodeURIComponent(keyId)}`);
    },
    onSettled: invalidate,
  });
}

// ---------------------------------------------------------------- API version, logs, usage

export function useApiVersion(shopId: string, initialData?: ReturnType<typeof apiVersionStateSchema.parse>) {
  return useQuery({
    queryKey: queryKeys.seller.apiVersion(shopId),
    queryFn: async () => parseBody(apiVersionStateSchema, (await apiClient.get<unknown>(`${base(shopId)}/api-version`)).data),
    initialData,
    retry,
  });
}

export function usePinVersion(shopId: string) {
  const invalidate = useInvalidate(shopId, 'api-version');
  return useMutation({
    mutationFn: async (version: string) => parseBody(pinVersionResultSchema, (await apiClient.put<unknown>(`${base(shopId)}/api-version`, { version })).data),
    onSettled: invalidate,
  });
}

export function useRequestLogs(shopId: string, filters: LogsParams, initialData?: ReturnType<typeof requestLogPageSchema.parse>) {
  return useQuery({
    queryKey: queryKeys.seller.logs(shopId, { ...filters }),
    queryFn: async () => parseBody(requestLogPageSchema, (await apiClient.get<unknown>(`${base(shopId)}/logs`, { params: logsQuery(filters) })).data),
    initialData,
    placeholderData: keepPreviousData,
    retry,
  });
}

export function useUsage(shopId: string, params: { days: number; livemode: boolean }, initialData?: ReturnType<typeof usageReportSchema.parse>) {
  return useQuery({
    queryKey: queryKeys.seller.usage(shopId, params),
    queryFn: async () => parseBody(usageReportSchema, (await apiClient.get<unknown>(`${base(shopId)}/usage`, { params: { days: params.days, livemode: String(params.livemode) } })).data),
    initialData,
    placeholderData: keepPreviousData,
    retry,
  });
}

// ---------------------------------------------------------------- webhook endpoints

export function useWebhooks(shopId: string, params: { cursor?: string } = {}, initialData?: ReturnType<typeof webhookEndpointPageSchema.parse>) {
  return useQuery({
    queryKey: queryKeys.seller.webhooks(shopId, params),
    queryFn: async () => parseBody(webhookEndpointPageSchema, (await apiClient.get<unknown>(`${base(shopId)}/webhooks`, { params: listQuery(WEBHOOKS_PAGE_SIZE, params) })).data),
    initialData,
    placeholderData: keepPreviousData,
    retry,
  });
}

/** The event choices of the add and edit forms, in the API's order. */
export function useWebhookEventTypes(shopId: string) {
  return useQuery({
    queryKey: queryKeys.seller.webhookEventTypes(shopId),
    queryFn: async () => parseBody(webhookEventTypesResponseSchema, (await apiClient.get<unknown>(`${base(shopId)}/webhook-event-types`)).data),
    staleTime: 5 * 60_000,
    retry,
  });
}

export function useWebhook(shopId: string, endpointId: string, initialData?: ReturnType<typeof webhookEndpointSchema.parse>) {
  return useQuery({
    queryKey: queryKeys.seller.webhook(shopId, endpointId),
    queryFn: async () => parseBody(webhookEndpointSchema, (await apiClient.get<unknown>(hook(shopId, endpointId))).data),
    initialData,
    retry,
  });
}

export function useCreateWebhook(shopId: string) {
  const invalidate = useInvalidate(shopId, 'webhooks');
  return useMutation({
    mutationFn: async (input: { body: CreateWebhookEndpointRequest; reveal: Reveal<CreatedWebhookEndpoint> }): Promise<EndpointRecord> => {
      const { data } = await apiClient.post<unknown>(`${base(shopId)}/webhooks`, input.body);
      const created = parseBody(createdWebhookEndpointSchema, data);
      input.reveal(created);
      return omit(created, 'secret');
    },
    gcTime: 0,
    onSettled: invalidate,
  });
}

export function useUpdateWebhook(shopId: string) {
  const invalidate = useInvalidate(shopId, 'webhooks', 'webhook');
  return useMutation({
    mutationFn: async (input: { endpointId: string; body: UpdateWebhookEndpointRequest }) =>
      parseBody(webhookEndpointSchema, (await apiClient.patch<unknown>(hook(shopId, input.endpointId), input.body)).data),
    onSettled: invalidate,
  });
}

export function useSetWebhookEnabled(shopId: string) {
  const invalidate = useInvalidate(shopId, 'webhooks', 'webhook');
  return useMutation({
    mutationFn: async (input: { endpointId: string; enabled: boolean }) =>
      parseBody(webhookEndpointSchema, (await apiClient.post<unknown>(`${hook(shopId, input.endpointId)}/${input.enabled ? 'enable' : 'disable'}`)).data),
    onSettled: invalidate,
  });
}

export function useRotateWebhookSecret(shopId: string) {
  const invalidate = useInvalidate(shopId, 'webhooks', 'webhook');
  return useMutation({
    mutationFn: async (input: { endpointId: string; overlapHours: number; reveal: Reveal<{ secret: string; previousSecretExpiresAt: string }> }): Promise<{ previousSecretExpiresAt: string }> => {
      const { data } = await apiClient.post<unknown>(`${hook(shopId, input.endpointId)}/rotate-secret`, { overlapHours: input.overlapHours });
      const rotated = parseBody(rotatedWebhookSecretSchema, data);
      input.reveal(rotated);
      return { previousSecretExpiresAt: rotated.previousSecretExpiresAt };
    },
    gcTime: 0,
    onSettled: invalidate,
  });
}

export function useExpirePreviousSecret(shopId: string) {
  const invalidate = useInvalidate(shopId, 'webhooks', 'webhook');
  return useMutation({
    mutationFn: async (endpointId: string) => parseBody(webhookEndpointSchema, (await apiClient.post<unknown>(`${hook(shopId, endpointId)}/expire-previous-secret`)).data),
    onSettled: invalidate,
  });
}

/** Removes the row from the cached pages after the delete succeeded, then refetches (the one allowed hand patch, FR-003). */
export function useDeleteWebhook(shopId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (endpointId: string): Promise<string> => {
      await apiClient.delete(hook(shopId, endpointId));
      return endpointId;
    },
    onSuccess: (endpointId) => {
      queryClient.setQueriesData<ReturnType<typeof webhookEndpointPageSchema.parse>>({ queryKey: queryKeys.seller.scope(shopId, 'webhooks') }, (page) =>
        page ? { ...page, items: page.items.filter((item) => item.id !== endpointId) } : page,
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'webhooks') }),
  });
}

export function usePingWebhook(shopId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (endpointId: string) => parseBody(webhookDeliveryAcceptedSchema, (await apiClient.post<unknown>(`${hook(shopId, endpointId)}/ping`)).data),
    onSettled: (_data, _error, endpointId) => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'webhook-attempts'), refetchType: 'active', predicate: (query) => query.queryKey[3] === endpointId }),
  });
}

// ---------------------------------------------------------------- deliveries

/** `refetchWindow`: refetch every `PING_REFETCH_MS` while true (the page sets it for `PING_REFETCH_TOTAL_MS` after a ping). */
export function useWebhookAttempts(shopId: string, endpointId: string, params: WebhookAttemptsParams, options: { refetchWindow?: boolean; initialData?: ReturnType<typeof webhookAttemptPageSchema.parse> } = {}) {
  return useQuery({
    queryKey: queryKeys.seller.webhookAttempts(shopId, endpointId, { ok: params.ok, cursor: params.cursor }),
    queryFn: async () =>
      parseBody(
        webhookAttemptPageSchema,
        (
          await apiClient.get<unknown>(`${hook(shopId, endpointId)}/attempts`, { params: attemptsQuery(params) })
        ).data,
      ),
    initialData: options.initialData,
    placeholderData: keepPreviousData,
    refetchInterval: options.refetchWindow ? PING_REFETCH_MS : false,
    retry,
  });
}

export function useWebhookEvent(shopId: string, endpointId: string, eventId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.seller.webhookEvent(shopId, endpointId, eventId ?? ''),
    queryFn: async () => parseBody(webhookEventDetailSchema, (await apiClient.get<unknown>(`${hook(shopId, endpointId)}/events/${encodeURIComponent(eventId as string)}`)).data),
    enabled: Boolean(eventId),
    retry,
  });
}

/** `Idempotency-Key` is created by the caller when the event panel opens and reused for retries of the same intent. */
export function useReplayEvent(shopId: string, endpointId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { eventId: string; idempotencyKey: string }) =>
      parseBody(
        webhookDeliveryAcceptedSchema,
        (await apiClient.post<unknown>(`${hook(shopId, endpointId)}/events/${encodeURIComponent(input.eventId)}/replay`, undefined, { headers: { 'Idempotency-Key': input.idempotencyKey } })).data,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'webhook-attempts') }),
  });
}
