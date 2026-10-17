import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { readUsageParams } from '@/lib/seller/search-params';
import { usageFixture } from '@/lib/test/seller-developers-fixtures';
import { origin, SELLER_SHOP_ID, shopFixture } from '@/lib/test/seller-handlers';
import { UsageView } from './usage-view';

const push = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/developers/usage`,
  useSearchParams: () => new URLSearchParams(search),
}));

const PATH = `/dashboard/seller/${SELLER_SHOP_ID}/developers/usage`;
const usage = `${origin}/api/shops/${SELLER_SHOP_ID}/developers/usage`;

let client: QueryClient;
function show() {
  const shop = shopFixture();
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)));
  return render(
    <QueryClientProvider client={client}>
      <UsageView shopId={SELLER_SHOP_ID} serverParams={readUsageParams(Object.fromEntries(new URLSearchParams(search)))} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
});

describe('W04 usage', () => {
  it('W04 AS-73: a table per day, version and route with a totals row, "Deprecated" beside deprecated calls, a UTC label and no chart', async () => {
    let seen: URL | undefined;
    server.use(http.get(usage, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json(usageFixture()))));
    const { container } = show();
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Day', 'Version', 'Route', 'Calls', 'Errors', 'Deprecated calls']);
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('2026-10-16');
    expect(rows[1]).toHaveTextContent('/v1/products');
    expect(rows[1]).not.toHaveTextContent('Deprecated');
    expect(rows[2]).toHaveTextContent('5 Deprecated');
    const totals = rows[rows.length - 1];
    expect(totals).toHaveTextContent('Total');
    expect(totals).toHaveTextContent('15');
    expect(totals).toHaveTextContent('1');
    expect(screen.getByText(/Days are in UTC/)).toBeInTheDocument();
    expect(container.querySelector('svg:not([aria-hidden="true"]), canvas, img, [role="img"]')).toBeNull();
    expect(seen?.searchParams.get('days')).toBe('30');
    expect(seen?.searchParams.get('livemode')).toBe('true');
  });

  it('W04 AS-73: the period and the mode live in the URL, defaults are left out', async () => {
    server.use(http.get(usage, () => HttpResponse.json(usageFixture())));
    const user = userEvent.setup();
    show();
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('Period'), '14');
    expect(push).toHaveBeenLastCalledWith(`${PATH}?days=14`);
    await user.selectOptions(screen.getByLabelText('Mode'), 'false');
    expect(push).toHaveBeenLastCalledWith(`${PATH}?livemode=false`);
    expect(within(screen.getByLabelText('Period')).getAllByRole('option').map((option) => option.textContent)).toEqual(['Last 7 days', 'Last 14 days', 'Last 30 days']);
  });

  it('W04 AS-73: the URL fills the controls and is sent to the API', async () => {
    search = 'days=7&livemode=false';
    let seen: URL | undefined;
    server.use(http.get(usage, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json(usageFixture()))));
    show();
    await screen.findByRole('table');
    expect(screen.getByLabelText('Period')).toHaveValue('7');
    expect(screen.getByLabelText('Mode')).toHaveValue('false');
    expect(seen?.searchParams.get('days')).toBe('7');
    expect(seen?.searchParams.get('livemode')).toBe('false');
  });

  it('W04 AS-73: with no calls the empty text shows instead of the table', async () => {
    server.use(http.get(usage, () => HttpResponse.json(usageFixture({ days: [] }))));
    show();
    expect(await screen.findByText('No API calls in this period.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
