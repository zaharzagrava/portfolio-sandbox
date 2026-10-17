import type { ReactNode } from 'react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../vitest.setup';
import { origin, SELLER_PRODUCT_ID, SELLER_SHOP_ID } from '@/lib/test/seller-handlers';
import { readInventoryParams } from '@/lib/seller/search-params';
import { useAdjustStock, useArchiveProduct, useCreateProduct, useInventory, useProduct, useRestoreProduct, useUpdateProduct } from './seller-products';

const member = (over: Record<string, unknown> = {}) => ({
  id: SELLER_PRODUCT_ID,
  shopId: SELLER_SHOP_ID,
  title: 'Handmade Ceramic Mug',
  description: '',
  brand: 'Clay',
  category: 'kitchen',
  priceMinor: 2450,
  currency: 'EUR',
  rating: 0,
  tags: [],
  inStock: true,
  version: 3,
  viewCount: 0,
  quantity: 12,
  status: 'ACTIVE',
  externalSku: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
  ...over,
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, Wrapper };
}

const products = `${origin}/api/shops/${SELLER_SHOP_ID}/products`;
afterEach(() => vi.restoreAllMocks());

describe('W04 lib/api/seller-products.ts', () => {
  it('W04 AS-28: the browse list sends status, limit and cursor, and keeps the version of each row', async () => {
    let seen: URL | undefined;
    server.use(http.get(products, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json({ items: [member()], nextCursor: 'c2' }))));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useInventory(SELLER_SHOP_ID, readInventoryParams({ status: 'ARCHIVED', inStock: 'false', cursor: 'c1' })), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    expect(Object.fromEntries(seen!.searchParams)).toEqual({ status: 'ARCHIVED', inStock: 'false', limit: '20', cursor: 'c1' });
    expect(result.current.data).toMatchObject({ source: 'browse', nextCursor: 'c2', items: [{ id: SELLER_PRODUCT_ID, version: 3, quantity: 12 }] });
  });

  it('W04 AS-30: a search text uses the shop search, which carries no version and no status filter', async () => {
    let seen: URL | undefined;
    server.use(
      http.get(`${products}/search`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ items: [{ id: SELLER_PRODUCT_ID, title: 'Handmade Ceramic Mug', priceMinor: 2450, currency: 'EUR', quantity: 12, status: 'ARCHIVED', rank: 0.9 }], nextCursor: null });
      }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useInventory(SELLER_SHOP_ID, readInventoryParams({ q: ' ceramc mug ', status: 'ARCHIVED' })), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.source).toBe('search'));
    expect(Object.fromEntries(seen!.searchParams)).toEqual({ q: 'ceramc mug', limit: '20' });
    expect(result.current.data?.items[0]).toEqual({ id: SELLER_PRODUCT_ID, title: 'Handmade Ceramic Mug', priceMinor: 2450, currency: 'EUR', quantity: 12, status: 'ARCHIVED' });
  });

  it('W04 AS-31: the previous rows stay while the next filter loads', async () => {
    server.use(
      http.get(products, async ({ request }) => {
        if (new URL(request.url).searchParams.get('status') === 'ARCHIVED') await new Promise((resolve) => setTimeout(resolve, 80));
        return HttpResponse.json({ items: [member()], nextCursor: null });
      }),
    );
    const { Wrapper } = wrapper();
    const { result, rerender } = renderHook(({ status }) => useInventory(SELLER_SHOP_ID, readInventoryParams({ status })), { wrapper: Wrapper, initialProps: { status: 'ACTIVE' } });
    await waitFor(() => expect(result.current.data).toBeDefined());
    rerender({ status: 'ARCHIVED' });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.items).toHaveLength(1);
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
  });

  it('W04 AS-36: useProduct reads the member view with its version', async () => {
    server.use(http.get(`${products}/${SELLER_PRODUCT_ID}`, () => HttpResponse.json(member({ version: 7 }))));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useProduct(SELLER_SHOP_ID, SELLER_PRODUCT_ID), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data?.version).toBe(7));
  });

  it('W04 AS-33: create posts priceMinor and currency and refetches the inventory section', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    let body: unknown;
    let csrf: string | null = null;
    server.use(http.post(products, async ({ request }) => ((body = await request.json()), (csrf = request.headers.get('x-csrf-token')), HttpResponse.json(member(), { status: 201 }))));
    const { Wrapper, client } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateProduct(SELLER_SHOP_ID), { wrapper: Wrapper });
    await result.current.mutateAsync({ title: 'Mug', brand: 'Clay', category: 'kitchen', priceMinor: 2450, currency: 'EUR', quantity: 3 });
    expect(body).toEqual({ title: 'Mug', brand: 'Clay', category: 'kitchen', priceMinor: 2450, currency: 'EUR', quantity: 3 });
    expect(csrf).toBe('tok');
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['seller', SELLER_SHOP_ID, 'inventory'] }));
  });

  it.each([
    ['edit', 'PATCH', '', (r: ReturnType<typeof useUpdateProduct>) => r.mutateAsync({ productId: SELLER_PRODUCT_ID, body: { expectedVersion: 3, title: 'New' } }), { expectedVersion: 3, title: 'New' }],
    ['stock', 'PATCH', '', (r: ReturnType<typeof useAdjustStock>) => r.mutateAsync({ productId: SELLER_PRODUCT_ID, quantity: 0, expectedVersion: 3 }), { expectedVersion: 3, quantity: 0 }],
    ['archive', 'POST', '/archive', (r: ReturnType<typeof useArchiveProduct>) => r.mutateAsync({ productId: SELLER_PRODUCT_ID, expectedVersion: 3 }), { expectedVersion: 3 }],
    ['restore', 'POST', '/restore', (r: ReturnType<typeof useRestoreProduct>) => r.mutateAsync({ productId: SELLER_PRODUCT_ID, expectedVersion: 3 }), { expectedVersion: 3 }],
  ] as const)('W04 AS-36: %s sends only its fields with expectedVersion', async (name, method, suffix, run, expected) => {
    let body: unknown;
    server.use(http.all(`${products}/${SELLER_PRODUCT_ID}${suffix}`, async ({ request }) => {
      if (request.method !== method) return new HttpResponse(null, { status: 405 });
      body = await request.json();
      return HttpResponse.json(member());
    }));
    const { Wrapper } = wrapper();
    const { result } = renderHook(
      () => ({ update: useUpdateProduct(SELLER_SHOP_ID), stock: useAdjustStock(SELLER_SHOP_ID), archive: useArchiveProduct(SELLER_SHOP_ID), restore: useRestoreProduct(SELLER_SHOP_ID) }),
      { wrapper: Wrapper },
    );
    const hook = { edit: result.current.update, stock: result.current.stock, archive: result.current.archive, restore: result.current.restore }[name];
    await (run as (r: unknown) => Promise<unknown>)(hook);
    expect(body).toEqual(expected);
  });

  it('W04 AS-41: a refused write still refetches the list (it is out of date)', async () => {
    server.use(http.post(`${products}/${SELLER_PRODUCT_ID}/archive`, () => HttpResponse.json({ code: 'invalid_transition', status: 409 }, { status: 409 })));
    const { Wrapper, client } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useArchiveProduct(SELLER_SHOP_ID), { wrapper: Wrapper });
    await expect(result.current.mutateAsync({ productId: SELLER_PRODUCT_ID, expectedVersion: 3 })).rejects.toMatchObject({ response: { status: 409 } });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });
});
