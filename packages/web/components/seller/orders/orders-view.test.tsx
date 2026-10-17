import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { readOrdersParams } from '@/lib/seller/search-params';
import { origin, SELLER_SHOP_ID, sellerProblem, shopFixture } from '@/lib/test/seller-handlers';
import { OrdersView } from './orders-view';

const push = vi.fn();
const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/orders`,
  useSearchParams: () => new URLSearchParams(search),
}));

const PATH = `/dashboard/seller/${SELLER_SHOP_ID}/orders`;
const orders = `${origin}/api/shops/${SELLER_SHOP_ID}/orders`;
const BUYER = 'buyer-7f3a9c2e-secret-id';
const item = (n: number) => ({ productId: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b', shopId: SELLER_SHOP_ID, title: `Mug ${n}`, quantity: 1, unitPriceMinor: 2450, discountMinor: 0, lineTotalMinor: 2450 });
const slice = (over: Record<string, unknown> = {}) => ({
  shopOrderId: 'abcdef12-0000-4000-8000-000000000001',
  orderId: '11111111-0000-4000-8000-000000000001',
  status: 'PAID',
  subtotalMinor: 4900,
  currency: 'EUR',
  buyerId: BUYER,
  createdAt: '2026-10-16T09:30:00.000Z',
  items: [item(1), item(2)],
  ...over,
});

let client: QueryClient;
function show(initial?: Parameters<typeof OrdersView>[0]['initialData']) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shopFixture());
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shopFixture())));
  return render(
    <QueryClientProvider client={client}>
      <OrdersView shopId={SELLER_SHOP_ID} serverParams={readOrdersParams(Object.fromEntries(new URLSearchParams(search)))} initialData={initial} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  search = '';
  vi.clearAllMocks();
});

describe('W04 shop orders', () => {
  it('W04 AS-83: a table lists reference (first 8 characters), status, item count, subtotal and date, and never the buyer id', async () => {
    server.use(http.get(orders, () => HttpResponse.json({ items: [slice()], nextCursor: null })));
    const { container } = show();
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Order', 'Status', 'Items', 'Subtotal', 'Date']));
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('abcdef12');
    expect(row).not.toHaveTextContent('abcdef12-0000');
    expect(row).toHaveTextContent('Paid');
    expect(row).toHaveTextContent('2');
    expect(row).toHaveTextContent('€49.00');
    expect(container.textContent).not.toContain(BUYER);
    expect(container.textContent).not.toContain('11111111');
  });

  it('W04 AS-83: an unknown status shows in title case', () => {
    show({ items: [slice({ status: 'PARTIALLY_SHIPPED' })] as never, nextCursor: null });
    expect(screen.getByText('Partially Shipped')).toBeInTheDocument();
  });

  it('W04 AS-83: the status filter is in the URL and the API call carries it', async () => {
    const seen: string[] = [];
    server.use(http.get(orders, ({ request }) => (seen.push(new URL(request.url).search), HttpResponse.json({ items: [], nextCursor: null }))));
    const user = userEvent.setup();
    show({ items: [slice()] as never, nextCursor: null });
    await user.selectOptions(screen.getByLabelText('Status'), 'REFUNDED');
    expect(push).toHaveBeenCalledWith(`${PATH}?status=REFUNDED`);
    search = 'status=REFUNDED';
    show();
    expect(await screen.findAllByText('No orders match this status.')).not.toHaveLength(0);
    expect(seen.some((query) => query.includes('status=REFUNDED'))).toBe(true);
  });

  it('W04 AS-83: Next page carries the cursor; a later page has First page', async () => {
    search = 'cursor=c1';
    server.use(http.get(orders, ({ request }) => (expect(new URL(request.url).searchParams.get('cursor')).toBe('c1'), HttpResponse.json({ items: [slice()], nextCursor: 'c2' }))));
    show();
    expect(await screen.findByRole('link', { name: 'Next page' })).toHaveAttribute('href', `${PATH}?cursor=c2`);
    expect(screen.getByRole('link', { name: 'First page' })).toHaveAttribute('href', PATH);
  });

  it('W04 AS-83: an empty shop says "No orders yet."', async () => {
    server.use(http.get(orders, () => HttpResponse.json({ items: [], nextCursor: null })));
    show();
    expect(await screen.findByText('No orders yet.')).toBeInTheDocument();
  });

  it('W04 AS-83: a failed read shows the problem copy and Try again, not the server text', async () => {
    server.use(http.get(orders, () => sellerProblem('service_unavailable')));
    show();
    expect(await screen.findByRole('button', { name: 'Try again' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/Server title|Server detail/)).not.toBeInTheDocument();
  });
});
