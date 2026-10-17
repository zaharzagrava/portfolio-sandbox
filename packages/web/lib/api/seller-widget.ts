'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  widgetSiteCreatedSchema,
  widgetSitePageSchema,
  widgetSiteSchema,
  widgetSecretRotatedSchema,
  type CreateWidgetSiteRequest,
  type UpdateWidgetSiteRequest,
  type WidgetSiteDto,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

/** S44 widget sites of a shop (`specs/domains/S44-storefront-widget/contracts/http-dashboard.md`); every route needs `widget.manage`. */
export const WIDGET_PAGE_SIZE = 20;

const base = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}/widget/sites`;
const site = (shopId: string, siteId: string) => `${base(shopId)}/${encodeURIComponent(siteId)}`;

export type WidgetSite = WidgetSiteDto;
export type WidgetSitePage = ReturnType<typeof widgetSitePageSchema.parse>;

/** An identity secret is handed to the caller once, through `reveal`, and never stays in a cache (`gcTime: 0`). */
export type RevealSecret = (secret: { identitySecret: string; previousSecretExpiresAt?: string | null }) => void;

export function useWidgetSites(shopId: string, params: { cursor?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.seller.widgetSites(shopId, params),
    queryFn: async () =>
      parseBody(widgetSitePageSchema, (await apiClient.get<unknown>(base(shopId), { params: { limit: WIDGET_PAGE_SIZE, ...(params.cursor ? { cursor: params.cursor } : {}) } })).data),
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

function useInvalidateSites(shopId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'widget') });
}

export function useCreateWidgetSite(shopId: string) {
  const invalidate = useInvalidateSites(shopId);
  return useMutation({
    mutationFn: async (input: { body: CreateWidgetSiteRequest; reveal: RevealSecret }): Promise<WidgetSite> => {
      const { identitySecret, ...record } = parseBody(widgetSiteCreatedSchema, (await apiClient.post<unknown>(base(shopId), input.body)).data);
      input.reveal({ identitySecret });
      return record;
    },
    gcTime: 0,
    onSettled: invalidate,
  });
}

/** `expectedVersion` is the version the form was loaded with; a stale one answers `409 site_version_conflict`. */
export function useUpdateWidgetSite(shopId: string) {
  const invalidate = useInvalidateSites(shopId);
  return useMutation({
    mutationFn: async (input: { siteId: string; body: UpdateWidgetSiteRequest }) => parseBody(widgetSiteSchema, (await apiClient.patch<unknown>(site(shopId, input.siteId), input.body)).data),
    onSettled: invalidate,
  });
}

/** `on: true` switches the widget off on every page that embeds it (idempotent; a real change bumps `version`). */
export function useSetKillSwitch(shopId: string) {
  const invalidate = useInvalidateSites(shopId);
  return useMutation({
    mutationFn: async (input: { siteId: string; on: boolean }) => parseBody(widgetSiteSchema, (await apiClient.put<unknown>(`${site(shopId, input.siteId)}/kill-switch`, { on: input.on })).data),
    onSettled: invalidate,
  });
}

export function useRotateWidgetSecret(shopId: string) {
  const invalidate = useInvalidateSites(shopId);
  return useMutation({
    mutationFn: async (input: { siteId: string; overlapHours: number; reveal: RevealSecret }): Promise<{ previousSecretExpiresAt: string | null }> => {
      const rotated = parseBody(widgetSecretRotatedSchema, (await apiClient.post<unknown>(`${site(shopId, input.siteId)}/rotate-secret`, { overlapHours: input.overlapHours })).data);
      input.reveal(rotated);
      return { previousSecretExpiresAt: rotated.previousSecretExpiresAt };
    },
    gcTime: 0,
    onSettled: invalidate,
  });
}

export function useExpirePreviousWidgetSecret(shopId: string) {
  const invalidate = useInvalidateSites(shopId);
  return useMutation({
    mutationFn: async (siteId: string) => parseBody(widgetSiteSchema, (await apiClient.post<unknown>(`${site(shopId, siteId)}/expire-previous-secret`)).data),
    onSettled: invalidate,
  });
}

export function useDeleteWidgetSite(shopId: string) {
  const invalidate = useInvalidateSites(shopId);
  return useMutation({
    mutationFn: async (siteId: string): Promise<void> => {
      await apiClient.delete(site(shopId, siteId));
    },
    onSettled: invalidate,
  });
}

/** Why the API refused an origin (`422 origin_invalid {details: {origin, reason}}`), or `undefined` for any other error. */
export function originRejectionOf(error: unknown): { origin: string; reason: string } | undefined {
  const details = (error as { response?: { data?: { details?: { origin?: unknown; reason?: unknown } } } } | null)?.response?.data?.details;
  return typeof details?.origin === 'string' && typeof details.reason === 'string' ? { origin: details.origin.slice(0, 200), reason: details.reason } : undefined;
}
