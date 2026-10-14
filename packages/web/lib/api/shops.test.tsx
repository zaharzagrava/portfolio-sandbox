import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { server } from '../../vitest.setup';
import { useShopProducts } from './shops';

const SHOP = '01a13b75-40a8-74fd-b054-0d0d8c3c76d9';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return Wrapper;
}

const item = (id: string, title: string) => ({ id, title, priceMinor: 1999, currency: 'USD', quantity: 3, status: 'ACTIVE', rank: 1 });

describe('W07 inventory search uses the shop search route (S32 follow-up)', () => {
  it('W07 S32 follow-up: a search text is sent to the shop-scoped search route, not filtered in the browser', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`*/api/shops/${SHOP}/products/search`, ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json({ items: [item('p1', 'Espresso Machine')], nextCursor: null });
      }),
      http.get(`*/api/shops/${SHOP}/products`, () => HttpResponse.json({ items: [] })),
    );
    const { result } = renderHook(() => useShopProducts(SHOP, 'espreso'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(seen).toEqual(['?q=espreso&limit=50']);
    expect(result.current.data).toEqual([{ id: 'p1', title: 'Espresso Machine', price: 1999, quantity: 3 }]);
  });

  it('W07 S32 follow-up: without a search text the shop list is read', async () => {
    let searched = false;
    server.use(
      http.get(`*/api/shops/${SHOP}/products/search`, () => {
        searched = true;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
      http.get(`*/api/shops/${SHOP}/products`, () => HttpResponse.json({ items: [{ id: 'p2', title: 'Lantern', priceMinor: 500, quantity: 1 }] })),
    );
    const { result } = renderHook(() => useShopProducts(SHOP, '   '), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(searched).toBe(false);
    expect(result.current.data).toEqual([{ id: 'p2', title: 'Lantern', price: 500, quantity: 1 }]);
  });

  it('W07 S32 follow-up: a search text is trimmed and cut to the 100 characters the route accepts', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`*/api/shops/${SHOP}/products/search`, ({ request }) => {
        seen.push(new URL(request.url).searchParams.get('q') ?? '');
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    const { result } = renderHook(() => useShopProducts(SHOP, `  ${'x'.repeat(150)}  `), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(seen).toEqual(['x'.repeat(100)]);
  });
});
