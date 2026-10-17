import type { ReactNode } from 'react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { origin, overviewFixture, OTHER_SHOP_ID, sellerProblem, SELLER_SHOP_ID, shopFixture, shopListItemFixture } from '@/lib/test/seller-handlers';
import { useMyShops, useOpenShop, useOverview, useShop } from './seller';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, Wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe('W04 lib/api/seller.ts', () => {
  it('W04 AS-92: useShop reads the shop through a relative URL with no Authorization header and parses it', async () => {
    let auth: string | null = 'unset';
    server.use(
      http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json(shopFixture({ myRole: 'VIEWER', myPermissions: ['shop.read'] }));
      }),
    );
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useShop(SELLER_SHOP_ID), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.myRole).toBe('VIEWER'));
    expect(auth).toBeNull();
    expect(client.getQueryData(queryKeys.seller.shop(SELLER_SHOP_ID))).toBeDefined();
  });

  it('W04 AS-92: a body that is not a shop is a failed call (invalid_response), never half-parsed data', async () => {
    server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json({ id: SELLER_SHOP_ID, secretField: 1 })));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useShop(SELLER_SHOP_ID), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as { response: { data: { code: string } } }).response.data.code).toBe('invalid_response');
    expect(result.current.data).toBeUndefined();
  });

  it('W04 AS-09: useMyShops asks for 50 shops and parses the page', async () => {
    let seen: URL | undefined;
    server.use(
      http.get(`${origin}/api/shops/mine`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ items: [shopListItemFixture(), shopListItemFixture({ id: OTHER_SHOP_ID, name: 'Other', slug: 'other', role: 'STAFF', status: 'SUSPENDED' })], nextCursor: 'next' });
      }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useMyShops(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
    expect(seen?.searchParams.get('limit')).toBe('50');
    expect(result.current.data?.nextCursor).toBe('next');
    expect(result.current.data?.items[1]?.status).toBe('SUSPENDED');
  });

  it('W04 AS-12: useOverview reads the composed answer for the period from the BFF aggregate', async () => {
    let seen: URL | undefined;
    server.use(
      http.get(`${origin}/api/bff/seller/${SELLER_SHOP_ID}/overview`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json(overviewFixture({ stats: null, errors: [{ section: 'stats', code: 'upstream_unavailable', retryable: true }] }));
      }),
    );
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useOverview(SELLER_SHOP_ID, 90), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(seen?.searchParams.get('days')).toBe('90');
    expect(result.current.data?.errors[0]?.section).toBe('stats');
    expect(client.getQueryData(queryKeys.seller.overview(SELLER_SHOP_ID, { days: 90 }))).toBeDefined();
  });

  it('W04 AS-17: a problem+json answer reaches the caller as an error with its code', async () => {
    server.use(http.get(`${origin}/api/bff/seller/${SELLER_SHOP_ID}/overview`, () => sellerProblem('shop_not_found')));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useOverview(SELLER_SHOP_ID, 30), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as { response: { status: number } }).response.status).toBe(404);
  });

  it('W04 AS-93: opening a shop posts {name, slug} with the CSRF header and refetches the shop list', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    let body: unknown;
    let csrf: string | null = null;
    server.use(
      http.post(`${origin}/api/shops`, async ({ request }) => {
        body = await request.json();
        csrf = request.headers.get('x-csrf-token');
        return HttpResponse.json(shopFixture(), { status: 201 });
      }),
    );
    const { Wrapper, client } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useOpenShop(), { wrapper: Wrapper });
    const shop = await result.current.mutateAsync({ name: 'Clay Works', slug: 'clay-works' });
    expect(shop.id).toBe(SELLER_SHOP_ID);
    expect(body).toEqual({ name: 'Clay Works', slug: 'clay-works' });
    expect(csrf).toBe('tok');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.seller.shops() });
  });
});
