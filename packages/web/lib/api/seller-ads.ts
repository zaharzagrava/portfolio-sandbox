'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adBillingPageSchema,
  adCampaignDetailSchema,
  adCampaignPageSchema,
  adCampaignSchema,
  type AdAction,
  type CreateAdCampaignRequest,
} from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { listQuery } from '@/lib/seller/wire';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

/** S36 campaigns of a shop (`specs/domains/S36-sponsored-listings/contracts/ads-api.md`). Writes carry no Idempotency-Key. */
export const CAMPAIGNS_PAGE_SIZE = 20;
export const BILLING_PAGE_SIZE = 24;

const base = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}/ads/campaigns`;
const one = (shopId: string, campaignId: string) => `${base(shopId)}/${encodeURIComponent(campaignId)}`;

export type CampaignParams = { status?: string; cursor?: string };

export function useCampaigns(shopId: string, params: CampaignParams) {
  return useQuery({
    queryKey: queryKeys.seller.adCampaigns(shopId, params),
    queryFn: async () =>
      parseBody(adCampaignPageSchema, (await apiClient.get<unknown>(base(shopId), { params: listQuery(CAMPAIGNS_PAGE_SIZE, params) })).data),
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

function useCampaignMutation<TInput, TOutput>(shopId: string, mutationFn: (input: TInput) => Promise<TOutput>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    // A refusal such as `invalid_transition` also means the list is out of date.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'ads') }),
  });
}

export function useCreateCampaign(shopId: string) {
  return useCampaignMutation(shopId, async (body: CreateAdCampaignRequest) => parseBody(adCampaignSchema, (await apiClient.post<unknown>(base(shopId), body)).data));
}

export function useCampaignAction(shopId: string) {
  return useCampaignMutation(shopId, async (input: { campaignId: string; action: AdAction }) =>
    parseBody(adCampaignSchema, (await apiClient.post<unknown>(`${one(shopId, input.campaignId)}/${input.action}`)).data),
  );
}

/** One campaign with what was billed today (`payouts.read`). */
export function useCampaignDetail(shopId: string, campaignId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.seller.adCampaignDetail(shopId, campaignId ?? ''),
    queryFn: async () => parseBody(adCampaignDetailSchema, (await apiClient.get<unknown>(one(shopId, campaignId as string))).data),
    enabled: Boolean(campaignId),
    staleTime: 0,
    retry: retryUnlessClientError,
  });
}

/** The hourly statement of a campaign (`payouts.read`); the range defaults to the last 7 days on the server. */
export function useCampaignBilling(shopId: string, campaignId: string | undefined, params: { cursor?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.seller.adBilling(shopId, campaignId ?? '', params),
    queryFn: async () =>
      parseBody(adBillingPageSchema, (await apiClient.get<unknown>(`${one(shopId, campaignId as string)}/billing`, { params: listQuery(BILLING_PAGE_SIZE, params) })).data),
    enabled: Boolean(campaignId),
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}
