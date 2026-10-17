'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pageSchema, shopInviteSchema, shopMemberSchema, shopRolesSchema } from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';
import { listQuery, TEAM_PAGE_SIZE } from '@/lib/seller/wire';
import { apiClient } from './client';
import { retryUnlessClientError } from './orders';
import { parseBody } from './parse';

/** Members and invitations are keyset pages `{items, nextCursor}` (S03). */
const membersSchema = pageSchema(shopMemberSchema);
const invitesSchema = pageSchema(shopInviteSchema);
export type MemberPage = ReturnType<typeof membersSchema.parse>;
export type InvitePage = ReturnType<typeof invitesSchema.parse>;
export type ShopMember = MemberPage['items'][number];
export type ShopInvite = InvitePage['items'][number];
export type InviteRole = ShopInvite['role'];
export type MemberRole = ShopMember['role'];

const shopBase = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}`;

export function useMembers(shopId: string, params: { cursor?: string } = {}, initialData?: MemberPage) {
  return useQuery({
    queryKey: queryKeys.seller.team.members(shopId, params),
    queryFn: async () => parseBody(membersSchema, (await apiClient.get<unknown>(`${shopBase(shopId)}/members`, { params: listQuery(TEAM_PAGE_SIZE, params) })).data),
    initialData,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

/** Offered only where S03 FR-021 allows it; the API still decides (`403 insufficient_role`, `409 last_owner`). */
export function useChangeRole(shopId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; role: MemberRole }): Promise<void> => {
      await apiClient.patch(`${shopBase(shopId)}/members/${encodeURIComponent(input.userId)}`, { role: input.role });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'team') }),
  });
}

/** Removing another member, or leaving (the actor's own id). The shop list refetches too after a leave. */
export function useRemoveMember(shopId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string): Promise<void> => {
      await apiClient.delete(`${shopBase(shopId)}/members/${encodeURIComponent(userId)}`);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'team') }),
        queryClient.invalidateQueries({ queryKey: queryKeys.seller.shops() }),
      ]),
  });
}

export function useInvites(shopId: string, params: { status?: string; cursor?: string } = {}, initialData?: InvitePage) {
  return useQuery({
    queryKey: queryKeys.seller.team.invites(shopId, params),
    queryFn: async () =>
      parseBody(
        invitesSchema,
        (await apiClient.get<unknown>(`${shopBase(shopId)}/invites`, { params: listQuery(TEAM_PAGE_SIZE, params) })).data,
      ),
    initialData,
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
  });
}

/** The answer never carries the invite link or token (S03): the seller cannot see it. */
export function useInvite(shopId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; role: InviteRole }) => parseBody(shopInviteSchema, (await apiClient.post<unknown>(`${shopBase(shopId)}/invites`, input)).data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.team.invites(shopId, {}).slice(0, 4) }),
  });
}

export function useResendInvite(shopId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => parseBody(shopInviteSchema, (await apiClient.post<unknown>(`${shopBase(shopId)}/invites/${encodeURIComponent(inviteId)}/resend`)).data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.team.invites(shopId, {}).slice(0, 4) }),
  });
}

export function useRevokeInvite(shopId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string): Promise<void> => {
      await apiClient.delete(`${shopBase(shopId)}/invites/${encodeURIComponent(inviteId)}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.seller.team.invites(shopId, {}).slice(0, 4) }),
  });
}

/** The permission matrix by role (`GET /shop-roles`); open to every member and the same for every shop. */
export function useRoles() {
  return useQuery({
    queryKey: queryKeys.seller.team.roles(),
    queryFn: async () => parseBody(shopRolesSchema, (await apiClient.get<unknown>('/api/shop-roles')).data),
    staleTime: 10 * 60_000,
    retry: retryUnlessClientError,
  });
}
