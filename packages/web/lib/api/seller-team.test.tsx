import type { ReactNode } from 'react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../vitest.setup';
import { origin, SELLER_SHOP_ID } from '@/lib/test/seller-handlers';
import { useChangeRole, useInvite, useInvites, useMembers, useRemoveMember, useResendInvite, useRevokeInvite, useRoles } from './seller-team';
import { useShopOrders } from './seller-orders';

const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const INVITE = '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d';
const shop = `${origin}/api/shops/${SELLER_SHOP_ID}`;

const member = { userId: USER, email: 'owner@example.com', role: 'OWNER', source: 'owner', joinedAt: '2026-10-01T09:00:00.000Z' };
const invite = { id: INVITE, email: 'new@example.com', role: 'STAFF', status: 'pending', invitedBy: USER, expiresAt: '2026-10-24T09:00:00.000Z', createdAt: '2026-10-17T09:00:00.000Z' };

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, Wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe('W04 lib/api/seller-team.ts', () => {
  it('W04 AS-74: members and invitations are {items, nextCursor} pages with limit, status and cursor', async () => {
    const seen: Record<string, URL> = {};
    server.use(
      http.get(`${shop}/members`, ({ request }) => ((seen.members = new URL(request.url)), HttpResponse.json({ items: [member, { ...member, userId: 'b'.repeat(8) + '-0000-4000-8000-000000000000', email: null, role: 'VIEWER', source: 'invite' }], nextCursor: null }))),
      http.get(`${shop}/invites`, ({ request }) => ((seen.invites = new URL(request.url)), HttpResponse.json({ items: [invite], nextCursor: 'n' }))),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => ({ members: useMembers(SELLER_SHOP_ID, { cursor: 'c1' }), invites: useInvites(SELLER_SHOP_ID, { status: 'expired' }) }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.members.data?.items).toHaveLength(2));
    await waitFor(() => expect(result.current.invites.data?.nextCursor).toBe('n'));
    expect(Object.fromEntries(seen.members.searchParams)).toEqual({ limit: '50', cursor: 'c1' });
    expect(Object.fromEntries(seen.invites.searchParams)).toEqual({ limit: '50', status: 'expired' });
    expect(result.current.members.data?.items[1]?.email).toBeNull();
  });

  it('W04 AS-79: the roles matrix parses', async () => {
    server.use(http.get(`${origin}/api/shop-roles`, () => HttpResponse.json({ roles: { OWNER: ['shop.read'], ADMIN: ['shop.read'], STAFF: ['shop.read'], VIEWER: ['shop.read'] }, permissions: ['shop.read'] })));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useRoles(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.permissions).toEqual(['shop.read']));
  });

  it('W04 AS-75: a role change is a PATCH {role}; removing or leaving is a DELETE; both refetch the team', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    const calls: string[] = [];
    server.use(
      http.patch(`${shop}/members/${USER}`, async ({ request }) => (calls.push(`PATCH ${JSON.stringify(await request.json())} ${request.headers.get('x-csrf-token')}`), new HttpResponse(null, { status: 204 }))),
      http.delete(`${shop}/members/${USER}`, () => (calls.push('DELETE'), new HttpResponse(null, { status: 204 }))),
    );
    const { Wrapper, client } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => ({ role: useChangeRole(SELLER_SHOP_ID), remove: useRemoveMember(SELLER_SHOP_ID) }), { wrapper: Wrapper });
    await act(() => result.current.role.mutateAsync({ userId: USER, role: 'ADMIN' }));
    await act(() => result.current.remove.mutateAsync(USER));
    expect(calls).toEqual(['PATCH {"role":"ADMIN"} tok', 'DELETE']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['seller', SELLER_SHOP_ID, 'team'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['seller', 'shops'] });
  });

  it('W04 AS-77: inviting posts {email, role}; the answer never carries a link; resend and revoke use the invite id', async () => {
    const calls: string[] = [];
    server.use(
      http.post(`${shop}/invites`, async ({ request }) => (calls.push(`POST ${JSON.stringify(await request.json())}`), HttpResponse.json(invite, { status: 201 }))),
      http.post(`${shop}/invites/${INVITE}/resend`, () => (calls.push('RESEND'), HttpResponse.json(invite))),
      http.delete(`${shop}/invites/${INVITE}`, () => (calls.push('REVOKE'), new HttpResponse(null, { status: 204 }))),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => ({ invite: useInvite(SELLER_SHOP_ID), resend: useResendInvite(SELLER_SHOP_ID), revoke: useRevokeInvite(SELLER_SHOP_ID) }), { wrapper: Wrapper });
    const created = await act(() => result.current.invite.mutateAsync({ email: 'new@example.com', role: 'STAFF' }));
    await act(() => result.current.resend.mutateAsync(INVITE));
    await act(() => result.current.revoke.mutateAsync(INVITE));
    expect(calls).toEqual(['POST {"email":"new@example.com","role":"STAFF"}', 'RESEND', 'REVOKE']);
    expect(Object.keys(created).sort()).toEqual(['createdAt', 'email', 'expiresAt', 'id', 'invitedBy', 'role', 'status']);
  });

  it('W04 AS-77: an answer with an extra field (a token or link) is refused by the strict contract', async () => {
    server.use(http.post(`${shop}/invites`, () => HttpResponse.json({ ...invite, link: 'https://x/invites/secret' }, { status: 201 })));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useInvite(SELLER_SHOP_ID), { wrapper: Wrapper });
    await expect(result.current.mutateAsync({ email: 'new@example.com', role: 'STAFF' })).rejects.toMatchObject({ response: { data: { code: 'invalid_response' } } });
  });
});

describe('W04 lib/api/seller-orders.ts', () => {
  it('W04 AS-83: the shop orders send status, limit and cursor and parse the slices', async () => {
    let seen: URL | undefined;
    server.use(
      http.get(`${shop}/orders`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({
          items: [{ shopOrderId: INVITE, orderId: USER, status: 'PAID', subtotalMinor: 2500, currency: 'EUR', createdAt: '2026-10-17T09:00:00.000Z', items: [] }],
          nextCursor: null,
        });
      }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useShopOrders(SELLER_SHOP_ID, { status: 'PAID', cursor: 'c1' }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    expect(Object.fromEntries(seen!.searchParams)).toEqual({ limit: '20', status: 'PAID', cursor: 'c1' });
    expect(result.current.data?.items[0]?.status).toBe('PAID');
  });
});
